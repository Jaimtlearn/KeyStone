import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Plus, RefreshCw, Wand2, X, Copy } from "lucide-react";
import { Field, Modal, STRENGTH_LABEL, StrengthMeter, Switch } from "./ui";
import { CredIcon } from "./icons";
import { api } from "../lib/api";
import { useApp, toastError } from "../store/app";
import { useData } from "../store/data";
import { CREDENTIAL_KINDS, kindMeta, templateFields } from "../lib/defaults";
import { cx } from "../lib/format";
import type { CredentialFieldInput, CredentialInput, CredentialKind, PasswordOptions, PasswordStrength } from "../lib/types";

export function CredentialEditor() {
  const ed = useApp((s) => s.credentialEditor);
  if (!ed) return null;
  return <Inner key={ed.credentialId ?? "new"} credentialId={ed.credentialId} hostId={ed.hostId ?? null} />;
}

function Inner({ credentialId, hostId }: { credentialId: string | null; hostId: string | null }) {
  const close = useApp((s) => s.closeCredentialEditor);
  const creds = useData((s) => s.credentials);
  const hosts = useData((s) => s.hosts);
  const existing = credentialId ? creds.find((c) => c.id === credentialId) : undefined;

  const [input, setInput] = useState<CredentialInput>(() =>
    existing
      ? {
          name: existing.name,
          kind: existing.kind,
          // Secret fields start as null = "keep existing value".
          fields: existing.fields.map((f) => ({ key: f.key, label: f.label, secret: f.secret, value: f.secret ? null : f.value ?? "" })),
          hostIds: existing.hostIds,
          tags: existing.tags,
          expiresAt: existing.expiresAt,
        }
      : { name: "", kind: "sshPassword", fields: templateFields("sshPassword"), hostIds: hostId ? [hostId] : [], tags: [], expiresAt: null },
  );
  const [saving, setSaving] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [touched, setTouched] = useState(false);

  const setKind = (kind: CredentialKind) => {
    // keep values for fields that exist in both templates
    const prev = new Map(input.fields.map((f) => [f.key, f]));
    setInput({ ...input, kind, fields: templateFields(kind).map((f) => (prev.has(f.key) ? { ...f, value: prev.get(f.key)!.value } : f)) });
  };
  const setField = (key: string, value: string | null) =>
    setInput((p) => ({ ...p, fields: p.fields.map((f) => (f.key === key ? { ...f, value } : f)) }));

  const save = async () => {
    setTouched(true);
    if (!input.name.trim()) return;
    setSaving(true);
    try {
      const payload: CredentialInput = {
        ...input,
        name: input.name.trim(),
        // new items: send "" for untouched secrets so the backend stores an empty value
        fields: input.fields.map((f) => (existing ? f : { ...f, value: f.value ?? "" })),
      };
      const saved = existing ? await api.credentialUpdate(existing.id, payload) : await api.credentialCreate(payload);
      useData.getState().upsertCredential(saved);
      // When created from the host editor, link it as that host's SSH credential if it fits.
      if (!existing && hostId && (saved.kind === "sshKey" || saved.kind === "sshPassword")) {
        const h = useData.getState().hosts.find((x) => x.id === hostId);
        if (h && !h.credentialId) await useData.getState().saveHost({ ...h, credentialId: saved.id, auth: saved.kind === "sshKey" ? "publicKey" : "password" });
      }
      close();
    } catch (e) {
      toastError("Could not save credential", e);
    } finally {
      setSaving(false);
    }
  };

  const meta = kindMeta(input.kind);
  const addTag = () => {
    const t = tagInput.trim();
    if (t && !input.tags.includes(t)) setInput({ ...input, tags: [...input.tags, t] });
    setTagInput("");
  };

  return (
    <Modal
      wide
      title={existing ? `Edit ${existing.name}` : "New vault item"}
      icon={<span className="cred-icon"><CredIcon kind={input.kind} /></span>}
      onClose={close}
      closeOnBackdrop={false}
      footer={
        <>
          <span className="field-hint grow">Encrypted before it is written to disk. Changing a secret keeps the previous value in version history.</span>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Encrypting…" : existing ? "Save" : "Add to vault"}</button>
        </>
      }
    >
      <form className="col" style={{ gap: 16 }} onSubmit={(e) => { e.preventDefault(); void save(); }} autoComplete="off">
        {!existing && (
          <div className="row wrap" style={{ gap: 6 }}>
            {CREDENTIAL_KINDS.map((k) => (
              <button key={k.kind} type="button" className={cx("chip clickable", input.kind === k.kind && "on")} style={{ height: 28, padding: "0 10px" }} onClick={() => setKind(k.kind)}>
                <CredIcon kind={k.kind} size={12} /> {k.label}
              </button>
            ))}
          </div>
        )}
        <Field label="Name" error={touched && !input.name.trim() ? "Give the item a name" : null}>
          <input className={cx("input", touched && !input.name.trim() && "invalid")} autoFocus value={input.name} placeholder={`${meta.label} for production-db-01`} onChange={(e) => setInput({ ...input, name: e.target.value })} />
        </Field>

        <div className="grid-2">
          {input.fields.map((f) => {
            const tpl = meta.fields.find((t) => t.key === f.key);
            const wide = tpl?.multiline;
            return (
              <SecretInput
                key={f.key}
                field={f}
                multiline={!!tpl?.multiline}
                placeholder={tpl?.placeholder}
                existing={!!existing}
                hasStored={!!existing?.fields.find((x) => x.key === f.key)?.hasValue}
                onChange={(v) => setField(f.key, v)}
                className={wide ? "span-2" : undefined}
              />
            );
          })}
        </div>

        <div className="grid-2">
          <Field label="Associated hosts" hint="Reference, not a copy — one item can serve many hosts.">
            <div className="col" style={{ gap: 6 }}>
              <div className="row wrap" style={{ gap: 4 }}>
                {input.hostIds.map((id) => {
                  const h = hosts.find((x) => x.id === id);
                  return (
                    <span key={id} className="chip">{h?.name ?? "missing"}<button type="button" onClick={() => setInput({ ...input, hostIds: input.hostIds.filter((x) => x !== id) })}><X size={10} /></button></span>
                  );
                })}
              </div>
              <select className="select" value="" onChange={(e) => e.target.value && setInput({ ...input, hostIds: [...input.hostIds, e.target.value] })}>
                <option value="">+ Link a host…</option>
                {hosts.filter((h) => !input.hostIds.includes(h.id)).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>
          </Field>
          <div className="col" style={{ gap: 12 }}>
            <Field label="Expires">
              <div className="row">
                <input
                  className="input"
                  type="date"
                  value={input.expiresAt ? input.expiresAt.slice(0, 10) : ""}
                  onChange={(e) => setInput({ ...input, expiresAt: e.target.value ? new Date(e.target.value + "T00:00:00").toISOString() : null })}
                />
                {input.expiresAt && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setInput({ ...input, expiresAt: null })}>Clear</button>}
              </div>
            </Field>
            <Field label="Tags">
              <div className="row wrap" style={{ gap: 4 }}>
                {input.tags.map((t) => <span key={t} className="chip">{t}<button type="button" onClick={() => setInput({ ...input, tags: input.tags.filter((x) => x !== t) })}><X size={10} /></button></span>)}
                <input className="input" style={{ width: 130, height: 26 }} placeholder="Add tag…" value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }} onBlur={addTag} />
              </div>
            </Field>
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function SecretInput({ field: f, multiline, placeholder, existing, hasStored, onChange, className }: {
  field: CredentialFieldInput; multiline: boolean; placeholder?: string; existing: boolean; hasStored: boolean;
  onChange: (v: string | null) => void; className?: string;
}) {
  const [show, setShow] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [strength, setStrength] = useState<PasswordStrength | null>(null);
  const isPassword = f.secret && !multiline && ["password", "passphrase"].includes(f.key);
  const keeping = existing && f.secret && f.value === null;

  useEffect(() => {
    if (!isPassword || !f.value) return setStrength(null);
    const h = setTimeout(() => api.passwordStrength(f.value!).then(setStrength).catch(() => {}), 200);
    return () => clearTimeout(h);
  }, [f.value, isPassword]);

  if (!f.secret) {
    return (
      <Field label={f.label} className={className}>
        {multiline ? (
          <textarea className="textarea" value={f.value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input className="input" value={f.value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        )}
      </Field>
    );
  }

  if (keeping) {
    return (
      <Field label={<>{f.label} <span className="badge tone-neutral">encrypted</span></>} className={className}>
        <div className="row">
          <input className="input" disabled value={hasStored ? "•••••••••••• (unchanged)" : "(empty)"} />
          <button type="button" className="btn" onClick={() => onChange("")}><RefreshCw size={13} /> Replace</button>
        </div>
      </Field>
    );
  }

  return (
    <Field
      label={<>{f.label}{existing && <button type="button" className="btn btn-ghost btn-sm" style={{ height: 18, marginLeft: "auto" }} onClick={() => onChange(null)}>Keep current</button>}</>}
      className={className}
      hint={isPassword && strength ? <span className="row" style={{ gap: 8 }}><span style={{ width: 100 }}><StrengthMeter score={strength.score} /></span>{STRENGTH_LABEL[strength.score]} · {strength.crackTime}</span> : undefined}
    >
      {multiline ? (
        <textarea
          className="textarea"
          value={f.value ?? ""}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          style={show ? undefined : ({ WebkitTextSecurity: "disc" } as React.CSSProperties)}
        />
      ) : (
        <div className="input-wrap" style={{ position: "relative" }}>
          <input className="input mono" type={show ? "text" : "password"} value={f.value ?? ""} placeholder={placeholder} autoComplete="new-password" spellCheck={false} onChange={(e) => onChange(e.target.value)} style={{ paddingLeft: 12, paddingRight: isPassword ? 60 : 32 }} />
          <span className="input-suffix">
            {isPassword && (
              <button type="button" className="btn btn-ghost btn-xs" title="Generate" onClick={() => setGenOpen(!genOpen)}><Wand2 size={13} /></button>
            )}
            <button type="button" className="btn btn-ghost btn-xs" title={show ? "Hide" : "Show"} onClick={() => setShow(!show)}>{show ? <EyeOff size={13} /> : <Eye size={13} />}</button>
          </span>
          {genOpen && <PasswordGenerator onUse={(p) => { onChange(p); setShow(true); setGenOpen(false); }} onClose={() => setGenOpen(false)} />}
        </div>
      )}
      {multiline && (
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShow(!show)}>{show ? <><EyeOff size={12} /> Hide</> : <><Eye size={12} /> Show</>}</button>
          {f.key === "privateKey" && <span className="field-hint">Paste an OpenSSH, PEM or PPK private key.</span>}
        </div>
      )}
    </Field>
  );
}

const GEN_KEY = "ks.passgen";
function loadGenOpts(): PasswordOptions {
  try {
    const raw = localStorage.getItem(GEN_KEY);
    if (raw) return JSON.parse(raw) as PasswordOptions;
  } catch { /* ignore */ }
  return { length: 24, lowercase: true, uppercase: true, digits: true, symbols: true, excludeAmbiguous: true };
}

export function PasswordGenerator({ onUse, onClose }: { onUse?: (pw: string) => void; onClose: () => void }) {
  const [opts, setOpts] = useState<PasswordOptions>(loadGenOpts);
  const [pw, setPw] = useState("");
  const [strength, setStrength] = useState<PasswordStrength | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const gen = async (o = opts) => {
    try {
      const p = await api.passwordGenerate(o);
      setPw(p);
      setStrength(await api.passwordStrength(p));
    } catch (e) {
      toastError("Generator failed", e);
    }
  };
  useEffect(() => { void gen(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    try { localStorage.setItem(GEN_KEY, JSON.stringify(opts)); } catch { /* ignore */ }
  }, [opts]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    setTimeout(() => window.addEventListener("mousedown", h), 0);
    return () => window.removeEventListener("mousedown", h);
  }, [onClose]);

  const update = (p: Partial<PasswordOptions>) => {
    const o = { ...opts, ...p };
    if (!o.lowercase && !o.uppercase && !o.digits && !o.symbols) o.lowercase = true;
    setOpts(o);
    void gen(o);
  };

  return (
    <div ref={ref} className="popover" style={{ top: "calc(100% + 6px)", right: 0, width: 340 }} onClick={(e) => e.stopPropagation()}>
      <div className="col" style={{ gap: 12 }}>
        <div className="row">
          <code className="mono selectable grow" style={{ fontSize: 13, wordBreak: "break-all", padding: "8px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>{pw}</code>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" title="Regenerate" onClick={() => gen()}><RefreshCw size={14} /></button>
        </div>
        <div className="col" style={{ gap: 4 }}>
          <StrengthMeter score={strength?.score ?? null} />
          <span className="field-hint">{strength ? `${STRENGTH_LABEL[strength.score]} · ${strength.crackTime}` : ""}</span>
        </div>
        <Field label={`Length · ${opts.length}`}>
          <input type="range" min={8} max={128} value={opts.length} onChange={(e) => update({ length: Number(e.target.value) })} />
        </Field>
        {([
          ["uppercase", "A–Z"],
          ["lowercase", "a–z"],
          ["digits", "0–9"],
          ["symbols", "!@#$%"],
          ["excludeAmbiguous", "Avoid ambiguous (l, 1, O, 0)"],
        ] as const).map(([k, label]) => (
          <div key={k} className="row" style={{ justifyContent: "space-between" }}>
            <span style={{ fontSize: 12.5 }}>{label}</span>
            <Switch on={opts[k]} onChange={(v) => update({ [k]: v })} />
          </div>
        ))}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {!onUse && <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(pw)}><Copy size={12} /> Copy</button>}
          {onUse && <button type="button" className="btn btn-primary btn-sm" onClick={() => onUse(pw)}><Plus size={12} /> Use password</button>}
        </div>
      </div>
    </div>
  );
}
