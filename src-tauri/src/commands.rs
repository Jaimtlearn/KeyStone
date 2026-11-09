//! Tauri commands. One function per entry in ui/src/lib/api.ts.
//!
//! Secret-handling rules enforced here:
//! * Secret values only flow UI -> backend (create/update/unlock), never back,
//!   except `credential_reveal`, which the UI calls only on an explicit user click.
//! * `credential_copy` writes to the OS clipboard from Rust; the secret never enters JS.
//! * Nothing in this file logs arguments.

use crate::state::*;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use keystone_core::password::{self, PasswordOptions, PasswordStrength};
use keystone_core::pty::LocalPty;
use keystone_core::secret::SecretString;
use keystone_core::ssh::session::{self, ExecResult, SessionCmd, SessionEvent, SessionStatus, ShellOptions};
use keystone_core::ssh::sftp::{self, FileEntry, Sftp};
use keystone_core::ssh::tunnel::{self, TunnelStatus};
use keystone_core::ssh::{connect_chain, Interaction};
use keystone_core::store::{Folder, Host, Tunnel};
use keystone_core::vault::{self, CredentialInput, CredentialSummary, CredentialVersion, ImportMode, UnlockedVault};
use keystone_core::{Error, Result};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

type St<'a> = State<'a, AppState>;

fn ix(app: &AppHandle) -> Arc<dyn Interaction> {
    Arc::new(AppInteraction { app: app.clone() })
}

/// Argon2id is deliberately slow; keep it off the async executor threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| Error::Invalid(format!("worker failed: {e}")))?
}

// ───────────────────────────── store ─────────────────────────────

#[derive(Serialize)]
pub struct StoreSnapshot {
    hosts: Vec<Host>,
    folders: Vec<Folder>,
    tunnels: Vec<Tunnel>,
}

#[tauri::command]
pub fn store_load(state: St) -> Result<StoreSnapshot> {
    let s = state.store.lock().unwrap();
    Ok(StoreSnapshot { hosts: s.profiles.hosts.clone(), folders: s.profiles.folders.clone(), tunnels: s.profiles.tunnels.clone() })
}

#[tauri::command]
pub fn host_save(state: St, host: Host) -> Result<Host> {
    state.store.lock().unwrap().save_host(host)
}

#[tauri::command]
pub fn host_delete(state: St, id: String) -> Result<()> {
    state.store.lock().unwrap().delete_host(&id)?;
    if let Some(v) = state.vault.lock().unwrap().as_mut() {
        v.unlink_host(&id)?;
    }
    Ok(())
}

#[tauri::command]
pub fn host_duplicate(state: St, id: String) -> Result<Host> {
    state.store.lock().unwrap().duplicate_host(&id)
}

#[tauri::command]
pub fn folder_save(state: St, folder: Folder) -> Result<Folder> {
    state.store.lock().unwrap().save_folder(folder)
}

#[tauri::command]
pub fn folder_delete(state: St, id: String) -> Result<()> {
    state.store.lock().unwrap().delete_folder(&id)
}

#[tauri::command]
pub fn profiles_export(state: St, path: String, host_ids: Option<Vec<String>>) -> Result<usize> {
    state.store.lock().unwrap().export_profiles(&PathBuf::from(path), host_ids.as_deref())
}

#[tauri::command]
pub fn profiles_import(state: St, path: String) -> Result<usize> {
    state.store.lock().unwrap().import_profiles(&PathBuf::from(path))
}

#[tauri::command]
pub fn ssh_config_import(state: St, path: Option<String>) -> Result<usize> {
    state.store.lock().unwrap().import_ssh_config(path.map(PathBuf::from).as_deref())
}

#[tauri::command]
pub fn tunnel_save(state: St, tunnel: Tunnel) -> Result<Tunnel> {
    state.store.lock().unwrap().save_tunnel(tunnel)
}

#[tauri::command]
pub fn tunnel_delete(state: St, id: String) -> Result<()> {
    if let Some(h) = state.tunnels.lock().unwrap().remove(&id) {
        h.stop();
    }
    state.tunnel_status.lock().unwrap().remove(&id);
    state.store.lock().unwrap().delete_tunnel(&id)
}

// ───────────────────────────── settings / workspace ─────────────────────────────

/// Returns `null` on first launch; the UI merges with its defaults.
#[tauri::command]
pub fn settings_get(state: St) -> Result<serde_json::Value> {
    state.store.lock().unwrap().settings_json()
}

#[tauri::command]
pub fn settings_set(state: St, settings: serde_json::Value) -> Result<()> {
    state.store.lock().unwrap().set_settings_json(&settings)
}

#[tauri::command]
pub fn workspace_get(state: St) -> Result<Option<serde_json::Value>> {
    state.store.lock().unwrap().workspace_json()
}

#[tauri::command]
pub fn workspace_save(state: St, workspace: serde_json::Value) -> Result<()> {
    state.store.lock().unwrap().set_workspace_json(&workspace)
}

// ───────────────────────────── vault ─────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    exists: bool,
    unlocked: bool,
    auto_lock_secs: u64,
    /// OS keychain integration is not implemented yet (see docs/THREAT_MODEL.md §6).
    os_keychain_available: bool,
}

#[tauri::command]
pub fn vault_status(state: St) -> Result<VaultStatus> {
    let (path, secs) = {
        let s = state.store.lock().unwrap();
        (s.vault_path(), s.settings().auto_lock_secs)
    };
    Ok(VaultStatus {
        exists: vault::exists(&path),
        unlocked: state.vault.lock().unwrap().is_some(),
        auto_lock_secs: secs,
        os_keychain_available: false,
    })
}

#[tauri::command]
pub async fn vault_create(state: St<'_>, master_password: SecretString) -> Result<()> {
    let path = state.store.lock().unwrap().vault_path();
    let v = blocking(move || UnlockedVault::create(&path, master_password.expose())).await?;
    *state.vault.lock().unwrap() = Some(v);
    state.touch();
    Ok(())
}

#[tauri::command]
pub async fn vault_unlock(state: St<'_>, master_password: SecretString) -> Result<()> {
    let path = state.store.lock().unwrap().vault_path();
    let v = blocking(move || UnlockedVault::unlock(&path, master_password.expose())).await?;
    *state.vault.lock().unwrap() = Some(v);
    state.touch();
    Ok(())
}

#[tauri::command]
pub fn vault_lock(app: AppHandle, state: St) -> Result<()> {
    state.lock_vault(&app);
    Ok(())
}

/// Called (throttled) by the UI on user input so auto-lock measures real inactivity.
#[tauri::command]
pub fn vault_touch(state: St) -> Result<()> {
    if state.vault.lock().unwrap().is_some() {
        state.touch();
    }
    Ok(())
}

#[tauri::command]
pub async fn vault_change_password(app: AppHandle, old_password: SecretString, new_password: SecretString) -> Result<()> {
    blocking(move || {
        let st = app.state::<AppState>();
        st.with_vault(|v| v.change_password(old_password.expose(), new_password.expose()))
    })
    .await
}

#[tauri::command]
pub async fn vault_export_backup(app: AppHandle, path: String, export_password: SecretString) -> Result<()> {
    blocking(move || {
        let st = app.state::<AppState>();
        st.with_vault(|v| v.export_backup(&PathBuf::from(&path), export_password.expose()))
    })
    .await
}

#[tauri::command]
pub async fn vault_import_backup(app: AppHandle, path: String, password: SecretString, mode: ImportMode) -> Result<usize> {
    blocking(move || {
        let st = app.state::<AppState>();
        st.with_vault(|v| v.import_backup(&PathBuf::from(&path), password.expose(), mode))
    })
    .await
}

#[tauri::command]
pub fn credential_list(state: St) -> Result<Vec<CredentialSummary>> {
    state.with_vault(|v| Ok(v.list()))
}

#[tauri::command]
pub fn credential_create(state: St, input: CredentialInput) -> Result<CredentialSummary> {
    state.with_vault(|v| v.create_credential(input))
}

#[tauri::command]
pub fn credential_update(state: St, id: String, input: CredentialInput) -> Result<CredentialSummary> {
    state.with_vault(|v| v.update_credential(&id, input))
}

#[tauri::command]
pub fn credential_delete(state: St, id: String) -> Result<()> {
    // Detach from hosts so they don't point at a missing credential.
    {
        let mut s = state.store.lock().unwrap();
        let affected: Vec<Host> = s
            .profiles
            .hosts
            .iter()
            .filter(|h| h.credential_id.as_deref() == Some(id.as_str()))
            .cloned()
            .collect();
        for mut h in affected {
            h.credential_id = None;
            s.save_host(h)?;
        }
    }
    state.with_vault(|v| v.delete_credential(&id))
}

#[tauri::command]
pub fn credential_history(state: St, id: String) -> Result<Vec<CredentialVersion>> {
    state.with_vault(|v| v.history(&id))
}

#[tauri::command]
pub fn credential_restore_version(state: St, id: String, version: u32) -> Result<CredentialSummary> {
    state.with_vault(|v| v.restore_version(&id, version))
}

#[tauri::command]
pub fn credential_reveal(state: St, id: String, field_key: String) -> Result<String> {
    state.with_vault(|v| Ok(v.reveal(&id, &field_key)?.expose().to_owned()))
}

/// Copies a secret to the OS clipboard, then clears it after `clipboardClearSecs`
/// — but only if the clipboard still holds what we put there (compared by hash),
/// so we never wipe something the user copied afterwards.
#[tauri::command]
pub fn credential_copy(app: AppHandle, state: St, id: String, field_key: String) -> Result<u64> {
    use sha2::{Digest, Sha256};
    let secret = state.with_vault(|v| v.reveal(&id, &field_key))?;
    let digest = Sha256::digest(secret.expose().as_bytes());
    app.clipboard().write_text(secret.expose()).map_err(|e| Error::Invalid(format!("clipboard: {e}")))?;
    drop(secret);
    let secs = state.store.lock().unwrap().settings().clipboard_clear_secs;
    let generation = state.clipboard_gen.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(secs)).await;
        let st = app.state::<AppState>();
        if st.clipboard_gen.load(Ordering::SeqCst) != generation {
            return;
        }
        let current = app.clipboard().read_text().unwrap_or_default();
        if Sha256::digest(current.as_bytes()) == digest {
            let _ = app.clipboard().write_text("");
            let _ = app.emit(EV_CLIPBOARD, ());
        }
    });
    Ok(secs)
}

#[tauri::command]
pub fn password_generate(options: PasswordOptions) -> Result<String> {
    Ok(password::generate(&options)?.to_string())
}

#[tauri::command]
pub fn password_strength(password: SecretString) -> PasswordStrength {
    password::strength(password.expose())
}

// ───────────────────────────── terminal sessions ─────────────────────────────

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TermEvent {
    Data { data: String },
    Status { status: SessionStatus, message: Option<String> },
    Hop { index: usize, total: usize, name: String },
}

fn session_log_path(app: &AppHandle, host_name: &str) -> Option<PathBuf> {
    let st = app.state::<AppState>();
    let settings = st.store.lock().unwrap().settings();
    if !settings.logging_enabled {
        return None;
    }
    let dir = settings.log_dir.or_else(|| app.path().app_data_dir().ok().map(|d| d.join("logs")))?;
    std::fs::create_dir_all(&dir).ok()?;
    let safe: String = host_name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    Some(dir.join(format!("{safe}-{ts}.log")))
}

// Must be `async`: Tauri runs sync commands on the main thread, outside the Tokio
// runtime, and spawn_shell needs a runtime (a sync version crashed the app on connect).
#[tauri::command]
pub async fn ssh_open(app: AppHandle, state: St<'_>, host_id: String, cols: u32, rows: u32, on_event: Channel<TermEvent>) -> Result<String> {
    let host = state.store.lock().unwrap().host(&host_id)?.clone();
    let settings = state.store.lock().unwrap().settings();
    let id = uuid::Uuid::new_v4().to_string();
    let app2 = app.clone();
    let hid = host_id.clone();
    let opts = ShellOptions {
        cols,
        rows,
        auto_reconnect: settings.auto_reconnect,
        log_path: session_log_path(&app, &host.name),
        on_connected: Some(Arc::new(move || {
            let _ = app2.state::<AppState>().store.lock().unwrap().touch_host(&hid);
        })),
    };
    let sink = Arc::new(move |e: SessionEvent| {
        let ev = match e {
            SessionEvent::Data(d) => TermEvent::Data { data: B64.encode(d) },
            SessionEvent::Status(status, message) => TermEvent::Status { status, message },
            SessionEvent::Hop { index, total, name } => TermEvent::Hop { index, total, name },
        };
        let _ = on_event.send(ev);
    });
    let tx = session::spawn_shell(hop_provider(app.clone(), host_id), ix(&app), opts, sink);
    state.sessions.lock().unwrap().insert(id.clone(), Session::Ssh(tx));
    Ok(id)
}

#[tauri::command]
pub fn local_open(state: St, shell: Option<String>, cols: u16, rows: u16, on_event: Channel<TermEvent>) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let ch = on_event.clone();
    let _ = on_event.send(TermEvent::Status { status: SessionStatus::Connected, message: None });
    let pty = LocalPty::spawn(
        shell,
        cols,
        rows,
        Arc::new(move |d| {
            let _ = ch.send(TermEvent::Data { data: B64.encode(d) });
        }),
        Arc::new(move || {
            let _ = on_event.send(TermEvent::Status { status: SessionStatus::Closed, message: Some("shell exited".into()) });
        }),
    )?;
    state.sessions.lock().unwrap().insert(id.clone(), Session::Local(pty));
    Ok(id)
}

#[tauri::command]
pub async fn session_write(state: St<'_>, session_id: String, data: String) -> Result<()> {
    let target = match state.sessions.lock().unwrap().get(&session_id) {
        Some(Session::Ssh(tx)) => Ok(tx.clone()),
        Some(Session::Local(p)) => Err(p.clone()),
        None => return Err(Error::NotFound("session".into())),
    };
    match target {
        Ok(tx) => tx.send(SessionCmd::Data(data.into_bytes())).await.map_err(|_| Error::NotFound("session".into())),
        Err(pty) => pty.write(data.as_bytes()),
    }
}

#[tauri::command]
pub async fn session_resize(state: St<'_>, session_id: String, cols: u32, rows: u32) -> Result<()> {
    let target = match state.sessions.lock().unwrap().get(&session_id) {
        Some(Session::Ssh(tx)) => Ok(tx.clone()),
        Some(Session::Local(p)) => Err(p.clone()),
        None => return Ok(()),
    };
    match target {
        Ok(tx) => {
            let _ = tx.send(SessionCmd::Resize(cols, rows)).await;
            Ok(())
        }
        Err(pty) => pty.resize(cols.min(u16::MAX as u32) as u16, rows.min(u16::MAX as u32) as u16),
    }
}

#[tauri::command]
pub async fn session_close(state: St<'_>, session_id: String) -> Result<()> {
    let s = state.sessions.lock().unwrap().remove(&session_id);
    match s {
        Some(Session::Ssh(tx)) => {
            let _ = tx.send(SessionCmd::Close).await;
        }
        Some(Session::Local(p)) => p.kill(),
        None => {}
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_exec(app: AppHandle, host_id: String, command: String) -> Result<ExecResult> {
    let hops = hop_provider(app.clone(), host_id)()?;
    let conn = connect_chain(hops, ix(&app), false, &|_, _, _| {}).await?;
    let r = session::exec(&conn, &command, Duration::from_secs(30)).await;
    conn.disconnect().await;
    r
}

#[tauri::command]
pub fn hostkey_respond(state: St, request_id: String, accept: bool) -> Result<()> {
    if let Some(tx) = state.prompts.lock().unwrap().remove(&request_id) {
        let _ = tx.send(accept);
    }
    Ok(())
}

#[tauri::command]
pub fn agentfwd_respond(state: St, request_id: String, allow: bool) -> Result<()> {
    hostkey_respond(state, request_id, allow)
}

// ───────────────────────────── tunnels ─────────────────────────────

pub fn start_tunnel(app: &AppHandle, id: &str) -> Result<()> {
    let st = app.state::<AppState>();
    let t = st.store.lock().unwrap().tunnel(id)?.clone();
    if let Some(old) = st.tunnels.lock().unwrap().remove(id) {
        old.stop();
    }
    let app2 = app.clone();
    let sink = Arc::new(move |s: TunnelStatus| {
        app2.state::<AppState>().tunnel_status.lock().unwrap().insert(s.id.clone(), s.clone());
        let _ = app2.emit(EV_TUNNEL, s);
    });
    let h = tunnel::start(t.clone(), hop_provider(app.clone(), t.host_id.clone()), ix(app), sink);
    st.tunnels.lock().unwrap().insert(id.to_owned(), h);
    Ok(())
}

// Async for the same reason as ssh_open: tunnel::start spawns Tokio tasks.
#[tauri::command]
pub async fn tunnel_start(app: AppHandle, id: String) -> Result<()> {
    start_tunnel(&app, &id)
}

#[tauri::command]
pub fn tunnel_stop(app: AppHandle, state: St, id: String) -> Result<()> {
    if let Some(h) = state.tunnels.lock().unwrap().remove(&id) {
        h.stop();
    }
    let s = TunnelStatus::stopped(&id);
    state.tunnel_status.lock().unwrap().insert(id, s.clone());
    let _ = app.emit(EV_TUNNEL, s);
    Ok(())
}

#[tauri::command]
pub fn tunnel_statuses(state: St) -> Vec<TunnelStatus> {
    let map = state.tunnel_status.lock().unwrap();
    let s = state.store.lock().unwrap();
    s.profiles.tunnels.iter().map(|t| map.get(&t.id).cloned().unwrap_or_else(|| TunnelStatus::stopped(&t.id))).collect()
}

#[tauri::command]
pub async fn port_available(bind_address: String, port: u16) -> bool {
    tunnel::port_available(&bind_address, port).await
}

// ───────────────────────────── sftp ─────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgress {
    transfer_id: String,
    bytes: u64,
    total: Option<u64>,
    done: bool,
    error: Option<String>,
}

fn sftp_get(state: &AppState, id: &str) -> Result<Arc<Sftp>> {
    state.sftp.lock().unwrap().get(id).cloned().ok_or_else(|| Error::NotFound("sftp session".into()))
}

#[tauri::command]
pub async fn sftp_open(app: AppHandle, state: St<'_>, host_id: String) -> Result<String> {
    let hops = hop_provider(app.clone(), host_id)()?;
    let conn = connect_chain(hops, ix(&app), false, &|_, _, _| {}).await?;
    let s = Sftp::open(conn).await?;
    let id = uuid::Uuid::new_v4().to_string();
    state.sftp.lock().unwrap().insert(id.clone(), Arc::new(s));
    Ok(id)
}

#[tauri::command]
pub async fn sftp_close(state: St<'_>, sftp_id: String) -> Result<()> {
    let s = state.sftp.lock().unwrap().remove(&sftp_id);
    if let Some(s) = s {
        let _ = s.session.close().await;
        s.conn.disconnect().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_list(state: St<'_>, sftp_id: String, path: String) -> Result<Vec<FileEntry>> {
    sftp_get(&state, &sftp_id)?.list(&path).await
}

#[tauri::command]
pub async fn sftp_home(state: St<'_>, sftp_id: String) -> Result<String> {
    sftp_get(&state, &sftp_id)?.home().await
}

#[tauri::command]
pub async fn sftp_mkdir(state: St<'_>, sftp_id: String, path: String) -> Result<()> {
    sftp_get(&state, &sftp_id)?.mkdir(&path).await
}

#[tauri::command]
pub async fn sftp_remove(state: St<'_>, sftp_id: String, path: String, is_dir: bool) -> Result<()> {
    sftp_get(&state, &sftp_id)?.remove(&path, is_dir).await
}

#[tauri::command]
pub async fn sftp_rename(state: St<'_>, sftp_id: String, from: String, to: String) -> Result<()> {
    sftp_get(&state, &sftp_id)?.rename(&from, &to).await
}

fn spawn_transfer(app: AppHandle, s: Arc<Sftp>, upload: bool, src: String, dst: String) -> String {
    let tid = uuid::Uuid::new_v4().to_string();
    let id = tid.clone();
    tauri::async_runtime::spawn(async move {
        let a2 = app.clone();
        let id2 = id.clone();
        let progress = move |bytes: u64, total: Option<u64>| {
            let _ = a2.emit(EV_SFTP, TransferProgress { transfer_id: id2.clone(), bytes, total, done: false, error: None });
        };
        let r = if upload {
            s.upload(&PathBuf::from(&src), &dst, &progress).await
        } else {
            s.download(&src, &PathBuf::from(&dst), &progress).await
        };
        let _ = app.emit(EV_SFTP, TransferProgress { transfer_id: id, bytes: 0, total: None, done: true, error: r.err().map(|e| e.to_string()) });
    });
    tid
}

#[tauri::command]
pub fn sftp_download(app: AppHandle, state: St, sftp_id: String, remote_path: String, local_path: String) -> Result<String> {
    let s = sftp_get(&state, &sftp_id)?;
    Ok(spawn_transfer(app, s, false, remote_path, local_path))
}

#[tauri::command]
pub fn sftp_upload(app: AppHandle, state: St, sftp_id: String, local_path: String, remote_path: String) -> Result<String> {
    let s = sftp_get(&state, &sftp_id)?;
    Ok(spawn_transfer(app, s, true, local_path, remote_path))
}

#[tauri::command]
pub fn local_list(path: String) -> Result<Vec<FileEntry>> {
    sftp::local_list(&PathBuf::from(path))
}

#[tauri::command]
pub fn local_home() -> Result<String> {
    dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).ok_or_else(|| Error::NotFound("home directory".into()))
}
