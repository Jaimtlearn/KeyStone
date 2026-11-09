//! Interactive shell sessions with automatic reconnection, plus one-shot exec.

use super::{connect_chain, Connection, HopProvider, Interaction};
use crate::error::{Error, Result};
use russh::ChannelMsg;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Connecting,
    Connected,
    Reconnecting,
    Closed,
    Error,
}

#[derive(Debug, Clone)]
pub enum SessionEvent {
    Data(Vec<u8>),
    Status(SessionStatus, Option<String>),
    Hop { index: usize, total: usize, name: String },
}

pub type EventSink = Arc<dyn Fn(SessionEvent) + Send + Sync>;

#[derive(Debug)]
pub enum SessionCmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

pub struct ShellOptions {
    pub cols: u32,
    pub rows: u32,
    pub auto_reconnect: bool,
    /// Only set when the user explicitly enabled session logging.
    pub log_path: Option<PathBuf>,
    /// Called once per successful connect (e.g. to update last-connected time).
    pub on_connected: Option<Arc<dyn Fn() + Send + Sync>>,
}

enum Ended {
    UserClosed,
    RemoteExited,
    Dropped(String),
}

/// Spawns the session task. Returns the command sender used to write / resize / close.
///
/// Must be called from inside a Tokio runtime (e.g. an `async` Tauri command); it panics otherwise.
pub fn spawn_shell(
    hops: HopProvider,
    ix: Arc<dyn Interaction>,
    opts: ShellOptions,
    sink: EventSink,
) -> mpsc::Sender<SessionCmd> {
    let (tx, mut rx) = mpsc::channel::<SessionCmd>(256);
    tokio::spawn(async move {
        let mut size = (opts.cols, opts.rows);
        let mut log = match &opts.log_path {
            Some(p) => tokio::fs::OpenOptions::new().create(true).append(true).open(p).await.ok(),
            None => None,
        };
        let mut attempt = 0u32;
        loop {
            sink(SessionEvent::Status(
                if attempt == 0 { SessionStatus::Connecting } else { SessionStatus::Reconnecting },
                None,
            ));
            let result = async {
                let hops = hops()?;
                let target = hops.last().map(|h| h.host.clone()).ok_or_else(|| Error::Invalid("empty chain".into()))?;
                let agent_ok = target.agent_forwarding && ix.confirm_agent_forwarding(&target.name).await;
                let s2 = sink.clone();
                let conn = connect_chain(hops, ix.clone(), agent_ok, &move |i, n, name| {
                    s2(SessionEvent::Hop { index: i, total: n, name: name.to_owned() })
                })
                .await?;
                Ok::<_, Error>((conn, target, agent_ok))
            }
            .await;

            let (conn, target, agent_ok) = match result {
                Ok(v) => v,
                Err(e) => {
                    let retryable = matches!(e, Error::Timeout(_) | Error::Io(_) | Error::Ssh(_));
                    if opts.auto_reconnect && attempt > 0 && retryable && attempt < 30 {
                        sink(SessionEvent::Status(SessionStatus::Reconnecting, Some(e.to_string())));
                        attempt += 1;
                        if wait_or_close(&mut rx, backoff(attempt)).await {
                            break;
                        }
                        continue;
                    }
                    sink(SessionEvent::Status(SessionStatus::Error, Some(e.to_string())));
                    break;
                }
            };
            attempt = 1;
            if let Some(cb) = &opts.on_connected {
                cb();
            }
            sink(SessionEvent::Status(SessionStatus::Connected, None));
            let ended = run_shell(&conn, &target, agent_ok, &mut size, &mut rx, &sink, &mut log).await;
            conn.disconnect().await;
            match ended {
                Ended::UserClosed => break,
                Ended::RemoteExited => {
                    sink(SessionEvent::Status(SessionStatus::Closed, Some("session ended".into())));
                    break;
                }
                Ended::Dropped(reason) if opts.auto_reconnect => {
                    sink(SessionEvent::Status(SessionStatus::Reconnecting, Some(reason)));
                    if wait_or_close(&mut rx, backoff(1)).await {
                        break;
                    }
                }
                Ended::Dropped(reason) => {
                    sink(SessionEvent::Status(SessionStatus::Closed, Some(reason)));
                    break;
                }
            }
        }
    });
    tx
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_millis((500u64 << attempt.min(6)).min(30_000))
}

/// Sleeps for `d` while still honouring Close. Returns true if the user closed.
async fn wait_or_close(rx: &mut mpsc::Receiver<SessionCmd>, d: Duration) -> bool {
    let sleep = tokio::time::sleep(d);
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            _ = &mut sleep => return false,
            cmd = rx.recv() => match cmd {
                None | Some(SessionCmd::Close) => return true,
                _ => {} // input while disconnected is dropped
            }
        }
    }
}

async fn run_shell(
    conn: &Connection,
    host: &crate::store::Host,
    agent_ok: bool,
    size: &mut (u32, u32),
    rx: &mut mpsc::Receiver<SessionCmd>,
    sink: &EventSink,
    log: &mut Option<tokio::fs::File>,
) -> Ended {
    let mut ch = match conn.target().channel_open_session().await {
        Ok(c) => c,
        Err(e) => return Ended::Dropped(e.to_string()),
    };
    if agent_ok {
        let _ = ch.agent_forward(false).await;
    }
    for (k, v) in &host.env {
        // Most servers only accept whitelisted vars (AcceptEnv); failures are expected.
        let _ = ch.set_env(false, k.as_str(), v.as_str()).await;
    }
    if let Err(e) = ch.request_pty(false, "xterm-256color", size.0, size.1, 0, 0, &[]).await {
        return Ended::Dropped(e.to_string());
    }
    if let Err(e) = ch.request_shell(false).await {
        return Ended::Dropped(e.to_string());
    }
    for cmd in &host.startup_commands {
        let _ = ch.data_bytes(format!("{cmd}\n").into_bytes()).await;
    }
    let mut ping = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            msg = ch.wait() => match msg {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if let Some(f) = log.as_mut() {
                        let _ = f.write_all(&data).await;
                    }
                    sink(SessionEvent::Data(data.to_vec()));
                }
                Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                    return Ended::RemoteExited;
                }
                Some(_) => {}
                None => return if conn.is_closed() { Ended::Dropped("connection lost".into()) } else { Ended::RemoteExited },
            },
            cmd = rx.recv() => match cmd {
                Some(SessionCmd::Data(d)) => {
                    if ch.data_bytes(d).await.is_err() {
                        return Ended::Dropped("write failed".into());
                    }
                }
                Some(SessionCmd::Resize(c, r)) => {
                    *size = (c, r);
                    let _ = ch.window_change(c, r, 0, 0).await;
                }
                Some(SessionCmd::Close) | None => {
                    let _ = ch.close().await;
                    return Ended::UserClosed;
                }
            },
            _ = ping.tick() => {
                if conn.is_closed() {
                    return Ended::Dropped("connection lost".into());
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
}

/// Runs a single command on an existing connection (used for monitoring probes).
pub async fn exec(conn: &Connection, command: &str, timeout: Duration) -> Result<ExecResult> {
    let fut = async {
        let mut ch = conn.target().channel_open_session().await?;
        ch.exec(true, command).await?;
        let (mut out, mut err, mut code) = (Vec::new(), Vec::new(), None);
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => err.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
            if out.len() > 4 * 1024 * 1024 {
                break;
            }
        }
        Ok::<_, Error>(ExecResult {
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
            exit_code: code,
        })
    };
    tokio::time::timeout(timeout, fut).await.map_err(|_| Error::Timeout(format!("exec on {}", conn.target_name)))?
}
