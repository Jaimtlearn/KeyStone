use async_trait::async_trait;
use keystone_core::pty::LocalPty;
use keystone_core::secret::SecretString;
use keystone_core::ssh::session::SessionCmd;
use keystone_core::ssh::sftp::Sftp;
use keystone_core::ssh::tunnel::{TunnelHandle, TunnelStatus};
use keystone_core::ssh::{hop_auth_for, Hop, HopProvider, HostKeyPrompt, Interaction};
use keystone_core::store::{AuthMethod, Store};
use keystone_core::vault::UnlockedVault;
use keystone_core::{Error, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot};

pub const EV_VAULT_LOCKED: &str = "vault://locked";
pub const EV_HOSTKEY: &str = "hostkey://prompt";
pub const EV_AGENTFWD: &str = "agentfwd://prompt";
pub const EV_TUNNEL: &str = "tunnel://status";
pub const EV_SFTP: &str = "sftp://progress";
pub const EV_CLIPBOARD: &str = "clipboard://cleared";

/// How long a host-key / consent prompt waits before it is treated as "deny".
const PROMPT_TIMEOUT: Duration = Duration::from_secs(180);

pub enum Session {
    Ssh(mpsc::Sender<SessionCmd>),
    Local(Arc<LocalPty>),
}

pub struct AppState {
    pub store: Mutex<Store>,
    /// `None` = locked. Secrets only exist in this process while `Some`.
    pub vault: Mutex<Option<UnlockedVault>>,
    pub last_activity: Mutex<Instant>,
    pub sessions: Mutex<HashMap<String, Session>>,
    pub tunnels: Mutex<HashMap<String, TunnelHandle>>,
    pub tunnel_status: Mutex<HashMap<String, TunnelStatus>>,
    pub sftp: Mutex<HashMap<String, Arc<Sftp>>>,
    pub prompts: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    /// Incremented on every copy so an older auto-clear timer never wipes a newer copy.
    pub clipboard_gen: AtomicU64,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        AppState {
            store: Mutex::new(store),
            vault: Mutex::new(None),
            last_activity: Mutex::new(Instant::now()),
            sessions: Default::default(),
            tunnels: Default::default(),
            tunnel_status: Default::default(),
            sftp: Default::default(),
            prompts: Default::default(),
            clipboard_gen: AtomicU64::new(0),
        }
    }

    pub fn touch(&self) {
        *self.last_activity.lock().unwrap() = Instant::now();
    }

    /// Run `f` against the unlocked vault (and count it as activity).
    pub fn with_vault<T>(&self, f: impl FnOnce(&mut UnlockedVault) -> Result<T>) -> Result<T> {
        let mut g = self.vault.lock().unwrap();
        let v = g.as_mut().ok_or(Error::VaultLocked)?;
        self.touch();
        f(v)
    }

    pub fn lock_vault(&self, app: &AppHandle) {
        let was_unlocked = self.vault.lock().unwrap().take().is_some(); // drop => zeroize
        if was_unlocked {
            let _ = app.emit(EV_VAULT_LOCKED, ());
        }
    }
}

/// Bridges core prompts to the UI via events + a one-shot reply command.
pub struct AppInteraction {
    pub app: AppHandle,
}

impl AppInteraction {
    async fn ask<P: Serialize + Clone>(&self, event: &str, request_id: String, payload: P) -> bool {
        let (tx, rx) = oneshot::channel();
        let state = self.app.state::<AppState>();
        state.prompts.lock().unwrap().insert(request_id.clone(), tx);
        if self.app.emit(event, payload).is_err() {
            state.prompts.lock().unwrap().remove(&request_id);
            return false;
        }
        let answer = tokio::time::timeout(PROMPT_TIMEOUT, rx).await;
        state.prompts.lock().unwrap().remove(&request_id);
        matches!(answer, Ok(Ok(true)))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentForwardPrompt {
    request_id: String,
    host_name: String,
}

#[async_trait]
impl Interaction for AppInteraction {
    fn known_host(&self, host: &str, port: u16) -> Option<(String, String)> {
        let st = self.app.state::<AppState>();
        let s = st.store.lock().unwrap();
        s.known_host(host, port).map(|k| (k.key_type.clone(), k.fingerprint.clone()))
    }

    fn trust_host(&self, host: &str, port: u16, key_type: &str, fingerprint: &str) {
        let st = self.app.state::<AppState>();
        let mut s = st.store.lock().unwrap();
        if let Err(e) = s.trust_host_key(host, port, key_type, fingerprint) {
            tracing::error!("failed to persist host key for {host}:{port}: {e}");
        }
    }

    async fn confirm_host_key(&self, prompt: HostKeyPrompt) -> bool {
        let id = prompt.request_id.clone();
        self.ask(EV_HOSTKEY, id, prompt).await
    }

    async fn confirm_agent_forwarding(&self, host_name: &str) -> bool {
        let id = uuid::Uuid::new_v4().to_string();
        self.ask(EV_AGENTFWD, id.clone(), AgentForwardPrompt { request_id: id, host_name: host_name.into() }).await
    }
}

/// Builds a provider that resolves the jump chain and pulls each hop's secrets out
/// of the vault *at connect time*. If the vault is locked, connections that need
/// vault secrets fail with `VaultLocked`; agent / identity-file auth still works.
pub fn hop_provider(app: AppHandle, host_id: String) -> HopProvider {
    Arc::new(move || {
        let st = app.state::<AppState>();
        let chain = st.store.lock().unwrap().resolve_chain(&host_id)?;
        let vault = st.vault.lock().unwrap();
        let secret = |cred: &Option<String>, key: &str| -> Result<Option<SecretString>> {
            match cred {
                None => Ok(None),
                Some(id) => {
                    let v = vault.as_ref().ok_or(Error::VaultLocked)?;
                    Ok(v.get(id)?.secret(key).cloned())
                }
            }
        };
        chain
            .into_iter()
            .map(|host| {
                let cred = &host.credential_id;
                let auth = match host.auth {
                    AuthMethod::Agent => hop_auth_for(&host, None, None, None)?,
                    AuthMethod::Password => hop_auth_for(&host, secret(cred, "password")?, None, None)?,
                    AuthMethod::PublicKey => {
                        hop_auth_for(&host, None, secret(cred, "privateKey")?, secret(cred, "passphrase")?)?
                    }
                };
                let proxy_password = match &host.proxy {
                    Some(p) => secret(&p.credential_id, "password")?,
                    None => None,
                };
                Ok(Hop { host, auth, proxy_password })
            })
            .collect()
    })
}

/// Locks the vault after `vault.autoLockSecs` of inactivity (0 disables).
pub fn spawn_auto_lock(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        loop {
            tick.tick().await;
            let st = app.state::<AppState>();
            let secs = st.store.lock().unwrap().settings().auto_lock_secs;
            if secs == 0 {
                continue;
            }
            let idle = st.last_activity.lock().unwrap().elapsed();
            if idle >= Duration::from_secs(secs) && st.vault.lock().unwrap().is_some() {
                st.lock_vault(&app);
            }
        }
    });
}
