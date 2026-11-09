//! Port forwarding: local (-L), remote (-R) and dynamic SOCKS5 (-D), each with a
//! supervisor that reconnects with backoff when the SSH connection drops.

use super::{connect_chain, Connection, HopProvider, Interaction, RemoteForward, TrafficStats};
use crate::error::{Error, Result};
use crate::store::{Tunnel, TunnelKind};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelState {
    Stopped,
    Starting,
    Running,
    Reconnecting,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub id: String,
    pub state: TunnelState,
    pub error: Option<String>,
    pub active_connections: u32,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub started_at: Option<DateTime<Utc>>,
}

impl TunnelStatus {
    pub fn stopped(id: &str) -> Self {
        TunnelStatus { id: id.into(), state: TunnelState::Stopped, error: None, active_connections: 0, bytes_in: 0, bytes_out: 0, started_at: None }
    }
}

pub type StatusSink = Arc<dyn Fn(TunnelStatus) + Send + Sync>;

/// Returns true if nothing is listening on addr:port right now.
pub async fn port_available(addr: &str, port: u16) -> bool {
    TcpListener::bind((addr, port)).await.is_ok()
}

/// Handle to a running tunnel; dropping it (or calling `stop`) tears everything down.
pub struct TunnelHandle {
    task: tokio::task::JoinHandle<()>,
}

impl TunnelHandle {
    pub fn stop(self) {
        self.task.abort();
    }
}

impl Drop for TunnelHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Must be called from inside a Tokio runtime (e.g. an `async` Tauri command); it panics otherwise.
pub fn start(tunnel: Tunnel, hops: HopProvider, ix: Arc<dyn Interaction>, sink: StatusSink) -> TunnelHandle {
    let task = tokio::spawn(async move {
        let stats = Arc::new(TrafficStats::default());
        let started = Utc::now();
        let emit = |state: TunnelState, error: Option<String>| {
            sink(TunnelStatus {
                id: tunnel.id.clone(),
                state,
                error,
                active_connections: stats.active.load(Ordering::Relaxed),
                bytes_in: stats.bytes_in.load(Ordering::Relaxed),
                bytes_out: stats.bytes_out.load(Ordering::Relaxed),
                started_at: Some(started),
            })
        };
        emit(TunnelState::Starting, None);

        // Local listeners are bound once and survive reconnects, so clients keep the same port.
        let listener = match tunnel.kind {
            TunnelKind::Local | TunnelKind::Dynamic => {
                match TcpListener::bind((tunnel.bind_address.as_str(), tunnel.bind_port)).await {
                    Ok(l) => Some(Arc::new(l)),
                    Err(e) => {
                        let msg = if e.kind() == std::io::ErrorKind::AddrInUse {
                            format!("port {}:{} is already in use", tunnel.bind_address, tunnel.bind_port)
                        } else {
                            format!("cannot listen on {}:{}: {e}", tunnel.bind_address, tunnel.bind_port)
                        };
                        emit(TunnelState::Error, Some(msg));
                        return;
                    }
                }
            }
            TunnelKind::Remote => None,
        };

        let mut attempt = 0u32;
        loop {
            let conn = async {
                let h = hops()?;
                connect_chain(h, ix.clone(), false, &|_, _, _| {}).await
            }
            .await;
            let conn = match conn {
                Ok(c) => Arc::new(c),
                Err(e) => {
                    if !tunnel.auto_reconnect || matches!(e, Error::AuthFailed(_) | Error::HostKeyRejected(_) | Error::VaultLocked | Error::Invalid(_)) {
                        emit(TunnelState::Error, Some(e.to_string()));
                        return;
                    }
                    attempt += 1;
                    emit(TunnelState::Reconnecting, Some(e.to_string()));
                    tokio::time::sleep(Duration::from_millis((1000u64 << attempt.min(5)).min(30_000))).await;
                    continue;
                }
            };
            attempt = 0;

            let served = match tunnel.kind {
                TunnelKind::Local | TunnelKind::Dynamic => {
                    emit(TunnelState::Running, None);
                    serve_listener(&tunnel, listener.clone().unwrap(), conn.clone(), stats.clone(), &emit).await
                }
                TunnelKind::Remote => serve_remote(&tunnel, conn.clone(), stats.clone(), &emit).await,
            };
            conn.disconnect().await;
            match served {
                Err(e) if matches!(e, Error::Invalid(_)) => {
                    emit(TunnelState::Error, Some(e.to_string()));
                    return;
                }
                Err(e) if !tunnel.auto_reconnect => {
                    emit(TunnelState::Error, Some(e.to_string()));
                    return;
                }
                Ok(()) if !tunnel.auto_reconnect => {
                    emit(TunnelState::Error, Some("connection lost".into()));
                    return;
                }
                other => {
                    emit(TunnelState::Reconnecting, other.err().map(|e| e.to_string()).or(Some("connection lost".into())));
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    });
    TunnelHandle { task }
}

/// Accept loop for -L / -D. Returns when the SSH connection dies.
async fn serve_listener(
    t: &Tunnel,
    listener: Arc<TcpListener>,
    conn: Arc<Connection>,
    stats: Arc<TrafficStats>,
    emit: &(dyn Fn(TunnelState, Option<String>) + Send + Sync),
) -> Result<()> {
    let mut conns = JoinSet::new(); // dropped on return => aborts in-flight forwards
    let mut health = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            acc = listener.accept() => {
                let (sock, peer) = acc?;
                let _ = sock.set_nodelay(true);
                let (conn, stats, t) = (conn.clone(), stats.clone(), t.clone());
                conns.spawn(async move {
                    stats.active.fetch_add(1, Ordering::Relaxed);
                    let r = match t.kind {
                        TunnelKind::Local => forward_local(sock, peer, &t, &conn, &stats).await,
                        _ => socks5_serve(sock, peer, &conn, &stats).await,
                    };
                    if let Err(e) = r {
                        tracing::debug!("tunnel {} connection from {peer} ended: {e}", t.name);
                    }
                    stats.active.fetch_sub(1, Ordering::Relaxed);
                });
                emit(TunnelState::Running, None);
            }
            Some(_) = conns.join_next(), if !conns.is_empty() => emit(TunnelState::Running, None),
            _ = health.tick() => {
                if conn.is_closed() {
                    return Ok(());
                }
            }
        }
    }
}

async fn forward_local(mut sock: TcpStream, peer: SocketAddr, t: &Tunnel, conn: &Connection, stats: &TrafficStats) -> Result<()> {
    let ch = conn
        .target()
        .channel_open_direct_tcpip(t.target_host.clone().unwrap_or_default(), t.target_port.unwrap_or(0) as u32, peer.ip().to_string(), peer.port() as u32)
        .await?;
    pipe(&mut sock, ch, stats).await
}

async fn pipe(sock: &mut TcpStream, ch: russh::Channel<russh::client::Msg>, stats: &TrafficStats) -> Result<()> {
    let mut stream = ch.into_stream();
    let (up, down) = tokio::io::copy_bidirectional(sock, &mut stream).await?;
    stats.bytes_out.fetch_add(up, Ordering::Relaxed);
    stats.bytes_in.fetch_add(down, Ordering::Relaxed);
    Ok(())
}

/// Minimal SOCKS5 server (RFC 1928): no-auth, CONNECT, IPv4/IPv6/domain.
/// The listener should be bound to loopback; binding it elsewhere exposes your
/// SSH connection as an open proxy to the network (the UI warns about this).
async fn socks5_serve(mut s: TcpStream, peer: SocketAddr, conn: &Connection, stats: &TrafficStats) -> Result<()> {
    let bad = |m: &str| Error::Invalid(format!("socks5: {m}"));
    let mut head = [0u8; 2];
    s.read_exact(&mut head).await?;
    if head[0] != 5 {
        return Err(bad("unsupported version"));
    }
    let mut methods = vec![0u8; head[1] as usize];
    s.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        s.write_all(&[5, 0xff]).await?;
        return Err(bad("client requires authentication"));
    }
    s.write_all(&[5, 0]).await?;

    let mut req = [0u8; 4];
    s.read_exact(&mut req).await?;
    if req[1] != 1 {
        s.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?; // command not supported
        return Err(bad("only CONNECT is supported"));
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            s.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        4 => {
            let mut a = [0u8; 16];
            s.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        3 => {
            let n = s.read_u8().await? as usize;
            let mut d = vec![0u8; n];
            s.read_exact(&mut d).await?;
            String::from_utf8(d).map_err(|_| bad("bad domain"))?
        }
        _ => return Err(bad("bad address type")),
    };
    let port = s.read_u16().await?;
    match conn.target().channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32).await {
        Ok(ch) => {
            s.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            pipe(&mut s, ch, stats).await
        }
        Err(e) => {
            s.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await?; // connection refused
            Err(e.into())
        }
    }
}

/// -R: ask the server to listen, then wait until the connection dies. Incoming
/// connections are handled by `ClientHandler::server_channel_open_forwarded_tcpip`.
async fn serve_remote(
    t: &Tunnel,
    conn: Arc<Connection>,
    stats: Arc<TrafficStats>,
    emit: &(dyn Fn(TunnelState, Option<String>) + Send + Sync),
) -> Result<()> {
    let bound = conn
        .target()
        .tcpip_forward(t.bind_address.clone(), t.bind_port as u32)
        .await
        .map_err(|e| Error::Invalid(format!("server refused remote forward on {}:{} ({e}); check AllowTcpForwarding/GatewayPorts", t.bind_address, t.bind_port)))?;
    let port = if t.bind_port == 0 { bound } else { t.bind_port as u32 };
    conn.forwards.lock().unwrap().insert(
        port,
        RemoteForward { target_host: t.target_host.clone().unwrap_or_default(), target_port: t.target_port.unwrap_or(0), stats },
    );
    emit(TunnelState::Running, None);
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;
        if conn.is_closed() {
            return Ok(());
        }
        emit(TunnelState::Running, None);
    }
}
