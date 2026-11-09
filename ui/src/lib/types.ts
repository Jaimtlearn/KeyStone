// IPC contract between the React UI and the Rust core.
// Rust mirrors these with #[serde(rename_all = "camelCase")]. Keep both sides in sync.
// Rule: secret values NEVER appear in these types except where explicitly noted
// (CredentialInput on write, credential_reveal on explicit user request).

export type Id = string;
export type Iso = string; // RFC3339 timestamp

// ───────────────────────────── Hosts & folders ─────────────────────────────

export type AuthMethod = "password" | "publicKey" | "agent";

export interface ProxyConfig {
  kind: "socks5" | "http";
  host: string;
  port: number;
  username: string | null;
  credentialId: Id | null; // password for the proxy, from the vault
}

export interface TerminalOverrides {
  fontFamily: string | null;
  fontSize: number | null;
  themeId: string | null;
  scrollback: number | null;
}

export interface Host {
  id: Id;
  name: string;
  hostname: string;
  port: number;
  username: string;
  auth: AuthMethod;
  /** Vault credential used for SSH auth (sshPassword or sshKey kind). */
  credentialId: Id | null;
  /** Optional private key file on disk (used when auth = publicKey and no vault key). */
  identityFile: string | null;
  folderId: Id | null;
  environment: string | null; // "production" | "staging" | "development" | custom
  project: string | null;
  tags: string[];
  description: string;
  favorite: boolean;
  color: string | null;
  /** Ordered list of host ids to hop through; [0] is the outermost bastion. */
  jumpChain: Id[];
  isBastion: boolean;
  connectTimeoutSecs: number;
  keepAliveSecs: number; // 0 = disabled
  keepAliveMaxMissed: number;
  proxy: ProxyConfig | null; // applies to the first hop only
  env: Record<string, string>;
  startupCommands: string[];
  agentForwarding: boolean; // requires explicit consent prompt per connection
  terminal: TerminalOverrides | null;
  createdAt: Iso;
  updatedAt: Iso;
  lastConnectedAt: Iso | null;
}

export interface Folder {
  id: Id;
  name: string;
  parentId: Id | null;
  color: string | null;
  icon: string | null;
  sortOrder: number;
}

// ───────────────────────────── Tunnels ─────────────────────────────

export type TunnelKind = "local" | "remote" | "dynamic";

export interface Tunnel {
  id: Id;
  name: string;
  hostId: Id;
  kind: TunnelKind;
  bindAddress: string; // e.g. 127.0.0.1
  bindPort: number;
  targetHost: string | null; // null for dynamic
  targetPort: number | null; // null for dynamic
  autoStart: boolean;
  autoReconnect: boolean;
}

export type TunnelState = "stopped" | "starting" | "running" | "reconnecting" | "error";

export interface TunnelStatus {
  id: Id;
  state: TunnelState;
  error: string | null;
  activeConnections: number;
  bytesIn: number;
  bytesOut: number;
  startedAt: Iso | null;
}

export interface StoreSnapshot {
  hosts: Host[];
  folders: Folder[];
  tunnels: Tunnel[];
}

// ───────────────────────────── Vault ─────────────────────────────

export type CredentialKind =
  | "sshKey"
  | "sshPassword"
  | "password"
  | "mysql"
  | "postgres"
  | "clickhouse"
  | "redis"
  | "apiToken"
  | "aws"
  | "kubernetes"
  | "secureNote";

/** What the UI sees. Secret field values are always null here. */
export interface CredentialFieldView {
  key: string;
  label: string;
  secret: boolean;
  value: string | null; // null for secret fields
  hasValue: boolean;
}

export interface CredentialSummary {
  id: Id;
  name: string;
  kind: CredentialKind;
  fields: CredentialFieldView[];
  hostIds: Id[]; // hosts this credential is associated with (reusable across hosts)
  tags: string[];
  expiresAt: Iso | null;
  createdAt: Iso;
  updatedAt: Iso;
  versionCount: number;
  /** zxcvbn score 0-4 of the primary password field, if any. */
  strength: number | null;
}

/** Write model. For updates, a secret field with value === null means "keep existing". */
export interface CredentialFieldInput {
  key: string;
  label: string;
  secret: boolean;
  value: string | null;
}

export interface CredentialInput {
  name: string;
  kind: CredentialKind;
  fields: CredentialFieldInput[];
  hostIds: Id[];
  tags: string[];
  expiresAt: Iso | null;
}

export interface CredentialVersion {
  version: number;
  createdAt: Iso;
  changedFields: string[];
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  autoLockSecs: number;
  osKeychainAvailable: boolean;
}

export interface PasswordOptions {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  excludeAmbiguous: boolean;
}

export interface PasswordStrength {
  score: number; // 0-4
  guessesLog10: number;
  crackTime: string;
  feedback: string[];
}

// ───────────────────────────── Sessions ─────────────────────────────

export type SessionStatus = "connecting" | "connected" | "reconnecting" | "closed" | "error";

/** Streamed over a Tauri Channel per session. `data` is base64-encoded bytes. */
export type TermEvent =
  | { type: "data"; data: string }
  | { type: "status"; status: SessionStatus; message: string | null }
  | { type: "hop"; index: number; total: number; name: string };

export interface HostKeyPrompt {
  requestId: Id;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string; // SHA256:...
  status: "unknown" | "changed";
  previousFingerprint: string | null;
}

export interface AgentForwardPrompt {
  requestId: Id;
  hostName: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

// ───────────────────────────── SFTP ─────────────────────────────

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: Iso | null;
  permissions: string | null; // e.g. "rwxr-xr-x"
}

export interface TransferProgress {
  transferId: Id;
  bytes: number;
  total: number | null;
  done: boolean;
  error: string | null;
}

// ───────────────────────────── Settings, themes, workspace ─────────────────────────────

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

export interface Theme {
  id: string;
  name: string;
  kind: "dark" | "light";
  builtin: boolean;
  ui: {
    bg: string;        // app background
    surface: string;   // panels
    surface2: string;  // raised / hover
    border: string;
    text: string;
    textMuted: string;
    accent: string;
    accentText: string;
    success: string;
    warning: string;
    danger: string;
  };
  terminal: TerminalPalette;
}

export type CursorStyle = "block" | "bar" | "underline";

export interface AppSettings {
  themeId: string;
  customThemes: Theme[];
  terminal: {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    cursorStyle: CursorStyle;
    cursorBlink: boolean;
    scrollback: number;
    copyOnSelect: boolean;
  };
  ui: {
    sidebarWidth: number;
    sidebarCollapsed: boolean;
    sidebarPosition: "left" | "right";
    density: "compact" | "comfortable";
    radius: number;        // px
    transparency: number;  // 0..1 window background alpha
    uiFontFamily: string;
    uiFontSize: number;
  };
  vault: {
    autoLockSecs: number;
    clipboardClearSecs: number;
  };
  sessions: {
    restoreOnLaunch: boolean;
    autoReconnect: boolean;
    loggingEnabled: boolean; // off by default: terminal output can contain secrets
    logDir: string | null;
  };
  keybindings: Record<string, string>; // action id -> accelerator, e.g. "palette.open": "Ctrl+K"
}

export type PaneTarget = { kind: "ssh"; hostId: Id } | { kind: "local"; shell: string | null } | { kind: "sftp"; hostId: Id };

export type PaneNode =
  | { type: "leaf"; id: Id; target: PaneTarget; title: string | null }
  | { type: "split"; id: Id; direction: "horizontal" | "vertical"; sizes: number[]; children: PaneNode[] };

export interface TabState {
  id: Id;
  title: string;
  layout: PaneNode;
}

export interface Workspace {
  tabs: TabState[];
  activeTabId: Id | null;
  activeProject: string | null;
  sidebarSection: string;
}
