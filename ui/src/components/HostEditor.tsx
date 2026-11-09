import { useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, FileKey2, KeyRound, Plus, Shield, Trash2, X } from "lucide-react";
import { Drawer, Field, Seg, Switch } from "./ui";
import { ConnectionChain } from "./ConnectionChain";
import { useApp } from "../store/app";
import { useData } from "../store/data";
import { blankHost, ENVIRONMENTS } from "../lib/defaults";
import { pickOpenPath } from "../lib/dialogs";
import { cx } from "../lib/format";
import type { AuthMethod, Host, ProxyConfig, Theme } from "../lib/types";
import { BUILTIN_THEMES } from "../theme/themes";

type Tab = "general" | "auth" | "route" | "advanced";

export function HostEditor() {
  const editor = useApp((s) => s.hostEditor);
  if (!editor) return null;
  return <HostEditorInner key={editor.hostId ?? "new"} hostId={editor.hostId} folderId={editor.preset?.folderId ?? null} />;
}

function HostEditorInner({ hostId, folderId }: { hostId: string | null; folderId: string | null }) {
  const close = useApp((s) => s.closeHostEditor);
  const hosts = useData((s) => s.hosts);
  const folders = useData((s) => s.folders);
  const creds = useData((s) => s.credentials);
  const vaultUnlocked = useData((s) => !!s.vault?.unlocked);
  const existing = hostId ? hosts.find((h) => h.id === hostId) : undefined;
  const [h, setH] = useState<Host>(() => (existing ? structuredClone(existing) : blankHost({ folderId })));
  const [tab, setTab] = useState<Tab>("general");
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  const set = <K extends keyof Host>(k: K, v: Host[K]) => setH((p) => ({ ...p, [k]: v }));

  const errors = {
    hostname: !h.hostname.trim() ? "Hostname is required" : null,
    port: !(h.port > 0 && h.port < 65536) ? "Port must be 1–65535" : null,
    username: !h.username.trim() ? "Username is required" : null,
    chain: h.jumpChain.includes(h.id) ? "A host cannot jump through itself" : null,
  };
  const valid = !Object.values(errors).some(Boolean);

  const projects = useMemo(() => [...new Set(hosts.map((x) => x.project).filter(Boolean) as string[])], [hosts]);
  const authCreds = creds.filter((c) => (h.auth === "password" ? c.kind === "sshPassword" || c.kind === "password" : c.kind === "sshKey"));
  const bastionCandidates = hosts.filter((x) => x.id !== h.id && !h.jumpChain.includes(x.id)).sort((a, b) => Number(b.isBastion) - Number(a.isBastion) || a.name.localeCompare(b.name));

  const save = async () => {
    setTouched(true);
    if (!valid) {
      setTab(errors.chain ? "route" : "general");
      return;
    }
    setSaving(true);
    const saved = await useData.getState().saveHost({ ...h, name: h.name.trim() || h.hostname.trim(), hostname: h.hostname.trim(), username: h.username.trim() });
    setSaving(false);
    if (saved) close();
  };

  const addTag = () => {
    const t = tagInput.trim().replace(/^#/, "");
    if (t && !h.tags.includes(t)) set("tags", [...h.tags, t]);
    setTagInput("");
  };

  const folderOptions = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const f of folders.filter((x) => x.parentId === parent).sort((a, b) => a.sortOrder - b.sortOrder)) {
        out.push({ id: f.id, label: `${"   ".repeat(depth)}${f.name}` });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [folders]);

  const envEntries = Object.entries(h.env);
  const setEnv = (entries: [string, string][]) => set("env", Object.fromEntries(entries));

  return (
    <Drawer
      title={existing ? `Edit ${existing.name}` : "New host"}
      subtitle={h.hostname ? `${h.username}@${h.hostname}:${h.port}` : "Connection profile — secrets live in the vault, not here"}
      onClose={close}
      tabs={
        <div className="drawer-tabs" role="tablist">
          {(["general", "auth", "route", "advanced"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={cx(tab === t && "on")} onClick={() => setTab(t)}>
              {t === "general" ? "General" : t === "auth" ? "Authentication" : t === "route" ? "Route" : "Advanced"}
              {t === "route" && h.jumpChain.length > 0 && <span className="faint"> · {h.jumpChain.length}</span>}
            </button>
          ))}
        </div>
      }
      footer={
        <>
          {touched && !valid && <span className="field-error grow">Fix the highlighted fields</span>}
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : existing ? "Save changes" : "Create host"}</button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="col" style={{ gap: 0 }}>
        {tab === "general" && (
          <>
            <div className="form-section">
              <div className="grid-3">
                <Field label="Hostname / IP" error={touched && errors.hostname}>
                  <input className={cx("input mono", touched && errors.hostname && "invalid")} autoFocus value={h.hostname} onChange={(e) => set("hostname", e.target.value)} placeholder="10.0.1.10 or host.example.com" />
                </Field>
                <Field label="Port" error={touched && errors.port}>
                  <input className={cx("input mono", touched && errors.port && "invalid")} type="number" min={1} max={65535} value={h.port} onChange={(e) => set("port", Number(e.target.value))} />
                </Field>
                <Field label="Username" error={touched && errors.username}>
                  <input className={cx("input mono", touched && errors.username && "invalid")} value={h.username} onChange={(e) => set("username", e.target.value)} />
                </Field>
              </div>
              <Field label="Display name" hint="Defaults to the hostname">
                <input className="input" value={h.name} onChange={(e) => set("name", e.target.value)} placeholder={h.hostname || "production-db-01"} />
              </Field>
            </div>
            <div className="form-section">
              <h4>Organization</h4>
              <div className="grid-2">
                <Field label="Folder">
                  <select className="select" value={h.folderId ?? ""} onChange={(e) => set("folderId", e.target.value || null)}>
                    <option value="">Unfiled</option>
                    {folderOptions.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                </Field>
                <Field label="Environment">
                  <input className="input" list="ks-envs" value={h.environment ?? ""} onChange={(e) => set("environment", e.target.value || null)} placeholder="production" />
                  <datalist id="ks-envs">{ENVIRONMENTS.map((e) => <option key={e} value={e} />)}</datalist>
                </Field>
                <Field label="Project">
                  <input className="input" list="ks-projects" value={h.project ?? ""} onChange={(e) => set("project", e.target.value || null)} placeholder="Project A" />
                  <datalist id="ks-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
                </Field>
                <Field label="Accent color" hint="Overrides the environment color on the card">
                  <div className="row">
                    <input type="color" value={h.color ?? "#6d8cff"} onChange={(e) => set("color", e.target.value)} />
                    {h.color && <button type="button" className="btn btn-ghost btn-sm" onClick={() => set("color", null)}>Reset</button>}
                  </div>
                </Field>
              </div>
              <Field label="Tags">
                <div className="row wrap" style={{ gap: 4 }}>
                  {h.tags.map((t) => (
                    <span key={t} className="chip">{t}<button type="button" onClick={() => set("tags", h.tags.filter((x) => x !== t))} aria-label={`Remove ${t}`}><X size={10} /></button></span>
                  ))}
                  <input
                    className="input"
                    style={{ width: 160, height: 26 }}
                    value={tagInput}
                    placeholder="Add tag…"
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(); }
                      if (e.key === "Backspace" && !tagInput && h.tags.length) set("tags", h.tags.slice(0, -1));
                    }}
                    onBlur={addTag}
                  />
                </div>
              </Field>
              <Field label="Description">
                <textarea className="textarea" style={{ fontFamily: "var(--font-ui)", minHeight: 64 }} value={h.description} onChange={(e) => set("description", e.target.value)} />
              </Field>
              <div className="switch-row">
                <div className="switch-text"><span>Favorite</span><span className="field-hint">Pinned at the top and in the sidebar</span></div>
                <Switch on={h.favorite} onChange={(v) => set("favorite", v)} />
              </div>
              <div className="switch-row">
                <div className="switch-text"><span>Use as bastion / jump host</span><span className="field-hint">Offered first when building routes for other hosts</span></div>
                <Switch on={h.isBastion} onChange={(v) => set("isBastion", v)} />
              </div>
            </div>
          </>
        )}

        {tab === "auth" && (
          <div className="form-section">
            <Field label="Method">
              <Seg<AuthMethod>
                value={h.auth}
                onChange={(v) => setH((p) => ({ ...p, auth: v, credentialId: null }))}
                options={[
                  { value: "publicKey", label: "Private key" },
                  { value: "password", label: "Password" },
                  { value: "agent", label: "SSH agent" },
                ]}
              />
            </Field>
            {h.auth === "agent" ? (
              <div className="callout info">
                <KeyRound size={16} />
                <div>Keys are taken from your running SSH agent (<span className="mono">ssh-agent</span>, Pageant, or the Windows OpenSSH agent). Keystone never sees the private key.</div>
              </div>
            ) : (
              <>
                <Field
                  label={h.auth === "password" ? "Password from vault" : "Key from vault"}
                  hint={!vaultUnlocked ? "Unlock the vault to choose a credential." : authCreds.length === 0 ? `No ${h.auth === "password" ? "password" : "SSH key"} credentials in the vault yet.` : "The secret stays in the vault; this profile only stores a reference."}
                >
                  <div className="row">
                    <select className="select" disabled={!vaultUnlocked} value={h.credentialId ?? ""} onChange={(e) => set("credentialId", e.target.value || null)}>
                      <option value="">{h.auth === "password" ? "Ask when connecting" : "None"}</option>
                      {!vaultUnlocked && h.credentialId && <option value={h.credentialId}>Linked credential (vault locked)</option>}
                      {authCreds.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button type="button" className="btn" disabled={!vaultUnlocked} onClick={() => useApp.getState().openCredentialEditor(null, h.id)}>
                      <Plus size={14} /> New
                    </button>
                  </div>
                </Field>
                {h.auth === "publicKey" && (
                  <Field label="Identity file" hint="Used when no vault key is selected. Passphrase-protected keys prompt or use a vault passphrase.">
                    <div className="row">
                      <input className="input mono" value={h.identityFile ?? ""} placeholder="~/.ssh/id_ed25519" onChange={(e) => set("identityFile", e.target.value || null)} />
                      <button type="button" className="btn" onClick={async () => { const p = await pickOpenPath({ title: "Choose private key" }); if (p) set("identityFile", p); }}>
                        <FileKey2 size={14} /> Browse
                      </button>
                    </div>
                  </Field>
                )}
              </>
            )}
          </div>
        )}

        {tab === "route" && (
          <>
            <div className="form-section">
              <h4>Connection route</h4>
              <div className="card panel-pad" style={{ overflowX: "auto" }}>
                <ConnectionChain host={h} />
              </div>
              {errors.chain && <span className="field-error">{errors.chain}</span>}
            </div>
            <div className="form-section">
              <h4>Jump hosts (ProxyJump)</h4>
              <span className="field-hint">Each hop authenticates with its own profile and credentials. The first entry is contacted directly; each following hop is reached through the previous one.</span>
              <div className="chain-builder">
                {h.jumpChain.map((id, i) => {
                  const j = hosts.find((x) => x.id === id);
                  return (
                    <div key={id + i} className="chain-builder-item">
                      <span className="idx">{i + 1}</span>
                      <Shield size={14} color="var(--warning)" />
                      <div className="grow">
                        <div>{j?.name ?? <span style={{ color: "var(--danger)" }}>Missing host</span>}</div>
                        {j && <div className="mono faint" style={{ fontSize: 11 }}>{j.username}@{j.hostname}:{j.port} · {j.auth}</div>}
                      </div>
                      <button type="button" className="btn btn-ghost btn-xs" disabled={i === 0} onClick={() => { const c = [...h.jumpChain]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; set("jumpChain", c); }} aria-label="Move up"><ArrowUp size={13} /></button>
                      <button type="button" className="btn btn-ghost btn-xs" disabled={i === h.jumpChain.length - 1} onClick={() => { const c = [...h.jumpChain]; [c[i + 1], c[i]] = [c[i], c[i + 1]]; set("jumpChain", c); }} aria-label="Move down"><ArrowDown size={13} /></button>
                      <button type="button" className="btn btn-ghost btn-xs" onClick={() => set("jumpChain", h.jumpChain.filter((_, k) => k !== i))} aria-label="Remove hop"><Trash2 size={13} /></button>
                    </div>
                  );
                })}
                <select className="select" value="" onChange={(e) => e.target.value && set("jumpChain", [...h.jumpChain, e.target.value])}>
                  <option value="">+ Add jump host…</option>
                  {bastionCandidates.map((b) => <option key={b.id} value={b.id}>{b.isBastion ? "🛡 " : ""}{b.name} — {b.hostname}</option>)}
                </select>
              </div>
            </div>
            <div className="form-section">
              <h4>Proxy (first hop)</h4>
              <div className="switch-row">
                <div className="switch-text"><span>Connect through a proxy</span><span className="field-hint">SOCKS5 or HTTP CONNECT, applied before the first SSH hop</span></div>
                <Switch on={!!h.proxy} onChange={(v) => set("proxy", v ? { kind: "socks5", host: "127.0.0.1", port: 1080, username: null, credentialId: null } : null)} />
              </div>
              {h.proxy && <ProxyFields proxy={h.proxy} onChange={(p) => set("proxy", p)} />}
            </div>
          </>
        )}

        {tab === "advanced" && (
          <>
            <div className="form-section">
              <h4>Connection</h4>
              <div className="grid-3">
                <Field label="Connect timeout (s)">
                  <input className="input" type="number" min={1} value={h.connectTimeoutSecs} onChange={(e) => set("connectTimeoutSecs", Number(e.target.value))} />
                </Field>
                <Field label="Keep-alive (s)" hint="0 disables">
                  <input className="input" type="number" min={0} value={h.keepAliveSecs} onChange={(e) => set("keepAliveSecs", Number(e.target.value))} />
                </Field>
                <Field label="Max missed">
                  <input className="input" type="number" min={1} value={h.keepAliveMaxMissed} onChange={(e) => set("keepAliveMaxMissed", Number(e.target.value))} />
                </Field>
              </div>
            </div>
            <div className="form-section">
              <h4>Environment variables</h4>
              <span className="field-hint">Sent with the session request. Many servers only accept variables listed in their AcceptEnv.</span>
              <div className="kv-table">
                {envEntries.map(([k, v], i) => (
                  <div key={i} className="kv-row">
                    <input className="input mono" value={k} placeholder="NAME" onChange={(e) => setEnv(envEntries.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
                    <input className="input mono" value={v} placeholder="value" onChange={(e) => setEnv(envEntries.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                    <button type="button" className="btn btn-ghost btn-icon" onClick={() => setEnv(envEntries.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 size={14} /></button>
                  </div>
                ))}
                <button type="button" className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setEnv([...envEntries, ["", ""]])}><Plus size={13} /> Add variable</button>
              </div>
            </div>
            <div className="form-section">
              <h4>Startup commands</h4>
              <Field hint="One per line, run after the shell starts. Don't put secrets here — use the vault.">
                <textarea className="textarea" value={h.startupCommands.join("\n")} onChange={(e) => set("startupCommands", e.target.value.split("\n"))} onBlur={() => set("startupCommands", h.startupCommands.filter((c) => c.trim()))} placeholder={"cd /srv/app\nsudo -i"} />
              </Field>
            </div>
            <div className="form-section">
              <h4>Agent forwarding</h4>
              <div className="switch-row">
                <div className="switch-text"><span>Allow agent forwarding</span><span className="field-hint">You will still be asked to confirm on each connection.</span></div>
                <Switch on={h.agentForwarding} onChange={(v) => set("agentForwarding", v)} />
              </div>
              {h.agentForwarding && (
                <div className="callout warning">
                  <AlertTriangle size={16} />
                  <div>Root on the remote host (or anything compromised there) can use your agent to log in elsewhere as you while connected. Prefer ProxyJump routes over agent forwarding where possible.</div>
                </div>
              )}
            </div>
            <div className="form-section">
              <h4>Terminal overrides</h4>
              <div className="switch-row">
                <div className="switch-text"><span>Customize terminal for this host</span><span className="field-hint">e.g. a red theme for production</span></div>
                <Switch on={!!h.terminal} onChange={(v) => set("terminal", v ? { fontFamily: null, fontSize: null, themeId: null, scrollback: null } : null)} />
              </div>
              {h.terminal && <TerminalOverrideFields host={h} onChange={(t) => set("terminal", t)} />}
            </div>
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Drawer>
  );
}

function ProxyFields({ proxy, onChange }: { proxy: ProxyConfig; onChange: (p: ProxyConfig) => void }) {
  const creds = useData((s) => s.credentials.filter((c) => c.kind === "password"));
  const unlocked = useData((s) => !!s.vault?.unlocked);
  return (
    <div className="grid-2">
      <Field label="Type">
        <Seg value={proxy.kind} onChange={(kind) => onChange({ ...proxy, kind })} options={[{ value: "socks5", label: "SOCKS5" }, { value: "http", label: "HTTP" }]} />
      </Field>
      <div />
      <Field label="Proxy host"><input className="input mono" value={proxy.host} onChange={(e) => onChange({ ...proxy, host: e.target.value })} /></Field>
      <Field label="Port"><input className="input mono" type="number" value={proxy.port} onChange={(e) => onChange({ ...proxy, port: Number(e.target.value) })} /></Field>
      <Field label="Username (optional)"><input className="input mono" value={proxy.username ?? ""} onChange={(e) => onChange({ ...proxy, username: e.target.value || null })} /></Field>
      <Field label="Password from vault">
        <select className="select" disabled={!unlocked} value={proxy.credentialId ?? ""} onChange={(e) => onChange({ ...proxy, credentialId: e.target.value || null })}>
          <option value="">None</option>
          {creds.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
    </div>
  );
}

function TerminalOverrideFields({ host, onChange }: { host: Host; onChange: (t: Host["terminal"]) => void }) {
  const settings = useApp((s) => s.settings);
  const t = host.terminal!;
  const themes = [...(settings.customThemes ?? [])];
  return (
    <div className="grid-2">
      <Field label="Theme">
        <select className="select" value={t.themeId ?? ""} onChange={(e) => onChange({ ...t, themeId: e.target.value || null })}>
          <option value="">Use app theme</option>
          <ThemeOptions extra={themes} />
        </select>
      </Field>
      <Field label="Font size">
        <input className="input" type="number" min={8} max={32} placeholder={String(settings.terminal.fontSize)} value={t.fontSize ?? ""} onChange={(e) => onChange({ ...t, fontSize: e.target.value ? Number(e.target.value) : null })} />
      </Field>
      <Field label="Font family">
        <input className="input" placeholder={settings.terminal.fontFamily} value={t.fontFamily ?? ""} onChange={(e) => onChange({ ...t, fontFamily: e.target.value || null })} />
      </Field>
      <Field label="Scrollback lines">
        <input className="input" type="number" min={0} placeholder={String(settings.terminal.scrollback)} value={t.scrollback ?? ""} onChange={(e) => onChange({ ...t, scrollback: e.target.value ? Number(e.target.value) : null })} />
      </Field>
    </div>
  );
}

function ThemeOptions({ extra }: { extra: Theme[] }) {
  return (
    <>
      {[...BUILTIN_THEMES, ...extra].map((th) => <option key={th.id} value={th.id}>{th.name}</option>)}
    </>
  );
}
