// Every backend call goes through here. Command names and argument names
// match the #[tauri::command] functions in src-tauri/src/commands.rs
// (Tauri converts camelCase JS args to snake_case Rust params).
//
// When running outside Tauri (plain `vite dev` in a browser), calls are routed to
// ./mock.ts so the UI can be developed without the native shell.

import type {
  AppSettings, CredentialInput, CredentialSummary, CredentialVersion, ExecResult,
  FileEntry, Folder, Host, Id, PasswordOptions, PasswordStrength, StoreSnapshot,
  TermEvent, TransferProgress, Tunnel, TunnelStatus, VaultStatus, Workspace,
} from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type ChannelLike<T> = { onmessage: (msg: T) => void };
type MakeChannel = <T>(onMessage: (msg: T) => void) => ChannelLike<T>;
type Listen = <T>(event: string, cb: (payload: T) => void) => Promise<() => void>;

let backend: Promise<{ invoke: Invoke; channel: MakeChannel; listen: Listen }> | null = null;

function getBackend() {
  if (!backend) {
    backend = isTauri
      ? Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]).then(([core, ev]) => ({
          invoke: core.invoke as Invoke,
          channel: (<T,>(onMessage: (m: T) => void) => {
            const ch = new core.Channel<T>();
            ch.onmessage = onMessage;
            return ch;
          }) as MakeChannel,
          listen: (async (event: string, cb: (p: unknown) => void) => ev.listen(event, (e) => cb(e.payload))) as Listen,
        }))
      : import("./mock").then((m) => m.mockBackend);
  }
  return backend;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const b = await getBackend();
  return b.invoke<T>(cmd, args);
}

export async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  const b = await getBackend();
  return b.listen<T>(event, cb);
}

// Global events emitted by the backend:
export const EVENTS = {
  vaultLocked: "vault://locked",              // payload: null
  hostKeyPrompt: "hostkey://prompt",           // payload: HostKeyPrompt
  agentForwardPrompt: "agentfwd://prompt",     // payload: AgentForwardPrompt
  tunnelStatus: "tunnel://status",             // payload: TunnelStatus
  transferProgress: "sftp://progress",         // payload: TransferProgress
  clipboardCleared: "clipboard://cleared",     // payload: null
} as const;

export const api = {
  // ── store (non-secret profile data) ──
  storeLoad: () => call<StoreSnapshot>("store_load"),
  hostSave: (host: Host) => call<Host>("host_save", { host }),
  hostDelete: (id: Id) => call<void>("host_delete", { id }),
  hostDuplicate: (id: Id) => call<Host>("host_duplicate", { id }),
  folderSave: (folder: Folder) => call<Folder>("folder_save", { folder }),
  folderDelete: (id: Id) => call<void>("folder_delete", { id }),
  profilesExport: (path: string, hostIds: Id[] | null) => call<number>("profiles_export", { path, hostIds }),
  profilesImport: (path: string) => call<number>("profiles_import", { path }),
  sshConfigImport: (path: string | null) => call<number>("ssh_config_import", { path }),
  tunnelSave: (tunnel: Tunnel) => call<Tunnel>("tunnel_save", { tunnel }),
  tunnelDelete: (id: Id) => call<void>("tunnel_delete", { id }),

  // ── settings & workspace ──
  settingsGet: () => call<AppSettings>("settings_get"),
  settingsSet: (settings: AppSettings) => call<void>("settings_set", { settings }),
  workspaceGet: () => call<Workspace | null>("workspace_get"),
  workspaceSave: (workspace: Workspace) => call<void>("workspace_save", { workspace }),

  // ── vault ──
  vaultStatus: () => call<VaultStatus>("vault_status"),
  vaultCreate: (masterPassword: string) => call<void>("vault_create", { masterPassword }),
  vaultUnlock: (masterPassword: string) => call<void>("vault_unlock", { masterPassword }),
  vaultLock: () => call<void>("vault_lock"),
  vaultTouch: () => call<void>("vault_touch"),
  vaultChangePassword: (oldPassword: string, newPassword: string) =>
    call<void>("vault_change_password", { oldPassword, newPassword }),
  vaultExportBackup: (path: string, exportPassword: string) => call<void>("vault_export_backup", { path, exportPassword }),
  vaultImportBackup: (path: string, password: string, mode: "merge" | "replace") =>
    call<number>("vault_import_backup", { path, password, mode }),
  credentialList: () => call<CredentialSummary[]>("credential_list"),
  credentialCreate: (input: CredentialInput) => call<CredentialSummary>("credential_create", { input }),
  credentialUpdate: (id: Id, input: CredentialInput) => call<CredentialSummary>("credential_update", { id, input }),
  credentialDelete: (id: Id) => call<void>("credential_delete", { id }),
  credentialHistory: (id: Id) => call<CredentialVersion[]>("credential_history", { id }),
  credentialRestoreVersion: (id: Id, version: number) => call<CredentialSummary>("credential_restore_version", { id, version }),
  /** Explicit user action only (eye icon). Value is shown, never stored in UI state longer than needed. */
  credentialReveal: (id: Id, fieldKey: string) => call<string>("credential_reveal", { id, fieldKey }),
  /** Copies in the backend; the secret never crosses into JS. Returns seconds until auto-clear. */
  credentialCopy: (id: Id, fieldKey: string) => call<number>("credential_copy", { id, fieldKey }),
  passwordGenerate: (options: PasswordOptions) => call<string>("password_generate", { options }),
  passwordStrength: (password: string) => call<PasswordStrength>("password_strength", { password }),

  // ── terminal sessions ──
  sshOpen: async (hostId: Id, cols: number, rows: number, onEvent: (e: TermEvent) => void) => {
    const b = await getBackend();
    return b.invoke<Id>("ssh_open", { hostId, cols, rows, onEvent: b.channel(onEvent) });
  },
  localOpen: async (shell: string | null, cols: number, rows: number, onEvent: (e: TermEvent) => void) => {
    const b = await getBackend();
    return b.invoke<Id>("local_open", { shell, cols, rows, onEvent: b.channel(onEvent) });
  },
  sessionWrite: (sessionId: Id, data: string) => call<void>("session_write", { sessionId, data }),
  sessionResize: (sessionId: Id, cols: number, rows: number) => call<void>("session_resize", { sessionId, cols, rows }),
  sessionClose: (sessionId: Id) => call<void>("session_close", { sessionId }),
  sshExec: (hostId: Id, command: string) => call<ExecResult>("ssh_exec", { hostId, command }),
  hostKeyRespond: (requestId: Id, accept: boolean) => call<void>("hostkey_respond", { requestId, accept }),
  agentForwardRespond: (requestId: Id, allow: boolean) => call<void>("agentfwd_respond", { requestId, allow }),

  // ── tunnels ──
  tunnelStart: (id: Id) => call<void>("tunnel_start", { id }),
  tunnelStop: (id: Id) => call<void>("tunnel_stop", { id }),
  tunnelStatuses: () => call<TunnelStatus[]>("tunnel_statuses"),
  portAvailable: (bindAddress: string, port: number) => call<boolean>("port_available", { bindAddress, port }),

  // ── sftp ──
  sftpOpen: (hostId: Id) => call<Id>("sftp_open", { hostId }),
  sftpClose: (sftpId: Id) => call<void>("sftp_close", { sftpId }),
  sftpList: (sftpId: Id, path: string) => call<FileEntry[]>("sftp_list", { sftpId, path }),
  sftpHome: (sftpId: Id) => call<string>("sftp_home", { sftpId }),
  sftpMkdir: (sftpId: Id, path: string) => call<void>("sftp_mkdir", { sftpId, path }),
  sftpRemove: (sftpId: Id, path: string, isDir: boolean) => call<void>("sftp_remove", { sftpId, path, isDir }),
  sftpRename: (sftpId: Id, from: string, to: string) => call<void>("sftp_rename", { sftpId, from, to }),
  /** Returns transferId; progress arrives via EVENTS.transferProgress. */
  sftpDownload: (sftpId: Id, remotePath: string, localPath: string) =>
    call<Id>("sftp_download", { sftpId, remotePath, localPath }),
  sftpUpload: (sftpId: Id, localPath: string, remotePath: string) =>
    call<Id>("sftp_upload", { sftpId, localPath, remotePath }),
  localList: (path: string) => call<FileEntry[]>("local_list", { path }),
  localHome: () => call<string>("local_home"),
};

export type { TransferProgress };
