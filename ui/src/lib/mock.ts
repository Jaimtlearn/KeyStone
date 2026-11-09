// In-memory stand-in for the Rust backend, used when the UI runs in a plain browser
// (`npm run dev` without Tauri). It mirrors the command names/args of api.ts and follows
// the same secrecy rule: credential summaries never carry secret values.

import type {
  AppSettings, CredentialFieldInput, CredentialInput, CredentialSummary, CredentialVersion, FileEntry, Folder,
  Host, HostKeyPrompt, Id, PasswordOptions, StoreSnapshot, TermEvent, Tunnel, TunnelStatus, Workspace,
} from "./types";
import { blankHost, defaultSettings, newId } from "./defaults";

type Args = Record<string, any>;
type Listener = (payload: unknown) => void;

const listeners = new Map<string, Set<Listener>>();
function emit(event: string, payload: unknown) {
  listeners.get(event)?.forEach((l) => l(payload));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

// ─────────── seed data ───────────

const F = (id: string, name: string, parentId: string | null, sortOrder: number, color: string | null = null): Folder => ({
  id, name, parentId, color, icon: null, sortOrder,
});

const folders: Folder[] = [
  F("f-infra", "Infrastructure", null, 0),
  F("f-prod", "Production", "f-infra", 0, "#ff6b7a"),
  F("f-web", "Web Servers", "f-prod", 0),
  F("f-db", "Database Servers", "f-prod", 1),
  F("f-k8s", "Kubernetes Nodes", "f-prod", 2),
  F("f-stg", "Staging", "f-infra", 1, "#f2b85c"),
  F("f-dev", "Development", "f-infra", 2, "#4fd1a1"),
  F("f-projects", "Projects", null, 1),
  F("f-pa", "Project A", "f-projects", 0),
  F("f-pb", "Project B", "f-projects", 1),
];

const H = (p: Partial<Host>) => blankHost(p);
const hosts: Host[] = [
  H({ id: "h-bastion", name: "Production Bastion", hostname: "bastion.prod.example.net", username: "ops", folderId: "f-prod", environment: "production", isBastion: true, tags: ["bastion", "public"], favorite: true, credentialId: "c-opskey", lastConnectedAt: iso(42), description: "Public entry point for the production VPC." }),
  H({ id: "h-web1", name: "web-01", hostname: "10.0.1.10", username: "deploy", folderId: "f-web", environment: "production", project: "Project A", jumpChain: ["h-bastion"], tags: ["nginx", "app"], credentialId: "c-opskey", lastConnectedAt: iso(42) }),
  H({ id: "h-web2", name: "web-02", hostname: "10.0.1.11", username: "deploy", folderId: "f-web", environment: "production", project: "Project A", jumpChain: ["h-bastion"], tags: ["nginx", "app"], credentialId: "c-opskey", lastConnectedAt: iso(60 * 26) }),
  H({ id: "h-db1", name: "production-db-01", hostname: "10.0.2.20", username: "dba", folderId: "f-db", environment: "production", jumpChain: ["h-bastion"], tags: ["mysql", "primary"], favorite: true, credentialId: "c-opskey", lastConnectedAt: iso(60 * 3) }),
  H({ id: "h-db2", name: "production-db-02", hostname: "10.0.2.21", username: "dba", folderId: "f-db", environment: "production", jumpChain: ["h-bastion"], tags: ["postgres", "replica"], credentialId: "c-opskey" }),
  H({ id: "h-k8s-cp", name: "k8s-control-01", hostname: "10.0.3.5", username: "admin", folderId: "f-k8s", environment: "production", jumpChain: ["h-bastion"], tags: ["kubernetes", "control-plane"], credentialId: "c-opskey", lastConnectedAt: iso(60 * 24 * 4) }),
  H({ id: "h-k8s-w1", name: "k8s-worker-01", hostname: "10.0.3.11", username: "admin", folderId: "f-k8s", environment: "production", jumpChain: ["h-bastion"], tags: ["kubernetes"], credentialId: "c-opskey" }),
  H({ id: "h-stg1", name: "staging-server-01", hostname: "staging.example.net", username: "ubuntu", folderId: "f-stg", environment: "staging", project: "Project B", tags: ["redis", "app"], auth: "password", credentialId: "c-stgpw", lastConnectedAt: iso(15) }),
  H({ id: "h-stg-bastion", name: "Staging Jump", hostname: "jump.staging.example.net", port: 2222, username: "jump", folderId: "f-stg", environment: "staging", isBastion: true, tags: ["bastion"], auth: "agent" }),
  H({ id: "h-stg-int", name: "staging-worker", hostname: "172.16.4.8", username: "ubuntu", folderId: "f-stg", environment: "staging", jumpChain: ["h-bastion", "h-stg-bastion"], tags: ["worker"], auth: "agent", description: "Two-hop example: prod bastion → staging jump → worker." }),
  H({ id: "h-dev1", name: "dev-box", hostname: "dev.local", username: "me", folderId: "f-dev", environment: "development", tags: ["docker"], auth: "agent", favorite: true, lastConnectedAt: iso(5) }),
  H({ id: "h-pa-ci", name: "ci-runner", hostname: "ci.project-a.io", username: "runner", folderId: "f-pa", project: "Project A", environment: "development", tags: ["ci"], identityFile: "~/.ssh/id_ed25519" }),
  H({ id: "h-pb-api", name: "api-gateway", hostname: "api.project-b.io", port: 2200, username: "app", folderId: "f-pb", project: "Project B", environment: "staging", tags: ["api"], auth: "agent" }),
];

const tunnels: Tunnel[] = [
  { id: "t-mysql", name: "Prod MySQL", hostId: "h-bastion", kind: "local", bindAddress: "127.0.0.1", bindPort: 3307, targetHost: "10.0.2.20", targetPort: 3306, autoStart: false, autoReconnect: true },
  { id: "t-socks", name: "VPC SOCKS proxy", hostId: "h-bastion", kind: "dynamic", bindAddress: "127.0.0.1", bindPort: 1080, targetHost: null, targetPort: null, autoStart: false, autoReconnect: true },
  { id: "t-webhook", name: "Expose local webhook", hostId: "h-stg1", kind: "remote", bindAddress: "0.0.0.0", bindPort: 9000, targetHost: "127.0.0.1", targetPort: 3000, autoStart: false, autoReconnect: false },
];

const tunnelStatus = new Map<Id, TunnelStatus>();
for (const t of tunnels) tunnelStatus.set(t.id, idleStatus(t.id));
function idleStatus(id: Id): TunnelStatus {
  return { id, state: "stopped", error: null, activeConnections: 0, bytesIn: 0, bytesOut: 0, startedAt: null };
}

// Vault: metadata + secrets kept apart, like the real backend.
interface MockCred {
  summary: Omit<CredentialSummary, "fields" | "versionCount" | "strength">;
  fields: CredentialFieldInput[]; // full values incl. secrets
  history: { version: number; createdAt: string; changedFields: string[]; fields: CredentialFieldInput[] }[];
}

let vaultExists = true;
let vaultUnlocked = false;
let masterPassword = "keystone";
const creds = new Map<Id, MockCred>();

function seedCred(id: Id, name: string, kind: CredentialSummary["kind"], fields: [string, string, boolean, string][], hostIds: Id[], tags: string[] = [], expiresAt: string | null = null) {
  const f = fields.map(([key, label, secret, value]) => ({ key, label, secret, value }));
  creds.set(id, {
    summary: { id, name, kind, hostIds, tags, expiresAt, createdAt: iso(60 * 24 * 90), updatedAt: iso(60 * 24 * 7) },
    fields: f,
    history: [{ version: 1, createdAt: iso(60 * 24 * 90), changedFields: f.map((x) => x.key), fields: f }],
  });
}
seedCred("c-opskey", "ops@prod ed25519", "sshKey", [["username", "Username", false, "ops"], ["privateKey", "Private key", true, "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA...mock...\n-----END OPENSSH PRIVATE KEY-----"], ["passphrase", "Passphrase", true, "correct horse"], ["publicKey", "Public key", false, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMock ops@keystone"]], ["h-bastion", "h-web1", "h-web2", "h-db1", "h-db2", "h-k8s-cp", "h-k8s-w1"], ["prod"]);
seedCred("c-stgpw", "staging ubuntu", "sshPassword", [["username", "Username", false, "ubuntu"], ["password", "Password", true, "St4ging!pass"]], ["h-stg1"], [], new Date(Date.now() + 5 * 864e5).toISOString());
seedCred("c-mysql", "prod-db-01 MySQL root", "mysql", [["host", "Host", false, "10.0.2.20"], ["port", "Port", false, "3306"], ["database", "Database", false, "app"], ["username", "Username", false, "root"], ["password", "Password", true, "m7#Qx!9vLp$2"]], ["h-db1"], ["db"]);
seedCred("c-pg", "prod-db-01 Postgres", "postgres", [["host", "Host", false, "10.0.2.20"], ["port", "Port", false, "5432"], ["database", "Database", false, "analytics"], ["username", "Username", false, "analyst"], ["password", "Password", true, "pg-pass"]], ["h-db1"]);
seedCred("c-monitor", "Monitoring API token", "apiToken", [["url", "URL", false, "https://grafana.example.net"], ["token", "Token", true, "glsa_mock_token_123"]], ["h-db1"], [], iso(60 * 24 * 2));
seedCred("c-redis", "staging Redis", "redis", [["host", "Host", false, "127.0.0.1"], ["port", "Port", false, "6379"], ["username", "Username", false, "default"], ["password", "Password", true, "redis-pw"]], ["h-stg1"]);
seedCred("c-aws", "AWS ops (eu-west-1)", "aws", [["accessKeyId", "Access key ID", false, "AKIAMOCKMOCKMOCK"], ["secretAccessKey", "Secret access key", true, "wJalrXUtnFEMI/K7MDENG/bPxRfiCYMOCK"], ["region", "Region", false, "eu-west-1"], ["sessionToken", "Session token", true, ""]], [], ["cloud"]);
seedCred("c-kube", "prod cluster admin", "kubernetes", [["context", "Context", false, "prod-admin"], ["kubeconfig", "Kubeconfig", true, "apiVersion: v1\nkind: Config\n..."]], ["h-k8s-cp"]);
seedCred("c-note", "Break-glass procedure", "secureNote", [["note", "Note", true, "1. Call on-call lead\n2. ..."]], []);

function strengthOf(pw: string) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  if (pw.length < 6) score = 0;
  return Math.min(4, score);
}

function summarize(c: MockCred): CredentialSummary {
  const pw = c.fields.find((f) => f.secret && ["password", "passphrase", "token", "secretAccessKey"].includes(f.key));
  return {
    ...c.summary,
    fields: c.fields.map((f) => ({ key: f.key, label: f.label, secret: f.secret, value: f.secret ? null : f.value, hasValue: !!f.value })),
    versionCount: c.history.length,
    strength: pw?.value ? strengthOf(pw.value) : null,
  };
}

let settings: AppSettings = defaultSettings();
let workspace: Workspace | null = null;

function requireUnlocked() {
  if (!vaultUnlocked) throw new Error("Vault is locked");
}

// ─────────── terminals ───────────

interface MockSession {
  send: (e: TermEvent) => void;
  line: string;
  prompt: string;
  cleanup?: () => void;
}
const sessions = new Map<Id, MockSession>();

const enc = new TextEncoder();
function b64(s: string) {
  const bytes = enc.encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
const write = (s: MockSession, text: string) => s.send({ type: "data", data: b64(text) });

const pendingHostKey = new Map<Id, (accept: boolean) => void>();

async function openSession(onEvent: { onmessage: (e: TermEvent) => void }, host: Host | null): Promise<Id> {
  const id = newId();
  const send = (e: TermEvent) => onEvent.onmessage(e);
  const user = host?.username ?? "you";
  const name = host ? host.name.replace(/\s+/g, "-").toLowerCase() : "localhost";
  const s: MockSession = { send, line: "", prompt: `\x1b[38;5;111m${user}@${name}\x1b[0m:\x1b[38;5;150m~\x1b[0m$ ` };
  sessions.set(id, s);

  void (async () => {
    send({ type: "status", status: "connecting", message: null });
    if (host) {
      const chain = [...host.jumpChain.map((h) => hosts.find((x) => x.id === h)).filter(Boolean) as Host[], host];
      for (let i = 0; i < chain.length; i++) {
        send({ type: "hop", index: i, total: chain.length, name: chain[i].name });
        await sleep(350);
      }
      if (!host.lastConnectedAt) {
        const requestId = newId();
        const prompt: HostKeyPrompt = {
          requestId, host: host.hostname, port: host.port, keyType: "ssh-ed25519",
          fingerprint: "SHA256:q3Vz0mBk1sL6yU8pT2nRcXw4hJ9eA7fD5gK0iO1uPzM", status: "unknown", previousFingerprint: null,
        };
        const accepted = await new Promise<boolean>((resolve) => {
          pendingHostKey.set(requestId, resolve);
          emit("hostkey://prompt", prompt);
        });
        if (!accepted) {
          send({ type: "status", status: "error", message: "Host key rejected by user" });
          return;
        }
      }
      host.lastConnectedAt = new Date().toISOString();
    } else {
      await sleep(120);
    }
    send({ type: "status", status: "connected", message: null });
    if (host) {
      write(s, `\x1b[2mKeystone mock session — no real network connection.\x1b[0m\r\n`);
      write(s, `Welcome to Ubuntu 24.04 LTS (GNU/Linux 6.8.0 x86_64)\r\n\r\n`);
      for (const c of host.startupCommands) write(s, `${s.prompt}${c}\r\n`);
    } else {
      write(s, `\x1b[2mKeystone mock local shell. Type 'help'.\x1b[0m\r\n`);
    }
    write(s, s.prompt);
  })();
  return id;
}

function runCommand(s: MockSession, cmd: string) {
  const c = cmd.trim();
  const out = (t: string) => write(s, t.replace(/\n/g, "\r\n"));
  if (!c) return;
  switch (c.split(/\s+/)[0]) {
    case "help": out("Mock commands: ls, whoami, uptime, date, colors, clear, exit\n"); break;
    case "ls": out("\x1b[1;34mapps\x1b[0m  \x1b[1;34mbackups\x1b[0m  deploy.sh  docker-compose.yml  README.md\n"); break;
    case "whoami": out(s.prompt.match(/m(\w+)@/)?.[1] + "\n"); break;
    case "uptime": out(" 14:02:11 up 41 days,  3:12,  1 user,  load average: 0.21, 0.18, 0.11\n"); break;
    case "date": out(new Date().toString() + "\n"); break;
    case "clear": out("\x1b[2J\x1b[H"); break;
    case "colors": {
      let line = "";
      for (let i = 0; i < 16; i++) line += `\x1b[48;5;${i}m  \x1b[0m`;
      out(line + "\n");
      break;
    }
    case "exit": s.send({ type: "status", status: "closed", message: "Session ended" }); return;
    default: out(`${c.split(/\s+/)[0]}: command not found\n`);
  }
}

// ─────────── sftp ───────────

const mockFs: Record<string, FileEntry[]> = {};
function dirEntries(path: string, remote: boolean): FileEntry[] {
  const key = (remote ? "r:" : "l:") + path;
  if (!mockFs[key]) {
    const mk = (name: string, isDir: boolean, size = 0): FileEntry => ({
      name, path: (path.endsWith("/") ? path : path + "/") + name, isDir, isSymlink: false,
      size: isDir ? 4096 : size, modified: iso(Math.floor(Math.random() * 10000)), permissions: isDir ? "rwxr-xr-x" : "rw-r--r--",
    });
    mockFs[key] = remote
      ? [mk("apps", true), mk("backups", true), mk("logs", true), mk(".bashrc", false, 3771), mk("deploy.sh", false, 1290), mk("docker-compose.yml", false, 2210)]
      : [mk("Documents", true), mk("Downloads", true), mk("projects", true), mk("notes.md", false, 5120), mk("dump.sql", false, 48_211_002)];
  }
  return mockFs[key];
}

function simulateTransfer(total: number) {
  const transferId = newId();
  let bytes = 0;
  const timer = setInterval(() => {
    bytes = Math.min(total, bytes + Math.ceil(total / 12));
    const done = bytes >= total;
    emit("sftp://progress", { transferId, bytes, total, done, error: null });
    if (done) clearInterval(timer);
  }, 150);
  return transferId;
}

// ─────────── command table ───────────

const commands: Record<string, (a: Args) => unknown> = {
  store_load: (): StoreSnapshot => ({ hosts: structuredClone(hosts), folders: structuredClone(folders), tunnels: structuredClone(tunnels) }),
  host_save: ({ host }) => {
    const h = { ...(host as Host), updatedAt: new Date().toISOString() };
    const i = hosts.findIndex((x) => x.id === h.id);
    if (i >= 0) hosts[i] = h; else hosts.push(h);
    return structuredClone(h);
  },
  host_delete: ({ id }) => {
    const i = hosts.findIndex((x) => x.id === id);
    if (i >= 0) hosts.splice(i, 1);
    for (const h of hosts) h.jumpChain = h.jumpChain.filter((j) => j !== id);
  },
  host_duplicate: ({ id }) => {
    const src = hosts.find((x) => x.id === id);
    if (!src) throw new Error("Host not found");
    const h = { ...structuredClone(src), id: newId(), name: src.name + " (copy)", lastConnectedAt: null, favorite: false };
    hosts.push(h);
    return h;
  },
  folder_save: ({ folder }) => {
    const i = folders.findIndex((x) => x.id === folder.id);
    if (i >= 0) folders[i] = folder; else folders.push(folder);
    return folder;
  },
  folder_delete: ({ id }) => {
    const f = folders.find((x) => x.id === id);
    if (!f) return;
    for (const c of folders) if (c.parentId === id) c.parentId = f.parentId;
    for (const h of hosts) if (h.folderId === id) h.folderId = f.parentId;
    folders.splice(folders.indexOf(f), 1);
  },
  profiles_export: ({ hostIds }) => (hostIds ? hostIds.length : hosts.length),
  profiles_import: () => 0,
  ssh_config_import: () => {
    const h = blankHost({ name: "imported-from-ssh-config", hostname: "example.org", username: "me", auth: "agent", tags: ["imported"] });
    hosts.push(h);
    return 1;
  },
  tunnel_save: ({ tunnel }) => {
    const i = tunnels.findIndex((x) => x.id === tunnel.id);
    if (i >= 0) tunnels[i] = tunnel; else { tunnels.push(tunnel); tunnelStatus.set(tunnel.id, idleStatus(tunnel.id)); }
    return tunnel;
  },
  tunnel_delete: ({ id }) => {
    const i = tunnels.findIndex((x) => x.id === id);
    if (i >= 0) tunnels.splice(i, 1);
    tunnelStatus.delete(id);
  },

  settings_get: () => structuredClone(settings),
  settings_set: ({ settings: s }) => { settings = structuredClone(s); },
  workspace_get: () => (workspace ? structuredClone(workspace) : null),
  workspace_save: ({ workspace: w }) => { workspace = structuredClone(w); },

  vault_status: () => ({ exists: vaultExists, unlocked: vaultUnlocked, autoLockSecs: settings.vault.autoLockSecs, osKeychainAvailable: false }),
  vault_create: ({ masterPassword: pw }) => {
    if (vaultExists) throw new Error("Vault already exists");
    masterPassword = pw; vaultExists = true; vaultUnlocked = true;
  },
  vault_unlock: async ({ masterPassword: pw }) => {
    await sleep(400); // pretend Argon2id
    if (pw !== masterPassword) throw new Error("Incorrect master password");
    vaultUnlocked = true;
  },
  vault_lock: () => { vaultUnlocked = false; emit("vault://locked", null); },
  vault_touch: () => undefined,
  vault_change_password: ({ oldPassword, newPassword }) => {
    if (oldPassword !== masterPassword) throw new Error("Incorrect current password");
    masterPassword = newPassword;
  },
  vault_export_backup: () => { requireUnlocked(); },
  vault_import_backup: () => { requireUnlocked(); return 0; },
  credential_list: () => { requireUnlocked(); return [...creds.values()].map(summarize); },
  credential_create: ({ input }) => {
    requireUnlocked();
    const i = input as CredentialInput;
    const id = newId();
    const now = new Date().toISOString();
    const fields = i.fields.map((f) => ({ ...f, value: f.value ?? "" }));
    const c: MockCred = {
      summary: { id, name: i.name, kind: i.kind, hostIds: i.hostIds, tags: i.tags, expiresAt: i.expiresAt, createdAt: now, updatedAt: now },
      fields, history: [{ version: 1, createdAt: now, changedFields: fields.map((f) => f.key), fields }],
    };
    creds.set(id, c);
    return summarize(c);
  },
  credential_update: ({ id, input }) => {
    requireUnlocked();
    const c = creds.get(id);
    if (!c) throw new Error("Credential not found");
    const i = input as CredentialInput;
    const prev = new Map(c.fields.map((f) => [f.key, f]));
    const fields = i.fields.map((f) => ({ ...f, value: f.value === null ? prev.get(f.key)?.value ?? "" : f.value }));
    const changed = fields.filter((f) => prev.get(f.key)?.value !== f.value).map((f) => f.key);
    c.fields = fields;
    c.summary = { ...c.summary, name: i.name, kind: i.kind, hostIds: i.hostIds, tags: i.tags, expiresAt: i.expiresAt, updatedAt: new Date().toISOString() };
    if (changed.length) c.history.push({ version: c.history.length + 1, createdAt: c.summary.updatedAt, changedFields: changed, fields });
    return summarize(c);
  },
  credential_delete: ({ id }) => { requireUnlocked(); creds.delete(id); },
  credential_history: ({ id }): CredentialVersion[] => {
    requireUnlocked();
    return (creds.get(id)?.history ?? []).map(({ version, createdAt, changedFields }) => ({ version, createdAt, changedFields })).reverse();
  },
  credential_restore_version: ({ id, version }) => {
    requireUnlocked();
    const c = creds.get(id);
    const v = c?.history.find((h) => h.version === version);
    if (!c || !v) throw new Error("Version not found");
    c.fields = structuredClone(v.fields);
    c.history.push({ version: c.history.length + 1, createdAt: new Date().toISOString(), changedFields: [`restored v${version}`], fields: c.fields });
    return summarize(c);
  },
  credential_reveal: ({ id, fieldKey }) => {
    requireUnlocked();
    const f = creds.get(id)?.fields.find((x) => x.key === fieldKey);
    if (!f) throw new Error("Field not found");
    return f.value ?? "";
  },
  credential_copy: async ({ id, fieldKey }) => {
    requireUnlocked();
    const f = creds.get(id)?.fields.find((x) => x.key === fieldKey);
    if (!f) throw new Error("Field not found");
    // Browser fallback only; the real backend copies natively and the secret never reaches JS.
    try { await navigator.clipboard.writeText(f.value ?? ""); } catch { /* ignore */ }
    const secs = settings.vault.clipboardClearSecs;
    setTimeout(() => { navigator.clipboard.writeText("").catch(() => {}); emit("clipboard://cleared", null); }, secs * 1000);
    return secs;
  },
  password_generate: ({ options }) => {
    const o = options as PasswordOptions;
    let pool = "";
    if (o.lowercase) pool += "abcdefghijkmnopqrstuvwxyz" + (o.excludeAmbiguous ? "" : "l");
    if (o.uppercase) pool += "ABCDEFGHJKLMNPQRSTUVWXYZ" + (o.excludeAmbiguous ? "" : "IO");
    if (o.digits) pool += "23456789" + (o.excludeAmbiguous ? "" : "01");
    if (o.symbols) pool += "!@#$%^&*-_=+?";
    if (!pool) pool = "abcdefghijkmnopqrstuvwxyz";
    const buf = new Uint32Array(o.length);
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => pool[n % pool.length]).join("");
  },
  password_strength: ({ password }) => {
    const score = strengthOf(password);
    const labels = ["instant", "minutes", "hours", "years", "centuries"];
    return {
      score, guessesLog10: password.length * 1.2, crackTime: labels[score],
      feedback: score < 3 ? ["Use a longer password with mixed character types."] : [],
    };
  },

  ssh_open: ({ hostId, onEvent }) => {
    const host = hosts.find((h) => h.id === hostId);
    if (!host) throw new Error("Host not found");
    return openSession(onEvent, host);
  },
  local_open: ({ onEvent }) => openSession(onEvent, null),
  session_write: ({ sessionId, data }) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    for (const ch of data as string) {
      if (ch === "\r") {
        write(s, "\r\n");
        runCommand(s, s.line);
        s.line = "";
        if (sessions.has(sessionId)) write(s, s.prompt);
      } else if (ch === "\x7f") {
        if (s.line.length) { s.line = s.line.slice(0, -1); write(s, "\b \b"); }
      } else if (ch === "\x03") {
        write(s, "^C\r\n" + s.prompt); s.line = "";
      } else if (ch >= " ") {
        s.line += ch; write(s, ch);
      }
    }
  },
  session_resize: () => undefined,
  session_close: ({ sessionId }) => { sessions.delete(sessionId); },
  ssh_exec: () => ({ stdout: " 14:02:11 up 41 days, load average: 0.21, 0.18, 0.11\n", stderr: "", exitCode: 0 }),
  hostkey_respond: ({ requestId, accept }) => {
    pendingHostKey.get(requestId)?.(accept);
    pendingHostKey.delete(requestId);
  },
  agentfwd_respond: () => undefined,

  tunnel_start: async ({ id }) => {
    const set = (p: Partial<TunnelStatus>) => {
      const s = { ...(tunnelStatus.get(id) ?? idleStatus(id)), ...p };
      tunnelStatus.set(id, s);
      emit("tunnel://status", s);
    };
    set({ state: "starting", error: null });
    await sleep(600);
    const t = tunnels.find((x) => x.id === id);
    if (t?.bindPort === 9000 && t.kind === "remote") {
      set({ state: "error", error: "Remote server refused port forwarding (GatewayPorts no)" });
      return;
    }
    set({ state: "running", startedAt: new Date().toISOString(), activeConnections: 1 });
  },
  tunnel_stop: ({ id }) => {
    const s = idleStatus(id);
    tunnelStatus.set(id, s);
    emit("tunnel://status", s);
  },
  tunnel_statuses: () => {
    for (const s of tunnelStatus.values()) {
      if (s.state === "running") { s.bytesIn += Math.floor(Math.random() * 40_000); s.bytesOut += Math.floor(Math.random() * 9_000); }
    }
    return [...tunnelStatus.values()].map((s) => ({ ...s }));
  },
  port_available: ({ port }) => ![22, 80, 443, 3306, 5432, 1080].includes(port) &&
    !tunnels.some((t) => t.bindPort === port && tunnelStatus.get(t.id)?.state === "running"),

  sftp_open: async ({ hostId }) => { await sleep(300); return "sftp-" + hostId; },
  sftp_close: () => undefined,
  sftp_home: () => "/home/deploy",
  sftp_list: async ({ path }) => { await sleep(120); return structuredClone(dirEntries(path, true)); },
  sftp_mkdir: ({ path }) => {
    const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
    dirEntries(parent, true).push({ name: path.split("/").pop()!, path, isDir: true, isSymlink: false, size: 4096, modified: new Date().toISOString(), permissions: "rwxr-xr-x" });
  },
  sftp_remove: ({ path }) => {
    for (const k of Object.keys(mockFs)) mockFs[k] = mockFs[k].filter((e) => e.path !== path);
  },
  sftp_rename: ({ from, to }) => {
    for (const list of Object.values(mockFs)) for (const e of list) if (e.path === from) { e.path = to; e.name = to.split("/").pop()!; }
  },
  sftp_download: () => simulateTransfer(2_400_000),
  sftp_upload: () => simulateTransfer(5_100_000),
  local_list: async ({ path }) => structuredClone(dirEntries(path, false)),
  local_home: () => "/home/you",
};

export const mockBackend = {
  invoke: async <T,>(cmd: string, args: Args = {}): Promise<T> => {
    const fn = commands[cmd];
    if (!fn) throw new Error(`mock: unknown command ${cmd}`);
    await sleep(15);
    return (await fn(args)) as T;
  },
  channel: <T,>(onMessage: (m: T) => void) => ({ onmessage: onMessage }),
  listen: async <T,>(event: string, cb: (payload: T) => void) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    const l = cb as Listener;
    listeners.get(event)!.add(l);
    return () => listeners.get(event)?.delete(l);
  },
};
