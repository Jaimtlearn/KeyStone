import { useEffect, useMemo, useRef, useState } from "react";
import {
  Copy, Eye, EyeOff, History, KeyRound, Lock, Pencil, Plus, Search, Server, ShieldCheck, Trash2, CalendarClock, RotateCcw, Tag,
} from "lucide-react";
import { api } from "../lib/api";
import { useData } from "../store/data";
import { toastError, useApp } from "../store/app";
import { useVaultFilter } from "../store/vaultFilter";
import { CredIcon } from "../components/icons";
import { Empty, STRENGTH_LABEL, StrengthMeter } from "../components/ui";
import { openContextMenu } from "../components/ContextMenu";
import { copySecret, connectHost, lockVault } from "../lib/actions";
import { CREDENTIAL_KINDS, kindMeta } from "../lib/defaults";
import { cx, expiryState, relativeTime } from "../lib/format";
import type { CredentialSummary, CredentialVersion, PasswordStrength } from "../lib/types";

export function VaultView() {
  const vault = useData((s) => s.vault);
  if (!vault) return <div className="lock-screen"><div className="spinner" /></div>;
  if (!vault.unlocked) return <LockScreen exists={vault.exists} />;
  return <VaultBrowser />;
}

// ───────────────────────── lock screen ─────────────────────────

function LockScreen({ exists }: { exists: boolean }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [strength, setStrength] = useState<PasswordStrength | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (exists || !pw) return setStrength(null);
    const h = setTimeout(() => api.passwordStrength(pw).then(setStrength).catch(() => {}), 150);
    return () => clearTimeout(h);
  }, [pw, exists]);

  const fail = (msg: string) => {
    setError(msg);
    setShake(true);
    setTimeout(() => setShake(false), 400);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!exists) {
      if (pw.length < 12) return fail("Use at least 12 characters.");
      if ((strength?.score ?? 0) < 3) return fail("Choose a stronger master password — it is the only thing protecting a stolen vault file.");
      if (pw !== confirm) return fail("Passwords don't match.");
    }
    setBusy(true);
    try {
      if (exists) await api.vaultUnlock(pw);
      else await api.vaultCreate(pw);
      setPw("");
      setConfirm("");
      await useData.getState().refreshVault();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock-screen">
      <form className={cx("lock-card", shake && "shake")} onSubmit={submit}>
        <div className="lock-emblem">{exists ? <Lock size={26} /> : <ShieldCheck size={26} />}</div>
        <h2>{exists ? "Vault locked" : "Create your vault"}</h2>
        <p>
          {exists
            ? "Enter your master password to decrypt credentials."
            : "Your master password derives the encryption key (Argon2id). It is never stored and cannot be recovered."}
        </p>
        <div className="input-wrap">
          <KeyRound size={14} />
          <input
            className="input"
            type={show ? "text" : "password"}
            autoFocus
            placeholder="Master password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoComplete={exists ? "current-password" : "new-password"}
            style={{ height: 40 }}
          />
          <span className="input-suffix">
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setShow(!show)} aria-label={show ? "Hide" : "Show"}>
              {show ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </span>
        </div>
        {!exists && (
          <>
            <div className="col" style={{ gap: 6 }}>
              <StrengthMeter score={strength?.score ?? null} />
              <span className="field-hint">{strength ? `${STRENGTH_LABEL[strength.score]} · offline crack time ≈ ${strength.crackTime}` : "A long passphrase of random words works well."}</span>
              {strength?.feedback.map((f, i) => <span key={i} className="field-hint">{f}</span>)}
            </div>
            <input className="input" type={show ? "text" : "password"} placeholder="Confirm master password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" style={{ height: 40 }} />
          </>
        )}
        {error && <span className="field-error" role="alert">{error}</span>}
        <button className="btn btn-primary" style={{ height: 40 }} disabled={busy || !pw}>
          {busy ? <><span className="spinner" style={{ borderTopColor: "var(--accent-text)" }} /> {exists ? "Deriving key…" : "Creating…"}</> : exists ? "Unlock" : "Create vault"}
        </button>
      </form>
    </div>
  );
}

// ───────────────────────── browser ─────────────────────────

function VaultBrowser() {
  const creds = useData((s) => s.credentials);
  const { kind, expiring, query, setQuery, selectedId, select } = useVaultFilter();
  const openEditor = useApp((s) => s.openCredentialEditor);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return creds
      .filter((c) => (!kind || c.kind === kind) && (!expiring || (c.expiresAt && expiryState(c.expiresAt) !== "ok")))
      .filter((c) => !q || [c.name, c.kind, ...c.tags, ...c.fields.filter((f) => !f.secret).map((f) => f.value ?? "")].join(" ").toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [creds, kind, expiring, query]);

  const grouped = useMemo(() => {
    const out: { kind: CredentialSummary["kind"]; label: string; items: CredentialSummary[] }[] = [];
    for (const k of CREDENTIAL_KINDS) {
      const items = filtered.filter((c) => c.kind === k.kind);
      if (items.length) out.push({ kind: k.kind, label: k.label, items });
    }
    return out;
  }, [filtered]);

  const selected = creds.find((c) => c.id === selectedId) ?? filtered[0] ?? null;

  return (
    <div className="view" style={{ flexDirection: "row" }}>
      <div className="cred-list">
        <div className="row" style={{ padding: "16px 12px 10px" }}>
          <div className="input-wrap grow">
            <Search size={14} />
            <input className="input" placeholder="Search vault" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-icon" title="New item" onClick={() => openEditor(null)}><Plus size={16} /></button>
          <button className="btn btn-icon" title="Lock vault" onClick={() => void lockVault()}><Lock size={15} /></button>
        </div>
        <div className="cred-list-scroll">
          {grouped.length === 0 && <div className="faint" style={{ padding: 16 }}>{creds.length ? "No matches." : "Vault is empty."}</div>}
          {grouped.map((g) => (
            <div key={g.kind}>
              <div className="cred-group-title">{g.label}</div>
              {g.items.map((c) => {
                const exp = expiryState(c.expiresAt);
                const sub = c.fields.find((f) => !f.secret && f.key === "username")?.value || c.fields.find((f) => !f.secret && f.value)?.value || kindMeta(c.kind).label;
                return (
                  <div
                    key={c.id}
                    className={cx("cred-item", selected?.id === c.id && "active")}
                    onClick={() => select(c.id)}
                    onDoubleClick={() => openEditor(c.id)}
                    onContextMenu={(e) => openContextMenu(e, credMenu(c))}
                  >
                    <span className="cred-icon"><CredIcon kind={c.kind} size={15} /></span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="truncate" style={{ fontWeight: 500 }}>{c.name}</div>
                      <div className="truncate faint mono" style={{ fontSize: 11 }}>{sub}</div>
                    </div>
                    {exp === "expired" && <span className="badge tone-danger">expired</span>}
                    {exp === "soon" && <span className="badge tone-warning">expiring</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {selected ? (
        <CredentialDetail key={selected.id} c={selected} />
      ) : (
        <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
          <Empty icon={<KeyRound size={22} />} title="Your vault is ready" action={<button className="btn btn-primary" onClick={() => openEditor(null)}><Plus size={14} /> Add a credential</button>}>
            Store SSH keys, database passwords, API tokens and notes. Everything is encrypted with XChaCha20-Poly1305 before it touches disk.
          </Empty>
        </div>
      )}
    </div>
  );
}

function primarySecretKey(c: CredentialSummary): string | null {
  const order = ["password", "token", "secretAccessKey", "passphrase", "privateKey", "kubeconfig", "note"];
  for (const k of order) if (c.fields.some((f) => f.key === k && f.secret && f.hasValue)) return k;
  return c.fields.find((f) => f.secret && f.hasValue)?.key ?? null;
}

function credMenu(c: CredentialSummary) {
  const key = primarySecretKey(c);
  return [
    ...(key ? [{ label: `Copy ${c.fields.find((f) => f.key === key)?.label.toLowerCase()}`, icon: <Copy size={14} />, onSelect: () => void copySecret(c.id, key, c.name) }] : []),
    { label: "Edit…", icon: <Pencil size={14} />, onSelect: () => useApp.getState().openCredentialEditor(c.id) },
    { type: "sep" as const },
    {
      label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: async () => {
        const users = useData.getState().hosts.filter((h) => h.credentialId === c.id);
        const ok = await useApp.getState().askConfirm({
          title: `Delete “${c.name}”?`,
          body: users.length
            ? `${users.length} host(s) authenticate with it (${users.map((u) => u.name).join(", ")}). They will need a new credential. This also deletes its version history.`
            : "The item and its version history are permanently removed from the vault.",
          confirmLabel: "Delete item",
          danger: true,
        });
        if (!ok) return;
        try {
          await api.credentialDelete(c.id);
          useData.getState().removeCredential(c.id);
        } catch (e) {
          toastError("Delete failed", e);
        }
      },
    },
  ];
}

function CredentialDetail({ c }: { c: CredentialSummary }) {
  const hosts = useData((s) => s.hosts);
  const openEditor = useApp((s) => s.openCredentialEditor);
  const [history, setHistory] = useState<CredentialVersion[] | null>(null);
  const exp = expiryState(c.expiresAt);
  const sshUsers = hosts.filter((h) => h.credentialId === c.id);
  const linked = hosts.filter((h) => c.hostIds.includes(h.id) || h.credentialId === c.id);

  useEffect(() => {
    api.credentialHistory(c.id).then(setHistory).catch(() => setHistory([]));
  }, [c.id, c.versionCount]);

  const restore = async (v: number) => {
    const ok = await useApp.getState().askConfirm({ title: `Restore version ${v}?`, body: "The current values are kept in history as a new version.", confirmLabel: "Restore" });
    if (!ok) return;
    try {
      useData.getState().upsertCredential(await api.credentialRestoreVersion(c.id, v));
    } catch (e) {
      toastError("Restore failed", e);
    }
  };

  return (
    <div className="cred-detail">
      <div className="cred-detail-head">
        <span className="cred-icon"><CredIcon kind={c.kind} size={20} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }} className="truncate">{c.name}</h2>
          <div className="row muted" style={{ fontSize: 12, marginTop: 2 }}>
            {kindMeta(c.kind).label} · updated {relativeTime(c.updatedAt)}
            {c.strength !== null && <span className="row" style={{ gap: 6, marginLeft: 8, width: 140 }}><StrengthMeter score={c.strength} /></span>}
          </div>
        </div>
        <button className="btn" onClick={() => openEditor(c.id)}><Pencil size={14} /> Edit</button>
        <button className="btn btn-ghost btn-icon" onClick={(e) => openContextMenu(e, credMenu(c))}>⋯</button>
      </div>

      {exp && exp !== "ok" && (
        <div className={cx("callout", exp === "expired" ? "danger" : "warning")} style={{ marginBottom: 16 }}>
          <CalendarClock size={16} />
          <div>{exp === "expired" ? `Expired ${relativeTime(c.expiresAt)}.` : `Expires ${relativeTime(c.expiresAt)}.`} Rotate it and update the item — the old value stays in version history.</div>
        </div>
      )}

      <div className="secret-fields">
        {c.fields.filter((f) => f.hasValue || !f.secret).map((f) => <FieldRow key={f.key} credId={c.id} credName={c.name} f={f} />)}
      </div>

      <div className="grid-2" style={{ marginTop: 24, alignItems: "start" }}>
        <section className="col" style={{ gap: 10 }}>
          <h4 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: ".04em" }} className="muted">Associated hosts</h4>
          {linked.length === 0 ? (
            <span className="faint">Not linked to any host. Edit the item to associate it.</span>
          ) : (
            <div className="row wrap" style={{ gap: 6 }}>
              {linked.map((h) => (
                <span key={h.id} className="chip clickable" onClick={() => connectHost(h.id)} title={sshUsers.includes(h) ? "Used for SSH login — click to connect" : "Associated — click to connect"}>
                  <Server size={11} /> {h.name}
                  {sshUsers.includes(h) && <span className="faint">· ssh</span>}
                </span>
              ))}
            </div>
          )}
          {c.tags.length > 0 && (
            <div className="row wrap" style={{ gap: 6 }}>
              {c.tags.map((t) => <span key={t} className="chip"><Tag size={10} />{t}</span>)}
            </div>
          )}
          <div className="faint" style={{ fontSize: 12 }}>
            Created {new Date(c.createdAt).toLocaleString()}
            {c.expiresAt && <> · Expires {new Date(c.expiresAt).toLocaleDateString()}</>}
          </div>
        </section>
        <section className="col" style={{ gap: 10 }}>
          <h4 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: ".04em" }} className="muted row"><History size={13} /> Version history</h4>
          <div className="history card" style={{ padding: "4px 14px" }}>
            {!history ? (
              <div className="skeleton" style={{ height: 30, margin: "8px 0" }} />
            ) : history.length === 0 ? (
              <span className="faint" style={{ padding: "8px 0" }}>No history</span>
            ) : (
              history.map((v, i) => (
                <div key={v.version} className="history-item">
                  <span className="history-dot" style={i > 0 ? { borderColor: "var(--border-strong)" } : undefined} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5 }}>v{v.version}{i === 0 && <span className="faint"> · current</span>}</div>
                    <div className="faint truncate" style={{ fontSize: 11 }}>{relativeTime(v.createdAt)} · {v.changedFields.join(", ") || "metadata"}</div>
                  </div>
                  {i > 0 && <button className="btn btn-ghost btn-sm" onClick={() => restore(v.version)}><RotateCcw size={12} /> Restore</button>}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

const REMASK_MS = 20_000;

function FieldRow({ credId, credName, f }: { credId: string; credName: string; f: CredentialSummary["fields"][number] }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Never keep a revealed secret around longer than necessary.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    const onLock = () => setRevealed(null);
    window.addEventListener("ks-vault-locked", onLock);
    return () => window.removeEventListener("ks-vault-locked", onLock);
  }, []);

  const toggle = async () => {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    try {
      const v = await api.credentialReveal(credId, f.key);
      setRevealed(v);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setRevealed(null), REMASK_MS);
    } catch (e) {
      toastError("Could not reveal", e);
    }
  };

  const multiline = f.key === "privateKey" || f.key === "kubeconfig" || f.key === "note" || f.key === "publicKey";
  return (
    <div className="secret-field">
      <span className="sf-label">{f.label}</span>
      {f.secret ? (
        <span className={cx("sf-value", revealed === null && "masked")}>{revealed ?? (multiline ? "•••••••• (hidden)" : "••••••••••••")}</span>
      ) : (
        <span className="sf-value" style={multiline ? undefined : { whiteSpace: "nowrap" }}>{f.value || <span className="faint">—</span>}</span>
      )}
      <span className="sf-actions">
        {f.secret && (
          <button className="btn btn-ghost btn-xs" title={revealed === null ? "Reveal (re-masks after 20s)" : "Hide"} onClick={toggle}>
            {revealed === null ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
        )}
        {f.hasValue && (
          <button
            className="btn btn-ghost btn-xs"
            title={f.secret ? "Copy — clipboard is cleared automatically" : "Copy"}
            onClick={() => {
              if (f.secret) void copySecret(credId, f.key, `${credName} ${f.label.toLowerCase()}`);
              else void navigator.clipboard.writeText(f.value ?? "").then(() => useApp.getState().toast({ kind: "success", title: `${f.label} copied` }, 1500));
            }}
          >
            <Copy size={13} />
          </button>
        )}
      </span>
    </div>
  );
}
