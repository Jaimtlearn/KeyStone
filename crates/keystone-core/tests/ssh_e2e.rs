//! End-to-end tests against in-process russh servers: a bastion and a private
//! target reachable only through it. Exercises jump chains, auth, host-key trust,
//! exec, interactive shells, and -L / -D tunnels.

use async_trait::async_trait;
use keystone_core::ssh::session::{spawn_shell, SessionCmd, SessionEvent, ShellOptions};
use keystone_core::ssh::tunnel::{self, TunnelState};
use keystone_core::ssh::{self, connect_chain, Hop, HopAuth, HopProvider, HostKeyPrompt, HostKeyStatus, Interaction};
use keystone_core::store::{AuthMethod, Host, Tunnel, TunnelKind};
use keystone_core::Error;
use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

// ───────────── test server ─────────────

#[derive(Clone, Default)]
struct TestServer {
    /// Only interactive session channels echo; tunnelled channels are piped.
    sessions: std::collections::HashSet<ChannelId>,
}

impl server::Handler for TestServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if user == "u" && password == "pw" { Auth::Accept } else { Auth::reject() })
    }

    async fn channel_open_session(&mut self, c: Channel<Msg>, reply: server::ChannelOpenHandle, _s: &mut Session) -> Result<(), Self::Error> {
        self.sessions.insert(c.id());
        reply.accept().await;
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _oa: &str,
        _op: u32,
        reply: server::ChannelOpenHandle,
        _s: &mut Session,
    ) -> Result<(), Self::Error> {
        match TcpStream::connect((host, port as u16)).await {
            Ok(mut tcp) => {
                reply.accept().await;
                tokio::spawn(async move {
                    let mut ch = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut ch, &mut tcp).await;
                });
            }
            Err(_) => reply.reject(russh::ChannelOpenFailure::ConnectFailed).await,
        }
        Ok(())
    }

    async fn exec_request(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        let cmd = String::from_utf8_lossy(data).to_string();
        let out = cmd.strip_prefix("echo ").unwrap_or("?").to_string() + "\n";
        session.data(channel, out.into_bytes())?;
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }

    async fn pty_request(&mut self, channel: ChannelId, _t: &str, _c: u32, _r: u32, _pw: u32, _ph: u32, _m: &[(russh::Pty, u32)], session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, b"welcome$ ".to_vec())?;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        if self.sessions.contains(&channel) {
            session.data(channel, data.to_vec())?; // echo
        }
        Ok(())
    }
}

async fn start_server() -> (u16, String) {
    let key = russh::keys::PrivateKey::random(&mut russh::keys::key::safe_rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let fp = key.public_key().fingerprint(russh::keys::HashAlg::Sha256).to_string();
    let config = Arc::new(server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        ..Default::default()
    });
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (sock, _) = l.accept().await.unwrap();
            let cfg = config.clone();
            tokio::spawn(async move {
                if let Ok(s) = server::run_stream(cfg, sock, TestServer::default()).await {
                    let _ = s.await;
                }
            });
        }
    });
    (port, fp)
}

async fn start_echo() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = l.accept().await.unwrap();
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    port
}

// ───────────── client-side helpers ─────────────

#[derive(Default)]
struct TestIx {
    known: Mutex<HashMap<String, (String, String)>>,
    prompts: Mutex<Vec<HostKeyPrompt>>,
    accept: bool,
}

#[async_trait]
impl Interaction for TestIx {
    fn known_host(&self, host: &str, port: u16) -> Option<(String, String)> {
        self.known.lock().unwrap().get(&format!("{host}:{port}")).cloned()
    }
    fn trust_host(&self, host: &str, port: u16, kt: &str, fp: &str) {
        self.known.lock().unwrap().insert(format!("{host}:{port}"), (kt.into(), fp.into()));
    }
    async fn confirm_host_key(&self, p: HostKeyPrompt) -> bool {
        self.prompts.lock().unwrap().push(p);
        self.accept
    }
    async fn confirm_agent_forwarding(&self, _h: &str) -> bool {
        false
    }
}

fn host(name: &str, port: u16) -> Host {
    let mut h = Host::new(name, "127.0.0.1");
    h.port = port;
    h.username = "u".into();
    h.auth = AuthMethod::Password;
    h.connect_timeout_secs = 5;
    h
}

fn hops(b: u16, t: u16, pw: &str) -> Vec<Hop> {
    vec![
        Hop { host: host("bastion", b), auth: HopAuth::Password("pw".into()), proxy_password: None },
        Hop { host: host("target", t), auth: HopAuth::Password(pw.into()), proxy_password: None },
    ]
}

fn provider(b: u16, t: u16) -> HopProvider {
    Arc::new(move || Ok(hops(b, t, "pw")))
}

fn accepting() -> Arc<TestIx> {
    Arc::new(TestIx { accept: true, ..Default::default() })
}

// ───────────── tests ─────────────

#[tokio::test]
async fn jump_chain_exec_and_tofu() {
    let (b, bfp) = start_server().await;
    let (t, tfp) = start_server().await;
    let ix = accepting();
    let seen = Mutex::new(vec![]);
    let conn = connect_chain(hops(b, t, "pw"), ix.clone(), false, &|i, n, name| seen.lock().unwrap().push(format!("{i}/{n}:{name}")))
        .await
        .expect("chain connect");
    assert_eq!(*seen.lock().unwrap(), ["0/2:bastion", "1/2:target"]);
    let r = ssh::session::exec(&conn, "echo through-the-bastion", Duration::from_secs(5)).await.unwrap();
    assert_eq!(r.stdout, "through-the-bastion\n");
    assert_eq!(r.exit_code, Some(0));

    // Both hops were verified, each with its own key.
    let prompts = ix.prompts.lock().unwrap().clone();
    assert_eq!(prompts.len(), 2);
    assert_eq!(prompts[0].fingerprint, bfp);
    assert_eq!(prompts[1].fingerprint, tfp);
    assert!(prompts.iter().all(|p| p.status == HostKeyStatus::Unknown));

    // Second connection: keys are trusted now, no prompts.
    connect_chain(hops(b, t, "pw"), ix.clone(), false, &|_, _, _| {}).await.unwrap();
    assert_eq!(ix.prompts.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn changed_host_key_is_flagged_and_rejection_aborts() {
    let (b, _) = start_server().await;
    let ix = Arc::new(TestIx::default()); // rejects
    ix.trust_host("127.0.0.1", b, "ssh-ed25519", "SHA256:not-the-real-key");
    let single = vec![Hop { host: host("bastion", b), auth: HopAuth::Password("pw".into()), proxy_password: None }];
    let err = connect_chain(single, ix.clone(), false, &|_, _, _| {}).await.err().expect("must fail");
    assert!(matches!(err, Error::HostKeyRejected(_)), "{err:?}");
    let p = ix.prompts.lock().unwrap()[0].clone();
    assert_eq!(p.status, HostKeyStatus::Changed);
    assert_eq!(p.previous_fingerprint.as_deref(), Some("SHA256:not-the-real-key"));
}

#[tokio::test]
async fn per_hop_credentials_wrong_target_password() {
    let (b, _) = start_server().await;
    let (t, _) = start_server().await;
    let err = connect_chain(hops(b, t, "wrong"), accepting(), false, &|_, _, _| {}).await.err().unwrap();
    match err {
        Error::AuthFailed(who) => assert!(who.contains("target"), "{who}"),
        e => panic!("unexpected {e:?}"),
    }
}

#[tokio::test]
async fn interactive_shell_through_chain() {
    let (b, _) = start_server().await;
    let (t, _) = start_server().await;
    let (etx, mut erx) = tokio::sync::mpsc::unbounded_channel::<SessionEvent>();
    let tx = spawn_shell(
        provider(b, t),
        accepting(),
        ShellOptions { cols: 80, rows: 24, auto_reconnect: false, log_path: None, on_connected: None },
        Arc::new(move |e| {
            let _ = etx.send(e);
        }),
    );
    let mut out = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut sent = false;
    while !out.contains("hello-keystone") {
        let e = tokio::time::timeout_at(deadline, erx.recv()).await.expect("timeout").unwrap();
        match e {
            SessionEvent::Data(d) => out.push_str(&String::from_utf8_lossy(&d)),
            SessionEvent::Status(s, m) => assert!(!matches!(s, keystone_core::ssh::session::SessionStatus::Error), "{m:?}"),
            _ => {}
        }
        if out.contains("welcome$") && !sent {
            tx.send(SessionCmd::Resize(120, 40)).await.unwrap();
            tx.send(SessionCmd::Data(b"hello-keystone".to_vec())).await.unwrap();
            sent = true;
        }
    }
    tx.send(SessionCmd::Close).await.unwrap();
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

async fn wait_running(rx: &mut tokio::sync::mpsc::UnboundedReceiver<tunnel::TunnelStatus>) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let s = tokio::time::timeout_at(deadline, rx.recv()).await.expect("tunnel timeout").unwrap();
        match s.state {
            TunnelState::Running => return,
            TunnelState::Error => panic!("tunnel error: {:?}", s.error),
            _ => {}
        }
    }
}

#[tokio::test]
async fn local_forward_and_port_conflict() {
    let (b, _) = start_server().await;
    let (t, _) = start_server().await;
    let echo = start_echo().await;
    let lp = free_port();
    let tun = Tunnel {
        id: "t1".into(),
        name: "db".into(),
        host_id: "x".into(),
        kind: TunnelKind::Local,
        bind_address: "127.0.0.1".into(),
        bind_port: lp,
        target_host: Some("127.0.0.1".into()),
        target_port: Some(echo),
        auto_start: false,
        auto_reconnect: false,
    };
    let (stx, mut srx) = tokio::sync::mpsc::unbounded_channel();
    let h = tunnel::start(tun.clone(), provider(b, t), accepting(), Arc::new(move |s| {
        let _ = stx.send(s);
    }));
    wait_running(&mut srx).await;
    assert!(!tunnel::port_available("127.0.0.1", lp).await);

    let mut s = TcpStream::connect(("127.0.0.1", lp)).await.unwrap();
    s.write_all(b"ping-through-L").await.unwrap();
    let mut buf = [0u8; 14];
    s.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"ping-through-L");

    // A second tunnel on the same port must report the conflict, not crash.
    let (stx2, mut srx2) = tokio::sync::mpsc::unbounded_channel();
    let _h2 = tunnel::start(Tunnel { id: "t2".into(), ..tun }, provider(b, t), accepting(), Arc::new(move |s| {
        let _ = stx2.send(s);
    }));
    loop {
        let s = srx2.recv().await.unwrap();
        if s.state == TunnelState::Error {
            assert!(s.error.unwrap().contains("already in use"));
            break;
        }
    }
    h.stop();
}

#[tokio::test]
async fn dynamic_socks5_forward() {
    let (b, _) = start_server().await;
    let (t, _) = start_server().await;
    let echo = start_echo().await;
    let lp = free_port();
    let tun = Tunnel {
        id: "d".into(),
        name: "socks".into(),
        host_id: "x".into(),
        kind: TunnelKind::Dynamic,
        bind_address: "127.0.0.1".into(),
        bind_port: lp,
        target_host: None,
        target_port: None,
        auto_start: false,
        auto_reconnect: false,
    };
    let (stx, mut srx) = tokio::sync::mpsc::unbounded_channel();
    let _h = tunnel::start(tun, provider(b, t), accepting(), Arc::new(move |s| {
        let _ = stx.send(s);
    }));
    wait_running(&mut srx).await;
    let mut s = TcpStream::connect(("127.0.0.1", lp)).await.unwrap();
    ssh::proxy::socks5_connect(&mut s, "localhost", echo, None, None).await.unwrap();
    s.write_all(b"via-socks").await.unwrap();
    let mut buf = [0u8; 9];
    s.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"via-socks");
}
