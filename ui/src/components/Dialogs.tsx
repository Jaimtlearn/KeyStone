import { useEffect, useState } from "react";
import { create } from "zustand";
import { AlertTriangle, CheckCircle2, ClipboardCheck, Info, KeyRound, ShieldAlert, ShieldQuestion, X, XCircle } from "lucide-react";
import { Modal } from "./ui";
import { api } from "../lib/api";
import { toastError, useApp, type Toast } from "../store/app";

// ───────── text prompt (rename etc.) ─────────

interface PromptState {
  req: { title: string; label: string; initial: string; confirm: string; resolve: (v: string | null) => void } | null;
}
const usePrompt = create<PromptState>(() => ({ req: null }));

export function promptText(title: string, label: string, initial = "", confirm = "Save"): Promise<string | null> {
  return new Promise((resolve) => usePrompt.setState({ req: { title, label, initial, confirm, resolve } }));
}

function PromptDialog() {
  const req = usePrompt((s) => s.req);
  const [value, setValue] = useState("");
  useEffect(() => setValue(req?.initial ?? ""), [req]);
  if (!req) return null;
  const done = (v: string | null) => {
    usePrompt.setState({ req: null });
    req.resolve(v);
  };
  return (
    <Modal
      title={req.title}
      onClose={() => done(null)}
      footer={
        <>
          <button className="btn" onClick={() => done(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={!value.trim()} onClick={() => done(value.trim())}>{req.confirm}</button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) done(value.trim()); }}>
        <label className="field">
          <span className="field-label">{req.label}</span>
          <input className="input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
      </form>
    </Modal>
  );
}

// ───────── confirm ─────────

function ConfirmDialog() {
  const confirm = useApp((s) => s.confirm);
  if (!confirm) return null;
  return (
    <Modal
      title={confirm.title}
      icon={confirm.danger ? <AlertTriangle size={18} color="var(--danger)" /> : undefined}
      onClose={() => confirm.resolve(false)}
      footer={
        <>
          <button className="btn" onClick={() => confirm.resolve(false)}>Cancel</button>
          <button className={confirm.danger ? "btn btn-solid-danger" : "btn btn-primary"} autoFocus onClick={() => confirm.resolve(true)}>
            {confirm.confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, color: "var(--text-muted)" }}>{confirm.body}</p>
    </Modal>
  );
}

// ───────── host key verification ─────────

function HostKeyDialog() {
  const prompt = useApp((s) => s.hostKeyPrompts[0]);
  const pop = useApp((s) => s.popHostKey);
  if (!prompt) return null;
  const changed = prompt.status === "changed";
  const respond = async (accept: boolean) => {
    pop(prompt.requestId);
    try {
      await api.hostKeyRespond(prompt.requestId, accept);
    } catch (e) {
      toastError("Host key response failed", e);
    }
  };
  return (
    <Modal
      title={changed ? "Host key has CHANGED" : "Verify host identity"}
      icon={changed ? <ShieldAlert size={20} color="var(--danger)" /> : <ShieldQuestion size={20} color="var(--accent)" />}
      onClose={() => respond(false)}
      closeOnBackdrop={false}
      footer={
        <>
          <button className="btn" autoFocus={changed} onClick={() => respond(false)}>Reject & disconnect</button>
          <button className={changed ? "btn btn-solid-danger" : "btn btn-primary"} autoFocus={!changed} onClick={() => respond(true)}>
            {changed ? "Replace key and connect" : "Trust and connect"}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {changed ? (
          <div className="callout danger">
            <ShieldAlert size={18} />
            <div>
              The key presented by <b className="mono">{prompt.host}:{prompt.port}</b> does not match the one you trusted before.
              This can mean the server was reinstalled — or that someone is intercepting the connection. Only continue if you can
              confirm the new fingerprint out-of-band.
            </div>
          </div>
        ) : (
          <p style={{ margin: 0 }} className="muted">
            First connection to <b className="mono" style={{ color: "var(--text)" }}>{prompt.host}:{prompt.port}</b>. Compare the fingerprint with
            the one published by the server administrator before trusting it.
          </p>
        )}
        <div className="card panel-pad col" style={{ gap: 8 }}>
          <div className="row"><span className="muted" style={{ width: 90 }}>Key type</span><span className="mono">{prompt.keyType}</span></div>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <span className="muted" style={{ width: 90, flex: "none" }}>Fingerprint</span>
            <span className="mono selectable" style={{ wordBreak: "break-all", color: changed ? "var(--danger)" : undefined }}>{prompt.fingerprint}</span>
          </div>
          {prompt.previousFingerprint && (
            <div className="row" style={{ alignItems: "flex-start" }}>
              <span className="muted" style={{ width: 90, flex: "none" }}>Previous</span>
              <span className="mono selectable faint" style={{ wordBreak: "break-all" }}>{prompt.previousFingerprint}</span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ───────── agent forwarding consent ─────────

function AgentForwardDialog() {
  const prompt = useApp((s) => s.agentPrompts[0]);
  const pop = useApp((s) => s.popAgentPrompt);
  if (!prompt) return null;
  const respond = async (allow: boolean) => {
    pop(prompt.requestId);
    try {
      await api.agentForwardRespond(prompt.requestId, allow);
    } catch (e) {
      toastError("Agent forwarding response failed", e);
    }
  };
  return (
    <Modal
      title="Forward your SSH agent?"
      icon={<KeyRound size={18} color="var(--warning)" />}
      onClose={() => respond(false)}
      closeOnBackdrop={false}
      footer={
        <>
          <button className="btn btn-primary" autoFocus onClick={() => respond(false)}>Don't forward</button>
          <button className="btn" onClick={() => respond(true)}>Allow for this session</button>
        </>
      }
    >
      <div className="callout warning">
        <AlertTriangle size={18} />
        <div>
          <b>{prompt.hostName}</b> requests access to your local SSH agent. While the session is open, anyone with root on that machine can
          use your loaded keys to authenticate elsewhere as you. Only allow this on hosts you fully trust.
        </div>
      </div>
    </Modal>
  );
}

// ───────── toasts ─────────

function ToastItem({ t }: { t: Toast }) {
  const dismiss = useApp((s) => s.dismissToast);
  const [now, setNow] = useState(Date.now());
  const [total] = useState(() => (t.until ? Math.max(1, t.until - Date.now()) : 1));
  useEffect(() => {
    if (!t.until) return;
    const i = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(i);
  }, [t.until]);
  const left = t.until ? Math.max(0, Math.ceil((t.until - now) / 1000)) : null;
  const icon =
    t.kind === "error" ? <XCircle size={16} /> : t.kind === "success" ? <CheckCircle2 size={16} /> : t.kind === "clipboard" ? <ClipboardCheck size={16} /> : <Info size={16} />;
  return (
    <div className={`toast ${t.kind}`} role="status">
      <span className="toast-icon">{icon}</span>
      <div className="grow">
        <div className="toast-title">{t.title}</div>
        {t.detail && <div className="toast-detail">{t.detail}</div>}
        {left !== null && (
          <>
            <div className="toast-detail">{left > 0 ? `Clipboard clears in ${left}s` : "Clipboard cleared"}</div>
            <div className="toast-bar" style={{ transform: `scaleX(${Math.max(0, (t.until! - now) / total)})`, transition: "transform 250ms linear" }} />
          </>
        )}
      </div>
      <button className="btn btn-ghost btn-xs" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={13} /></button>
    </div>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => <ToastItem key={t.id} t={t} />)}
    </div>
  );
}

export function GlobalDialogs() {
  return (
    <>
      <HostKeyDialog />
      <AgentForwardDialog />
      <ConfirmDialog />
      <PromptDialog />
      <Toasts />
    </>
  );
}
