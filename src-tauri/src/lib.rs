//! Keystone desktop shell. All logic lives in `keystone-core`; this crate wires it
//! to Tauri commands/events and owns process-level state.

mod commands;
mod state;

use state::AppState;
use tauri::Manager;

/// Release builds have no console, so a Rust panic would just close the window.
/// Append panics (message + location, never secrets) to `crash.log` in the data dir.
fn install_panic_log() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let dir = dirs::data_dir().map(|d| d.join("app.keystone.desktop"));
        if let Some(dir) = dir {
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("crash.log")) {
                use std::io::Write;
                let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                let thread = std::thread::current().name().unwrap_or("?").to_owned();
                let _ = writeln!(f, "[{ts}] panic on thread '{thread}': {info}");
            }
        }
        default_hook(info);
    }));
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn,keystone=info".into()))
        .init();

    install_panic_log();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let store = keystone_core::store::Store::open(&dir)?;
            let autostart: Vec<String> =
                store.profiles.tunnels.iter().filter(|t| t.auto_start).map(|t| t.id.clone()).collect();
            app.manage(AppState::new(store));
            state::spawn_auto_lock(app.handle().clone());
            // Auto-start tunnels that don't need the vault (agent / key-file auth).
            // Vault-backed ones will report "vault is locked" until started after unlock.
            // setup() is not inside the Tokio runtime; start tunnels from a runtime task.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                for id in autostart {
                    let _ = commands::start_tunnel(&handle, &id);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::store_load,
            commands::host_save,
            commands::host_delete,
            commands::host_duplicate,
            commands::folder_save,
            commands::folder_delete,
            commands::profiles_export,
            commands::profiles_import,
            commands::ssh_config_import,
            commands::tunnel_save,
            commands::tunnel_delete,
            commands::settings_get,
            commands::settings_set,
            commands::workspace_get,
            commands::workspace_save,
            commands::vault_status,
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_touch,
            commands::vault_change_password,
            commands::vault_export_backup,
            commands::vault_import_backup,
            commands::credential_list,
            commands::credential_create,
            commands::credential_update,
            commands::credential_delete,
            commands::credential_history,
            commands::credential_restore_version,
            commands::credential_reveal,
            commands::credential_copy,
            commands::password_generate,
            commands::password_strength,
            commands::ssh_open,
            commands::local_open,
            commands::session_write,
            commands::session_resize,
            commands::session_close,
            commands::ssh_exec,
            commands::hostkey_respond,
            commands::agentfwd_respond,
            commands::tunnel_start,
            commands::tunnel_stop,
            commands::tunnel_statuses,
            commands::port_available,
            commands::sftp_open,
            commands::sftp_close,
            commands::sftp_list,
            commands::sftp_home,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_download,
            commands::sftp_upload,
            commands::local_list,
            commands::local_home,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Keystone")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Drop (and zeroize) the vault key before the process exits.
                if let Some(st) = app.try_state::<AppState>() {
                    st.vault.lock().unwrap().take();
                }
            }
        });
}
