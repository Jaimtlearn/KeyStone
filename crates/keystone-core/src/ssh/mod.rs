//! SSH connections, including chained jump hosts.
//!
//! A chain `[bastion-1, bastion-2, target]` is established by connecting to hop 0
//! over TCP, then for every following hop opening a `direct-tcpip` channel on the
//! previous hop and running a full SSH handshake *through* that channel
//! (equivalent to OpenSSH `ProxyJump`). Every hop authenticates with its own
//! credentials and has its own host key verified, so the end-to-end encryption to
//! the target never terminates on a bastion.

pub mod proxy;
pub mod session;
pub mod sftp;
pub mod tunnel;

use crate::error::{Error, Result};
use crate::secret::SecretString;
use crate::store::{AuthMethod, Host};
use async_trait::async_trait;
use russh::client::{self, Handle};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How a single hop authenticates. Built by the app from the vault right before
/// connecting and dropped (zeroized) as soon as authentication finishes.
pub enum HopAuth {
    Password(SecretString),
    /// Private key material from the vault.
    Key { pem: SecretString, passphrase: Option<SecretString> },
    /// Private key file on disk.
    KeyFile { path: String, passphrase: Option<SecretString> },
    Agent,
}

pub struct Hop {
    pub host: Host,
    pub auth: HopAuth,
    pub proxy_password: Option<SecretString>,
}

/// Produces fresh hops (re-reading the vault) for each connect / reconnect attempt,
/// so long-lived sessions do not keep decrypted secrets around.
pub type HopProvider = Arc<dyn Fn() -> Result<Vec<Hop>> + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPrompt {
    pub request_id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub status: HostKeyStatus,
    pub previous_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HostKeyStatus {
    Unknown,
    Changed,
}

/// The UI-facing side of a connection: host-key trust and consent prompts.
#[async_trait]
pub trait Interaction: Send + Sync {
    /// Returns (key_type, fingerprint) of the trusted key for host:port, if any.
    fn known_host(&self, host: &str, port: u16) -> Option<(String, String)>;
    fn trust_host(&self, host: &str, port: u16, key_type: &str, fingerprint: &str);
    /// Ask the user. Must resolve to `false` on timeout / window closed.
    async fn confirm_host_key(&self, prompt: HostKeyPrompt) -> bool;
    async fn confirm_agent_forwarding(&self, host_name: &str) -> bool;
}

// ───────────── remote (-R) forward registry ─────────────

#[derive(Default)]
pub struct TrafficStats {
    pub active: AtomicU32,
    pub bytes_in: AtomicU64,
    pub bytes_out: AtomicU64,
}

#[derive(Clone)]
pub struct RemoteForward {
    pub target_host: String,
    pub target_port: u16,
    pub stats: Arc<TrafficStats>,
}

/// Maps a remote bound port -> local target for `-R` forwards on this connection.
pub type ForwardRegistry = Arc<Mutex<HashMap<u32, RemoteForward>>>;

// ───────────── handler ─────────────

pub struct ClientHandler {
    host: String,
    port: u16,
    ix: Arc<dyn Interaction>,
    forwards: ForwardRegistry,
    agent_forwarding: bool,
}

pub(crate) fn fingerprint_of(key: &PublicKeyOrCertificate) -> (String, String) {
    match key {
        PublicKeyOrCertificate::PublicKey { key, .. } => {
            (key.algorithm().to_string(), key.fingerprint(HashAlg::Sha256).to_string())
        }
        PublicKeyOrCertificate::Certificate(c) => {
            (c.algorithm().to_string(), c.public_key().fingerprint(HashAlg::Sha256).to_string())
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> std::result::Result<bool, Self::Error> {
        let (key_type, fp) = fingerprint_of(key);
        let known = self.ix.known_host(&self.host, self.port);
        if let Some((_, known_fp)) = &known {
            if *known_fp == fp {
                return Ok(true);
            }
        }
        let prompt = HostKeyPrompt {
            request_id: uuid::Uuid::new_v4().to_string(),
            host: self.host.clone(),
            port: self.port,
            key_type: key_type.clone(),
            fingerprint: fp.clone(),
            status: if known.is_some() { HostKeyStatus::Changed } else { HostKeyStatus::Unknown },
            previous_fingerprint: known.map(|k| k.1),
        };
        let ok = self.ix.confirm_host_key(prompt).await;
        if ok {
            self.ix.trust_host(&self.host, self.port, &key_type, &fp);
        }
        Ok(ok)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        let fwd = self.forwards.lock().unwrap().get(&connected_port).cloned();
        let Some(fwd) = fwd else {
            reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            match tokio::net::TcpStream::connect((fwd.target_host.as_str(), fwd.target_port)).await {
                Ok(mut tcp) => {
                    fwd.stats.active.fetch_add(1, Ordering::Relaxed);
                    let mut ch = channel.into_stream();
                    if let Ok((a, b)) = tokio::io::copy_bidirectional(&mut ch, &mut tcp).await {
                        fwd.stats.bytes_in.fetch_add(a, Ordering::Relaxed);
                        fwd.stats.bytes_out.fetch_add(b, Ordering::Relaxed);
                    }
                    fwd.stats.active.fetch_sub(1, Ordering::Relaxed);
                }
                Err(e) => {
                    tracing::warn!("remote forward target {}:{} unreachable: {e}", fwd.target_host, fwd.target_port);
                    let _ = channel.close().await;
                }
            }
        });
        Ok(())
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        // Only honoured if the user consented for this connection (see session.rs).
        if !self.agent_forwarding {
            reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
            return Ok(());
        }
        reply.accept().await;
        tokio::spawn(async move {
            let mut ch = channel.into_stream();
            if let Err(e) = agent::proxy_to_local_agent(&mut ch).await {
                tracing::warn!("agent forwarding failed: {e}");
            }
        });
        Ok(())
    }
}

// ───────────── agent ─────────────

pub(crate) mod agent {
    use crate::error::{Error, Result};
    use tokio::io::{AsyncRead, AsyncWrite};

    #[cfg(unix)]
    pub async fn proxy_to_local_agent<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S) -> Result<()> {
        let path = std::env::var("SSH_AUTH_SOCK").map_err(|_| Error::Ssh("SSH_AUTH_SOCK is not set".into()))?;
        let mut sock = tokio::net::UnixStream::connect(path).await?;
        tokio::io::copy_bidirectional(s, &mut sock).await?;
        Ok(())
    }

    #[cfg(windows)]
    pub async fn proxy_to_local_agent<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S) -> Result<()> {
        let mut pipe = tokio::net::windows::named_pipe::ClientOptions::new().open(r"\\.\pipe\openssh-ssh-agent")?;
        tokio::io::copy_bidirectional(s, &mut pipe).await?;
        Ok(())
    }

    #[cfg(unix)]
    pub async fn client() -> Result<russh::keys::agent::client::AgentClient<tokio::net::UnixStream>> {
        russh::keys::agent::client::AgentClient::connect_env()
            .await
            .map_err(|e| Error::Ssh(format!("cannot reach ssh-agent (SSH_AUTH_SOCK): {e}")))
    }

    #[cfg(windows)]
    pub async fn client() -> Result<russh::keys::agent::client::AgentClient<tokio::net::windows::named_pipe::NamedPipeClient>> {
        russh::keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
            .await
            .map_err(|e| Error::Ssh(format!("cannot reach the OpenSSH agent service: {e}")))
    }
}

// ───────────── connection ─────────────

/// An authenticated connection to the last hop. Keeps every intermediate hop alive.
pub struct Connection {
    handles: Vec<Arc<Handle<ClientHandler>>>,
    pub forwards: ForwardRegistry,
    pub target_name: String,
}

impl Connection {
    pub fn target(&self) -> &Handle<ClientHandler> {
        self.handles.last().expect("connection has at least one hop")
    }
    pub fn is_closed(&self) -> bool {
        self.handles.iter().any(|h| h.is_closed())
    }
    pub async fn disconnect(&self) {
        for h in self.handles.iter().rev() {
            let _ = h.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        }
    }
}

fn client_config(h: &Host) -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: (h.keep_alive_secs > 0).then(|| Duration::from_secs(h.keep_alive_secs as u64)),
        keepalive_max: h.keep_alive_max_missed.max(1) as usize,
        nodelay: true,
        ..Default::default()
    })
}

async fn authenticate(handle: &mut Handle<ClientHandler>, host: &Host, auth: HopAuth) -> Result<()> {
    let user = host.username.clone();
    if user.is_empty() {
        return Err(Error::Invalid(format!("no username configured for {}", host.name)));
    }
    let label = format!("{}@{}", user, host.name);
    let ok = match auth {
        HopAuth::Password(pw) => handle.authenticate_password(&user, pw.expose()).await?.success(),
        HopAuth::Key { pem, passphrase } => {
            let key = russh::keys::decode_secret_key(pem.expose(), passphrase.as_ref().map(|p| p.expose()))
                .map_err(|_| Error::AuthFailed(format!("{label}: could not decrypt private key (wrong passphrase?)")))?;
            pubkey_auth(handle, &user, key).await?
        }
        HopAuth::KeyFile { path, passphrase } => {
            let key = russh::keys::load_secret_key(&path, passphrase.as_ref().map(|p| p.expose()))
                .map_err(|e| Error::AuthFailed(format!("{label}: cannot load {path}: {e}")))?;
            pubkey_auth(handle, &user, key).await?
        }
        HopAuth::Agent => {
            let mut agent = agent::client().await?;
            let ids = agent.request_identities().await.map_err(|e| Error::Ssh(format!("agent: {e}")))?;
            if ids.is_empty() {
                return Err(Error::AuthFailed(format!("{label}: ssh-agent has no keys loaded")));
            }
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            let mut ok = false;
            for id in ids {
                let r = handle
                    .authenticate_publickey_with(&user, id.public_key().into_owned(), hash, &mut agent)
                    .await
                    .map_err(|e| Error::Ssh(format!("agent signing failed: {e}")))?;
                if r.success() {
                    ok = true;
                    break;
                }
            }
            ok
        }
    };
    if ok { Ok(()) } else { Err(Error::AuthFailed(label)) }
}

fn handshake_err(e: russh::Error, what: &str) -> Error {
    match e {
        russh::Error::UnknownKey => Error::HostKeyRejected(what.to_owned()),
        other => Error::Ssh(format!("{what}: {other}")),
    }
}

async fn pubkey_auth(handle: &mut Handle<ClientHandler>, user: &str, key: russh::keys::PrivateKey) -> Result<bool> {
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    let k = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
    Ok(handle.authenticate_publickey(user, k).await?.success())
}

/// Establish the full chain. `on_hop(index, total, name)` is called as each hop starts.
pub async fn connect_chain(
    hops: Vec<Hop>,
    ix: Arc<dyn Interaction>,
    agent_forwarding_allowed: bool,
    on_hop: &(dyn Fn(usize, usize, &str) + Send + Sync),
) -> Result<Connection> {
    if hops.is_empty() {
        return Err(Error::Invalid("nothing to connect to".into()));
    }
    let total = hops.len();
    let forwards: ForwardRegistry = Default::default();
    let mut handles: Vec<Arc<Handle<ClientHandler>>> = Vec::with_capacity(total);
    let target_name = hops.last().map(|h| h.host.name.clone()).unwrap_or_default();

    for (i, hop) in hops.into_iter().enumerate() {
        let Hop { host, auth, proxy_password } = hop;
        on_hop(i, total, &host.name);
        let is_target = i + 1 == total;
        let handler = ClientHandler {
            host: host.hostname.clone(),
            port: host.port,
            ix: ix.clone(),
            forwards: if is_target { forwards.clone() } else { Default::default() },
            agent_forwarding: is_target && agent_forwarding_allowed,
        };
        let timeout = Duration::from_secs(host.connect_timeout_secs.max(1) as u64);
        let config = client_config(&host);
        let what = format!("{} ({}:{})", host.name, host.hostname, host.port);

        let fut = async {
            let mut handle = if i == 0 {
                let tcp = proxy::connect_tcp(&host, proxy_password.as_ref()).await?;
                client::connect_stream(config, tcp, handler).await.map_err(|e| handshake_err(e, &what))?
            } else {
                let prev = handles.last().unwrap();
                let ch = prev
                    .channel_open_direct_tcpip(host.hostname.clone(), host.port as u32, "127.0.0.1", 0)
                    .await
                    .map_err(|e| Error::Ssh(format!("bastion could not reach {what}: {e}")))?;
                client::connect_stream(config, ch.into_stream(), handler).await.map_err(|e| handshake_err(e, &what))?
            };
            authenticate(&mut handle, &host, auth).await?;
            Ok::<_, Error>(handle)
        };
        let handle = match tokio::time::timeout(timeout, fut).await {
            Ok(Ok(h)) => h,
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err(Error::Timeout(format!("connecting to {what}"))),
        };
        handles.push(Arc::new(handle));
    }
    Ok(Connection { handles, forwards, target_name })
}

/// Map an `AuthMethod` + resolved secrets into a `HopAuth`. Used by the app layer.
pub fn hop_auth_for(host: &Host, password: Option<SecretString>, key_pem: Option<SecretString>, passphrase: Option<SecretString>) -> Result<HopAuth> {
    Ok(match host.auth {
        AuthMethod::Agent => HopAuth::Agent,
        AuthMethod::Password => HopAuth::Password(
            password.ok_or_else(|| Error::Invalid(format!("{}: no password credential selected", host.name)))?,
        ),
        AuthMethod::PublicKey => match (key_pem, &host.identity_file) {
            (Some(pem), _) => HopAuth::Key { pem, passphrase },
            (None, Some(path)) if !path.is_empty() => HopAuth::KeyFile { path: path.clone(), passphrase },
            _ => return Err(Error::Invalid(format!("{}: no private key credential or identity file", host.name))),
        },
    })
}
