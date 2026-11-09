import { useEffect, useState } from "react";
import { Check, Copy, Download, Info, KeyRound, Keyboard, Monitor, Palette, Plus, RotateCcw, Shield, TerminalSquare, Trash2, Upload, Layers } from "lucide-react";
import { useApp, toast, toastError } from "../store/app";
import { useData } from "../store/data";
import { Field, Kbd, Modal, Seg, STRENGTH_LABEL, StrengthMeter, Switch } from "../components/ui";
import { BUILTIN_THEMES, isTheme, TERMINAL_COLOR_KEYS, UI_COLOR_KEYS } from "../theme/themes";
import { allThemes } from "../theme/apply";
import { api, isTauri } from "../lib/api";
import { downloadText, pickOpenPath, pickSavePath, readTextFile } from "../lib/dialogs";
import { KEYBINDING_ACTIONS, defaultKeybindings, newId } from "../lib/defaults";
import { eventToAccelerator, normalizeAccelerator } from "../lib/keys";
import { cx } from "../lib/format";
import type { AppSettings, PasswordStrength, Theme } from "../lib/types";

type Section = "appearance" | "terminal" | "security" | "sessions" | "keys" | "about";

const SECTIONS: { id: Section; label: string; icon: typeof Palette }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "security", label: "Security & vault", icon: Shield },
  { id: "sessions", label: "Sessions", icon: Layers },
  { id: "keys", label: "Keyboard", icon: Keyboard },
  { id: "about", label: "About", icon: Info },
];

export function SettingsView() {
  const [section, setSection] = useState<Section>("appearance");
  return (
    <div className="view" style={{ flexDirection: "row" }}>
      <nav className="settings-nav">
        <div className="sidebar-title" style={{ padding: "0 8px 10px" }}>Settings</div>
        {SECTIONS.map((s) => (
          <div key={s.id} className={cx("tree-row", section === s.id && "active")} onClick={() => setSection(s.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setSection(s.id)}>
            <s.icon size={14} /> {s.label}
          </div>
        ))}
      </nav>
      <div className="settings-body">
        <div className="inner">
          {section === "appearance" && <Appearance />}
          {section === "terminal" && <TerminalSettings />}
          {section === "security" && <SecuritySettings />}
          {section === "sessions" && <SessionSettings />}
          {section === "keys" && <KeybindingSettings />}
          {section === "about" && <About />}
        </div>
      </div>
    </div>
  );
}

function useSettings() {
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const patch = <K extends keyof AppSettings>(k: K, v: Partial<AppSettings[K]>) =>
    update((s) => ({ ...s, [k]: typeof s[k] === "object" && !Array.isArray(s[k]) ? { ...(s[k] as object), ...(v as object) } : v }));
  return { settings, update, patch };
}

function Row({ title, desc, children }: { title: string; desc?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text"><span>{title}</span>{desc && <span className="muted">{desc}</span>}</div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

// ───────────────────────── appearance ─────────────────────────

function ThemePreview({ t }: { t: Theme }) {
  const p = t.terminal;
  return (
    <div className="theme-preview" style={{ background: t.ui.bg }}>
      <div className="tp-rail" style={{ background: t.ui.bg, borderRight: `1px solid ${t.ui.border}` }} />
      <div className="tp-side" style={{ background: t.ui.surface, borderRight: `1px solid ${t.ui.border}` }}>
        <i style={{ background: t.ui.accent, opacity: 1, width: "70%" }} />
        <i style={{ background: t.ui.textMuted }} />
        <i style={{ background: t.ui.textMuted, width: "80%" }} />
        <i style={{ background: t.ui.textMuted, width: "60%" }} />
      </div>
      <div className="tp-main" style={{ background: p.background, color: p.foreground }}>
        <div><span style={{ color: p.green }}>ops@web-01</span>:<span style={{ color: p.blue }}>~</span>$ ls</div>
        <div><span style={{ color: p.blue }}>apps</span> <span style={{ color: p.cyan }}>logs</span> <span style={{ color: p.yellow }}>run.sh</span></div>
        <div><span style={{ color: p.red }}>error</span> <span style={{ color: p.magenta }}>0x1f</span></div>
        <div>$ <span style={{ background: p.cursor, color: p.background }}>&nbsp;</span></div>
      </div>
    </div>
  );
}

function Appearance() {
  const { settings, update, patch } = useSettings();
  const themes = allThemes(settings);
  const [editing, setEditing] = useState<Theme | null>(null);

  const importTheme = async () => {
    const text = await readTextFile(".json");
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      if (!isTheme(parsed)) throw new Error("File is not a valid Keystone theme");
      const t: Theme = { ...parsed, id: `custom-${newId().slice(0, 8)}`, builtin: false };
      update((s) => ({ ...s, customThemes: [...s.customThemes, t], themeId: t.id }));
      toast({ kind: "success", title: `Imported theme “${t.name}”` });
    } catch (e) {
      toastError("Theme import failed", e);
    }
  };

  const ui = settings.ui;
  return (
    <>
      <section className="settings-group">
        <div className="row">
          <h3 className="grow" style={{ margin: 0, fontSize: 13 }}>Theme</h3>
          <button className="btn btn-sm" onClick={importTheme}><Upload size={13} /> Import</button>
        </div>
        <div className="theme-grid">
          {themes.map((t) => (
            <button
              key={t.id}
              className={cx("theme-card", settings.themeId === t.id && "on")}
              onClick={() => update((s) => ({ ...s, themeId: t.id }))}
              onDoubleClick={() => setEditing(structuredClone(t))}
            >
              <ThemePreview t={t} />
              <div className="theme-name">
                <span className="grow truncate">{t.name}</span>
                {!t.builtin && <span className="badge tone-info">custom</span>}
                {settings.themeId === t.id && <Check size={13} color="var(--accent)" />}
              </div>
            </button>
          ))}
        </div>
        <div className="row">
          <button className="btn btn-sm" onClick={() => {
            const base = themes.find((t) => t.id === settings.themeId) ?? BUILTIN_THEMES[0];
            setEditing({ ...structuredClone(base), id: `custom-${newId().slice(0, 8)}`, name: `${base.name} (custom)`, builtin: false });
          }}>
            <Copy size={13} /> Duplicate & customize current
          </button>
          <span className="faint" style={{ fontSize: 12 }}>Double-click a theme to edit it.</span>
        </div>
      </section>

      <section className="settings-group">
        <h3>Interface</h3>
        <div className="setting-stack">
          <Row title="Interface font"><input className="input" value={ui.uiFontFamily} onChange={(e) => patch("ui", { uiFontFamily: e.target.value })} /></Row>
          <Row title="Interface size" desc={`${ui.uiFontSize}px`}><input type="range" min={11} max={16} step={0.5} value={ui.uiFontSize} style={{ width: 220 }} onChange={(e) => patch("ui", { uiFontSize: Number(e.target.value) })} /></Row>
          <Row title="Density"><Seg value={ui.density} onChange={(v) => patch("ui", { density: v })} options={[{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }]} /></Row>
          <Row title="Corner radius" desc={`${ui.radius}px`}><input type="range" min={0} max={16} value={ui.radius} style={{ width: 220 }} onChange={(e) => patch("ui", { radius: Number(e.target.value) })} /></Row>
          <Row title="Window opacity" desc={isTauri ? `${Math.round(ui.transparency * 100)}% — requires a transparent window on your platform` : `${Math.round(ui.transparency * 100)}%`}>
            <input type="range" min={0.6} max={1} step={0.01} value={ui.transparency} style={{ width: 220 }} onChange={(e) => patch("ui", { transparency: Number(e.target.value) })} />
          </Row>
          <Row title="Sidebar position"><Seg value={ui.sidebarPosition} onChange={(v) => patch("ui", { sidebarPosition: v })} options={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }]} /></Row>
          <Row title="Show sidebar"><Switch on={!ui.sidebarCollapsed} onChange={(v) => patch("ui", { sidebarCollapsed: !v })} /></Row>
        </div>
      </section>
      {editing && <ThemeEditor theme={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ThemeEditor({ theme, onClose }: { theme: Theme; onClose: () => void }) {
  const { settings, update } = useSettings();
  const [t, setT] = useState<Theme>(theme);
  const [prevThemeId] = useState(settings.themeId);
  const builtin = theme.builtin;

  // Live preview: temporarily register the draft as the active theme.
  useEffect(() => {
    const draft: Theme = { ...t, id: "__draft__", builtin: false };
    useApp.setState((s) => ({ settings: { ...s.settings, customThemes: [...s.settings.customThemes.filter((x) => x.id !== "__draft__"), draft], themeId: "__draft__" } }));
  }, [t]);
  const restore = () =>
    useApp.setState((s) => ({ settings: { ...s.settings, customThemes: s.settings.customThemes.filter((x) => x.id !== "__draft__"), themeId: prevThemeId } }));

  const cancel = () => { restore(); onClose(); };
  const save = () => {
    restore();
    const final: Theme = builtin ? { ...t, id: `custom-${newId().slice(0, 8)}`, builtin: false, name: t.name === theme.name ? `${t.name} (custom)` : t.name } : { ...t, builtin: false };
    update((s) => ({
      ...s,
      customThemes: [...s.customThemes.filter((x) => x.id !== final.id && x.id !== "__draft__"), final],
      themeId: final.id,
    }));
    onClose();
  };
  const remove = () => {
    restore();
    update((s) => ({ ...s, customThemes: s.customThemes.filter((x) => x.id !== theme.id && x.id !== "__draft__"), themeId: s.themeId === theme.id ? "midnight" : s.themeId }));
    onClose();
  };
  const exportJson = () => downloadText(`${t.name.replace(/\W+/g, "-").toLowerCase()}.keystone-theme.json`, JSON.stringify({ ...t, builtin: false }, null, 2));

  const label = (k: string) => k.replace(/([A-Z0-9])/g, " $1").replace(/^./, (c) => c.toUpperCase());

  return (
    <Modal
      wide
      title={builtin ? `Customize ${theme.name}` : `Edit ${theme.name}`}
      icon={<Palette size={18} />}
      onClose={cancel}
      closeOnBackdrop={false}
      footer={
        <>
          {!builtin && <button className="btn btn-danger" onClick={remove}><Trash2 size={13} /> Delete</button>}
          <button className="btn" onClick={exportJson}><Download size={13} /> Export JSON</button>
          <span className="grow" />
          <button className="btn" onClick={cancel}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>{builtin ? "Save as new theme" : "Save theme"}</button>
        </>
      }
    >
      <div className="col" style={{ gap: 18 }}>
        <div className="grid-2">
          <Field label="Name"><input className="input" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field>
          <Field label="Base"><Seg value={t.kind} onChange={(kind) => setT({ ...t, kind })} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} /></Field>
        </div>
        <div>
          <div className="field-label" style={{ marginBottom: 8 }}>Interface colors</div>
          <div className="color-grid">
            {UI_COLOR_KEYS.map((k) => (
              <label key={k} className="color-field">
                <input type="color" value={toHex(t.ui[k])} onChange={(e) => setT({ ...t, ui: { ...t.ui, [k]: e.target.value } })} />
                {label(k)}
                <span className="mono">{t.ui[k]}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <div className="field-label" style={{ marginBottom: 8 }}>Terminal colors</div>
          <div className="color-grid">
            {TERMINAL_COLOR_KEYS.map((k) => (
              <label key={k} className="color-field">
                <input type="color" value={toHex(t.terminal[k])} onChange={(e) => setT({ ...t, terminal: { ...t.terminal, [k]: e.target.value } })} />
                {label(k)}
                <span className="mono">{t.terminal[k]}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="card" style={{ overflow: "hidden" }}><ThemePreview t={t} /></div>
      </div>
    </Modal>
  );
}

function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return "#" + c.slice(1).split("").map((x) => x + x).join("");
  if (/^#[0-9a-f]{8}$/i.test(c)) return c.slice(0, 7);
  return "#000000";
}

// ───────────────────────── terminal ─────────────────────────

function TerminalSettings() {
  const { settings, patch } = useSettings();
  const t = settings.terminal;
  return (
    <section className="settings-group">
      <h3>Terminal</h3>
      <div className="setting-stack">
        <Row title="Font family" desc="Any installed monospace font. JetBrains Mono is bundled."><input className="input" value={t.fontFamily} onChange={(e) => patch("terminal", { fontFamily: e.target.value })} /></Row>
        <Row title="Font size" desc={`${t.fontSize}px`}><input type="range" min={9} max={24} value={t.fontSize} style={{ width: 220 }} onChange={(e) => patch("terminal", { fontSize: Number(e.target.value) })} /></Row>
        <Row title="Line height" desc={t.lineHeight.toFixed(2)}><input type="range" min={1} max={1.8} step={0.05} value={t.lineHeight} style={{ width: 220 }} onChange={(e) => patch("terminal", { lineHeight: Number(e.target.value) })} /></Row>
        <Row title="Cursor style">
          <Seg value={t.cursorStyle} onChange={(v) => patch("terminal", { cursorStyle: v })} options={[{ value: "block", label: "█ Block" }, { value: "bar", label: "▏Bar" }, { value: "underline", label: "▁ Underline" }]} />
        </Row>
        <Row title="Blinking cursor"><Switch on={t.cursorBlink} onChange={(v) => patch("terminal", { cursorBlink: v })} /></Row>
        <Row title="Scrollback" desc="Lines kept in memory per terminal. Never written to disk.">
          <input className="input" type="number" min={0} max={200000} step={1000} value={t.scrollback} onChange={(e) => patch("terminal", { scrollback: Number(e.target.value) })} />
        </Row>
        <Row title="Copy on select"><Switch on={t.copyOnSelect} onChange={(v) => patch("terminal", { copyOnSelect: v })} /></Row>
      </div>
      <div className="card panel-pad mono" style={{ fontFamily: `${t.fontFamily}, monospace`, fontSize: t.fontSize, lineHeight: t.lineHeight, background: "var(--term-background)", color: "var(--term-foreground)" }}>
        <div><span style={{ color: "var(--term-green)" }}>deploy@web-01</span>:<span style={{ color: "var(--term-blue)" }}>/srv/app</span>$ systemctl status nginx</div>
        <div><span style={{ color: "var(--term-green)" }}>●</span> nginx.service — A high performance web server</div>
        <div>   Active: <span style={{ color: "var(--term-green)" }}>active (running)</span> since Mon 09:41:02 UTC</div>
        <div>0O lI1| {"{}"} [] =&gt; != === -&gt;</div>
      </div>
    </section>
  );
}

// ───────────────────────── security ─────────────────────────

const LOCK_OPTIONS = [
  { v: 60, l: "1 minute" }, { v: 300, l: "5 minutes" }, { v: 600, l: "10 minutes" }, { v: 1800, l: "30 minutes" }, { v: 3600, l: "1 hour" }, { v: 0, l: "Never (not recommended)" },
];

function SecuritySettings() {
  const { settings, patch } = useSettings();
  const vault = useData((s) => s.vault);
  const [changing, setChanging] = useState(false);
  const [backup, setBackup] = useState<"export" | "import" | null>(null);
  return (
    <>
      <section className="settings-group">
        <h3>Vault</h3>
        <div className="desc">Credentials are encrypted with XChaCha20-Poly1305 using a key derived from your master password with Argon2id. Secrets are decrypted only in the native backend.</div>
        <div className="setting-stack">
          <Row title="Status" desc={vault?.unlocked ? "Unlocked" : vault?.exists ? "Locked" : "Not created yet"}>
            <span className={`badge tone-${vault?.unlocked ? "success" : "neutral"}`}>{vault?.unlocked ? "unlocked" : "locked"}</span>
          </Row>
          <Row title="Auto-lock after inactivity">
            <select className="select" value={settings.vault.autoLockSecs} onChange={(e) => patch("vault", { autoLockSecs: Number(e.target.value) })}>
              {LOCK_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </Row>
          <Row title="Clear clipboard after" desc="Applies to secrets copied from the vault">
            <select className="select" value={settings.vault.clipboardClearSecs} onChange={(e) => patch("vault", { clipboardClearSecs: Number(e.target.value) })}>
              {[10, 20, 30, 45, 60, 120].map((s) => <option key={s} value={s}>{s} seconds</option>)}
            </select>
          </Row>
          <Row title="OS keychain" desc={vault?.osKeychainAvailable ? "Windows Credential Manager / Secret Service detected" : "Not available on this system"}>
            <span className={`badge tone-${vault?.osKeychainAvailable ? "success" : "neutral"}`}>{vault?.osKeychainAvailable ? "available" : "unavailable"}</span>
          </Row>
          <Row title="Master password">
            <button className="btn btn-sm" disabled={!vault?.exists} onClick={() => setChanging(true)}><KeyRound size={13} /> Change…</button>
          </Row>
        </div>
      </section>
      <section className="settings-group">
        <h3>Encrypted backups</h3>
        <div className="desc">Backups are re-encrypted with a separate export password, so they can be stored off-machine. Losing that password means losing the backup.</div>
        <div className="setting-stack">
          <Row title="Export vault backup"><button className="btn btn-sm" disabled={!vault?.unlocked} onClick={() => setBackup("export")}><Download size={13} /> Export…</button></Row>
          <Row title="Restore from backup"><button className="btn btn-sm" disabled={!vault?.unlocked} onClick={() => setBackup("import")}><Upload size={13} /> Import…</button></Row>
        </div>
        {!vault?.unlocked && <span className="field-hint">Unlock the vault to manage backups.</span>}
      </section>
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
      {backup && <BackupDialog mode={backup} onClose={() => setBackup(null)} />}
    </>
  );
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [oldPw, setOld] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [strength, setStrength] = useState<PasswordStrength | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!pw) return setStrength(null);
    const h = setTimeout(() => api.passwordStrength(pw).then(setStrength).catch(() => {}), 150);
    return () => clearTimeout(h);
  }, [pw]);
  const submit = async () => {
    setError(null);
    if (pw.length < 12 || (strength?.score ?? 0) < 3) return setError("Choose a stronger password (12+ characters, strength ≥ Strong).");
    if (pw !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    try {
      await api.vaultChangePassword(oldPw, pw);
      toast({ kind: "success", title: "Master password changed" });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Change master password" icon={<KeyRound size={18} />} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !oldPw || !pw} onClick={submit}>{busy ? "Re-encrypting…" : "Change password"}</button></>}>
      <form className="col" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Current password"><input className="input" type="password" autoFocus value={oldPw} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="New password" hint={strength ? <span className="row" style={{ gap: 8 }}><span style={{ width: 100 }}><StrengthMeter score={strength.score} /></span>{STRENGTH_LABEL[strength.score]}</span> : undefined}>
          <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password"><input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field>
        {error && <span className="field-error">{error}</span>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function BackupDialog({ mode, onClose }: { mode: "export" | "import"; onClose: () => void }) {
  const [path, setPath] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async () => {
    const p = mode === "export"
      ? await pickSavePath({ title: "Save encrypted backup", defaultPath: `keystone-vault-${new Date().toISOString().slice(0, 10)}.ksbackup`, filters: [{ name: "Keystone backup", extensions: ["ksbackup"] }] })
      : await pickOpenPath({ title: "Open encrypted backup", filters: [{ name: "Keystone backup", extensions: ["ksbackup"] }] });
    if (p) setPath(p);
  };
  const submit = async () => {
    setError(null);
    if (!path) return setError("Choose a file.");
    if (mode === "export" && pw.length < 12) return setError("Use at least 12 characters for the export password.");
    if (mode === "export" && pw !== confirm) return setError("Passwords don't match.");
    if (mode === "import" && importMode === "replace") {
      const ok = await useApp.getState().askConfirm({ title: "Replace the entire vault?", body: "All current items are removed and replaced by the backup contents.", confirmLabel: "Replace vault", danger: true });
      if (!ok) return;
    }
    setBusy(true);
    try {
      if (mode === "export") {
        await api.vaultExportBackup(path, pw);
        toast({ kind: "success", title: "Encrypted backup saved", detail: path });
      } else {
        const n = await api.vaultImportBackup(path, pw, importMode);
        await useData.getState().refreshCredentials();
        toast({ kind: "success", title: `Restored ${n} item${n === 1 ? "" : "s"}` });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={mode === "export" ? "Export encrypted backup" : "Restore from backup"} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? "Working…" : mode === "export" ? "Export" : "Restore"}</button></>}>
      <div className="col" style={{ gap: 12 }}>
        <Field label="File">
          <div className="row"><input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="Choose a file…" /><button className="btn" onClick={choose}>Browse…</button></div>
        </Field>
        <Field label={mode === "export" ? "Export password" : "Backup password"}><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
        {mode === "export" && <Field label="Confirm export password"><input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field>}
        {mode === "import" && (
          <Field label="Mode" hint={importMode === "merge" ? "Items with the same ID are updated; others are added." : "The current vault contents are discarded."}>
            <Seg value={importMode} onChange={setImportMode} options={[{ value: "merge", label: "Merge" }, { value: "replace", label: "Replace" }]} />
          </Field>
        )}
        {error && <span className="field-error">{error}</span>}
      </div>
    </Modal>
  );
}

// ───────────────────────── sessions ─────────────────────────

function SessionSettings() {
  const { settings, patch } = useSettings();
  const s = settings.sessions;
  return (
    <section className="settings-group">
      <h3>Sessions</h3>
      <div className="setting-stack">
        <Row title="Restore workspace on launch" desc="Reopen tabs, split layouts and the active project. Terminal output is never saved."><Switch on={s.restoreOnLaunch} onChange={(v) => patch("sessions", { restoreOnLaunch: v })} /></Row>
        <Row title="Reconnect restored sessions automatically" desc="When off, restored panes wait for you to click Connect."><Switch on={s.autoReconnect} onChange={(v) => patch("sessions", { autoReconnect: v })} /></Row>
      </div>
      <h3 style={{ marginTop: 12 }}>Session logging</h3>
      <div className="callout warning">
        <Shield size={16} />
        <div>Logs capture everything printed in the terminal — including passwords you type at prompts that echo, tokens in command output, and private data. Logging is <b>off by default</b>; enable it only if you need an audit trail, and keep the log folder protected.</div>
      </div>
      <div className="setting-stack">
        <Row title="Write session logs to disk"><Switch on={s.loggingEnabled} onChange={(v) => patch("sessions", { loggingEnabled: v })} /></Row>
        <Row title="Log folder" desc={s.logDir ?? "Default app data folder"}>
          <button className="btn btn-sm" disabled={!s.loggingEnabled} onClick={async () => { const p = await pickOpenPath({ title: "Choose log folder", directory: true }); if (p) patch("sessions", { logDir: p }); }}>Choose…</button>
        </Row>
      </div>
    </section>
  );
}

// ───────────────────────── keybindings ─────────────────────────

function KeybindingSettings() {
  const { settings, update } = useSettings();
  const [recording, setRecording] = useState<string | null>(null);
  const kb = settings.keybindings;

  useEffect(() => {
    if (!recording) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(null);
      if (e.key === "Backspace" || e.key === "Delete") {
        update((s) => ({ ...s, keybindings: { ...s.keybindings, [recording]: "" } }));
        return setRecording(null);
      }
      const acc = eventToAccelerator(e);
      if (!acc || !/[+]/.test(acc) && acc.length === 1) return; // require a modifier for plain characters
      update((s) => ({ ...s, keybindings: { ...s.keybindings, [recording]: acc } }));
      setRecording(null);
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [recording, update]);

  const conflicts = (id: string) => {
    const v = kb[id] && normalizeAccelerator(kb[id]);
    return !!v && Object.entries(kb).some(([k, b]) => k !== id && b && normalizeAccelerator(b) === v);
  };

  return (
    <section className="settings-group">
      <div className="row">
        <h3 className="grow" style={{ margin: 0, fontSize: 13 }}>Keyboard shortcuts</h3>
        <button className="btn btn-sm" onClick={() => update((s) => ({ ...s, keybindings: defaultKeybindings() }))}><RotateCcw size={13} /> Reset all</button>
      </div>
      <div className="desc">Click a shortcut, then press the new key combination. Backspace clears it, Escape cancels. Ctrl+Shift+C / Ctrl+Shift+V always copy and paste in terminals.</div>
      <div className="card">
        {KEYBINDING_ACTIONS.map((a) => (
          <div key={a.id} className="kb-row">
            <span className="grow">{a.label}</span>
            {conflicts(a.id) && <span className="badge tone-danger">conflict</span>}
            <button className={cx("kb-capture", recording === a.id && "recording", conflicts(a.id) && "conflict")} onClick={() => setRecording(a.id)}>
              {recording === a.id ? "Press keys…" : kb[a.id] ? <Kbd combo={kb[a.id]} /> : <span className="faint">Unassigned</span>}
            </button>
            <button className="btn btn-ghost btn-xs" title="Reset" disabled={kb[a.id] === a.default} onClick={() => update((s) => ({ ...s, keybindings: { ...s.keybindings, [a.id]: a.default } }))}><RotateCcw size={12} /></button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ───────────────────────── about ─────────────────────────

function About() {
  return (
    <section className="settings-group">
      <h3>Keystone</h3>
      <div className="card panel-pad col" style={{ gap: 8 }}>
        <div className="row"><Monitor size={14} className="muted" /> Runtime: {isTauri ? "Desktop (Tauri)" : "Browser preview — mock backend, no real connections or encryption"}</div>
        <div className="row"><Shield size={14} className="muted" /> Vault: Argon2id → XChaCha20-Poly1305, secrets decrypted only in the native process</div>
        <div className="row"><Plus size={14} className="muted" /> Profiles and settings store no secrets — only references to vault items</div>
      </div>
    </section>
  );
}
