import type { AppSettings, CredentialFieldInput, CredentialKind, Host, Id } from "./types";

export const KEYBINDING_ACTIONS: { id: string; label: string; default: string }[] = [
  { id: "palette.open", label: "Open command palette", default: "Ctrl+K" },
  { id: "search.global", label: "Search everything", default: "Ctrl+P" },
  { id: "terminal.newLocal", label: "New local terminal", default: "Ctrl+Shift+T" },
  { id: "tab.close", label: "Close pane / tab", default: "Ctrl+Shift+W" },
  { id: "tab.next", label: "Next tab", default: "Ctrl+Tab" },
  { id: "tab.prev", label: "Previous tab", default: "Ctrl+Shift+Tab" },
  { id: "pane.splitRight", label: "Split pane right", default: "Ctrl+Shift+D" },
  { id: "pane.splitDown", label: "Split pane down", default: "Ctrl+Shift+E" },
  { id: "pane.fullscreen", label: "Toggle pane fullscreen", default: "Ctrl+Shift+Enter" },
  { id: "terminal.search", label: "Find in terminal", default: "Ctrl+Shift+F" },
  { id: "host.new", label: "New host", default: "Ctrl+N" },
  { id: "vault.lock", label: "Lock vault", default: "Ctrl+Shift+L" },
  { id: "sidebar.toggle", label: "Toggle sidebar", default: "Ctrl+B" },
  { id: "view.hosts", label: "Go to Hosts", default: "Ctrl+1" },
  { id: "view.vault", label: "Go to Vault", default: "Ctrl+2" },
  { id: "view.tunnels", label: "Go to Tunnels", default: "Ctrl+3" },
  { id: "view.files", label: "Go to Files", default: "Ctrl+4" },
  { id: "view.settings", label: "Open Settings", default: "Ctrl+," },
];

export function defaultKeybindings(): Record<string, string> {
  return Object.fromEntries(KEYBINDING_ACTIONS.map((a) => [a.id, a.default]));
}

export function defaultSettings(): AppSettings {
  return {
    themeId: "midnight",
    customThemes: [],
    terminal: {
      fontFamily: "JetBrains Mono",
      fontSize: 13,
      lineHeight: 1.25,
      cursorStyle: "bar",
      cursorBlink: true,
      scrollback: 10000,
      copyOnSelect: false,
    },
    ui: {
      sidebarWidth: 264,
      sidebarCollapsed: false,
      sidebarPosition: "left",
      density: "comfortable",
      radius: 8,
      transparency: 1,
      uiFontFamily: "Inter Variable",
      uiFontSize: 13,
    },
    vault: { autoLockSecs: 600, clipboardClearSecs: 20 },
    sessions: { restoreOnLaunch: true, autoReconnect: true, loggingEnabled: false, logDir: null },
    keybindings: defaultKeybindings(),
  };
}

export function newId(): Id {
  return crypto.randomUUID();
}

export function blankHost(partial: Partial<Host> = {}): Host {
  const now = new Date().toISOString();
  return {
    id: newId(),
    name: "",
    hostname: "",
    port: 22,
    username: "root",
    auth: "publicKey",
    credentialId: null,
    identityFile: null,
    folderId: null,
    environment: null,
    project: null,
    tags: [],
    description: "",
    favorite: false,
    color: null,
    jumpChain: [],
    isBastion: false,
    connectTimeoutSecs: 15,
    keepAliveSecs: 30,
    keepAliveMaxMissed: 3,
    proxy: null,
    env: {},
    startupCommands: [],
    agentForwarding: false,
    terminal: null,
    createdAt: now,
    updatedAt: now,
    lastConnectedAt: null,
    ...partial,
  };
}

type Tpl = { key: string; label: string; secret: boolean; multiline?: boolean; placeholder?: string };

export const CREDENTIAL_KINDS: { kind: CredentialKind; label: string; fields: Tpl[] }[] = [
  {
    kind: "sshKey",
    label: "SSH Key",
    fields: [
      { key: "username", label: "Username", secret: false },
      { key: "privateKey", label: "Private key", secret: true, multiline: true, placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----" },
      { key: "passphrase", label: "Passphrase", secret: true },
      { key: "publicKey", label: "Public key", secret: false, multiline: true },
    ],
  },
  { kind: "sshPassword", label: "SSH Password", fields: [{ key: "username", label: "Username", secret: false }, { key: "password", label: "Password", secret: true }] },
  { kind: "password", label: "Password", fields: [{ key: "username", label: "Username", secret: false }, { key: "password", label: "Password", secret: true }, { key: "url", label: "URL", secret: false }] },
  ...(["mysql", "postgres", "clickhouse"] as const).map((kind) => ({
    kind,
    label: kind === "mysql" ? "MySQL" : kind === "postgres" ? "PostgreSQL" : "ClickHouse",
    fields: [
      { key: "host", label: "Host", secret: false },
      { key: "port", label: "Port", secret: false, placeholder: kind === "mysql" ? "3306" : kind === "postgres" ? "5432" : "9000" },
      { key: "database", label: "Database", secret: false },
      { key: "username", label: "Username", secret: false },
      { key: "password", label: "Password", secret: true },
    ],
  })),
  {
    kind: "redis",
    label: "Redis",
    fields: [
      { key: "host", label: "Host", secret: false },
      { key: "port", label: "Port", secret: false, placeholder: "6379" },
      { key: "username", label: "Username", secret: false },
      { key: "password", label: "Password", secret: true },
    ],
  },
  { kind: "apiToken", label: "API Token", fields: [{ key: "url", label: "URL", secret: false }, { key: "token", label: "Token", secret: true }] },
  {
    kind: "aws",
    label: "AWS",
    fields: [
      { key: "accessKeyId", label: "Access key ID", secret: false },
      { key: "secretAccessKey", label: "Secret access key", secret: true },
      { key: "region", label: "Region", secret: false, placeholder: "eu-west-1" },
      { key: "sessionToken", label: "Session token", secret: true },
    ],
  },
  { kind: "kubernetes", label: "Kubernetes", fields: [{ key: "context", label: "Context", secret: false }, { key: "kubeconfig", label: "Kubeconfig", secret: true, multiline: true }] },
  { kind: "secureNote", label: "Secure Note", fields: [{ key: "note", label: "Note", secret: true, multiline: true }] },
];

export function kindMeta(kind: CredentialKind) {
  return CREDENTIAL_KINDS.find((k) => k.kind === kind) ?? CREDENTIAL_KINDS[0];
}

export function templateFields(kind: CredentialKind): CredentialFieldInput[] {
  return kindMeta(kind).fields.map((f) => ({ key: f.key, label: f.label, secret: f.secret, value: f.secret ? null : "" }));
}

export const ENVIRONMENTS = ["production", "staging", "development", "testing"];
