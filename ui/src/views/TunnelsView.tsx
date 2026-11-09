import { useEffect, useState } from "react";
import { ArrowLeftRight, CheckCircle2, MoreHorizontal, Pencil, Play, Plus, RotateCcw, Square, Trash2, AlertCircle } from "lucide-react";
import { api } from "../lib/api";
import { useData } from "../store/data";
import { toastError, useApp } from "../store/app";
import { Empty, Field, Modal, Seg, Switch } from "../components/ui";
import { openContextMenu } from "../components/ContextMenu";
import { newId } from "../lib/defaults";
import { cx, formatBytes, relativeTime } from "../lib/format";
import type { Host, Tunnel, TunnelKind, TunnelStatus } from "../lib/types";

const KIND_FLAG: Record<TunnelKind, string> = { local: "-L", remote: "-R", dynamic: "-D" };

export function TunnelFlow({ t, host, running, big }: { t: Tunnel; host: Host | undefined; running?: boolean; big?: boolean }) {
  const via = host ? host.name : "—";
  const hops = host?.jumpChain.length ?? 0;
  const bind = `${t.bindAddress}:${t.bindPort || "?"}`;
  const target = `${t.targetHost || "?"}:${t.targetPort || "?"}`;
  const nodes =
    t.kind === "local"
      ? [{ l: `local ${bind}` }, { l: `via ${via}${hops ? ` (+${hops} hop${hops > 1 ? "s" : ""})` : ""}`, via: true }, { l: target }]
      : t.kind === "remote"
        ? [{ l: `${via} ${bind}` }, { l: "back through SSH", via: true }, { l: `local ${target}` }]
        : [{ l: `SOCKS5 ${bind}` }, { l: `via ${via}`, via: true }, { l: "any destination" }];
  return (
    <div className={cx("flow", running && "running", big && "big")}>
      {nodes.map((n, i) => (
        <span key={i} className="row" style={{ gap: 0 }}>
          {i > 0 && <span className="flow-arrow" />}
          <span className={cx("flow-node", n.via && "via")}>{n.l}</span>
        </span>
      ))}
    </div>
  );
}

function StatusBadge({ s }: { s: TunnelStatus | undefined }) {
  const state = s?.state ?? "stopped";
  const tone = state === "running" ? "success" : state === "error" ? "danger" : state === "stopped" ? "neutral" : "warning";
  return (
    <span className={`badge tone-${tone}`} title={s?.error ?? undefined}>
      {(state === "starting" || state === "reconnecting") && <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />}
      {state}
    </span>
  );
}

export function TunnelsView() {
  const tunnels = useData((s) => s.tunnels);
  const hosts = useData((s) => s.hosts);
  const statuses = useData((s) => s.tunnelStatus);
  const [editing, setEditing] = useState<Tunnel | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // Poll for byte counters while the view is open (state changes also arrive via events).
  useEffect(() => {
    const i = setInterval(() => void useData.getState().refreshTunnelStatus(), 2000);
    return () => clearInterval(i);
  }, []);

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await fn();
    } catch (e) {
      toastError("Tunnel action failed", e);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
      void useData.getState().refreshTunnelStatus();
    }
  };
  const start = (id: string) => run(id, () => api.tunnelStart(id));
  const stop = (id: string) => run(id, () => api.tunnelStop(id));
  const restart = (id: string) => run(id, async () => { await api.tunnelStop(id); await api.tunnelStart(id); });

  const newTunnel = (): Tunnel => ({
    id: newId(), name: "", hostId: hosts.find((h) => h.isBastion)?.id ?? hosts[0]?.id ?? "", kind: "local",
    bindAddress: "127.0.0.1", bindPort: 0, targetHost: "", targetPort: null, autoStart: false, autoReconnect: true,
  });

  const running = tunnels.filter((t) => statuses[t.id]?.state === "running").length;

  return (
    <div className="view">
      <div className="view-head">
        <div className="grow">
          <h1 className="view-title">Tunnels</h1>
          <div className="view-sub">{tunnels.length} profile{tunnels.length === 1 ? "" : "s"} · {running} running</div>
        </div>
        <button className="btn btn-primary" disabled={!hosts.length} onClick={() => setEditing(newTunnel())}><Plus size={15} /> New tunnel</button>
      </div>
      <div className="view-body">
        {tunnels.length === 0 ? (
          <Empty
            icon={<ArrowLeftRight size={22} />}
            title="No tunnels yet"
            action={<button className="btn btn-primary" disabled={!hosts.length} onClick={() => setEditing(newTunnel())}><Plus size={14} /> Create a tunnel</button>}
          >
            Forward a remote database to localhost, expose a local port on a server, or run a SOCKS proxy through a bastion.
          </Empty>
        ) : (
          <div className="tunnel-list">
            {tunnels.map((t) => {
              const s = statuses[t.id];
              const host = hosts.find((h) => h.id === t.hostId);
              const isRunning = s?.state === "running";
              const active = isRunning || s?.state === "starting" || s?.state === "reconnecting";
              return (
                <div key={t.id} className="tunnel-row" onContextMenu={(e) => openContextMenu(e, [
                  { label: "Edit…", icon: <Pencil size={14} />, onSelect: () => setEditing(t) },
                  { label: "Restart", icon: <RotateCcw size={14} />, disabled: !active, onSelect: () => restart(t.id) },
                  { type: "sep" },
                  { label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: async () => {
                    if (await useApp.getState().askConfirm({ title: `Delete tunnel “${t.name}”?`, body: "The tunnel will be stopped first.", confirmLabel: "Delete", danger: true })) {
                      if (active) await api.tunnelStop(t.id).catch(() => {});
                      await useData.getState().deleteTunnel(t.id);
                    }
                  } },
                ])}>
                  <span className={cx("tunnel-kind", isRunning && "running")}>{KIND_FLAG[t.kind]}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <b className="truncate">{t.name || `${t.kind} :${t.bindPort}`}</b>
                      <StatusBadge s={s} />
                    </div>
                    <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                      {isRunning
                        ? `${s.activeConnections} conn · ↓ ${formatBytes(s.bytesIn)} ↑ ${formatBytes(s.bytesOut)} · since ${relativeTime(s.startedAt)}`
                        : s?.state === "error"
                          ? <span style={{ color: "var(--danger)" }}>{s.error}</span>
                          : `${t.autoStart ? "Starts with Keystone · " : ""}${t.autoReconnect ? "Auto-reconnect" : "Manual"}`}
                    </div>
                  </div>
                  <TunnelFlow t={t} host={host} running={isRunning} />
                  <div className="row" style={{ gap: 4 }}>
                    {active ? (
                      <button className="btn btn-sm" disabled={busy[t.id]} onClick={() => stop(t.id)}><Square size={12} /> Stop</button>
                    ) : (
                      <button className="btn btn-sm" disabled={busy[t.id] || !host} onClick={() => start(t.id)}><Play size={12} /> Start</button>
                    )}
                  </div>
                  <button className="btn btn-ghost btn-icon btn-sm" onClick={(e) => openContextMenu(e, [
                    { label: "Edit…", icon: <Pencil size={14} />, onSelect: () => setEditing(t) },
                    { label: "Restart", icon: <RotateCcw size={14} />, disabled: !active, onSelect: () => restart(t.id) },
                    { type: "sep" },
                    { label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: async () => {
                      if (await useApp.getState().askConfirm({ title: `Delete tunnel “${t.name}”?`, body: "The tunnel will be stopped first.", confirmLabel: "Delete", danger: true })) {
                        if (active) await api.tunnelStop(t.id).catch(() => {});
                        await useData.getState().deleteTunnel(t.id);
                      }
                    } },
                  ])}><MoreHorizontal size={15} /></button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {editing && <TunnelEditor initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TunnelEditor({ initial, onClose }: { initial: Tunnel; onClose: () => void }) {
  const hosts = useData((s) => s.hosts);
  const existing = useData((s) => s.tunnels.some((t) => t.id === initial.id));
  const [t, setT] = useState<Tunnel>(initial);
  const [portFree, setPortFree] = useState<boolean | null>(null);
  const [touched, setTouched] = useState(false);
  const set = <K extends keyof Tunnel>(k: K, v: Tunnel[K]) => setT((p) => ({ ...p, [k]: v }));
  const host = hosts.find((h) => h.id === t.hostId);

  // Port conflict check for locally bound ports (local + dynamic).
  useEffect(() => {
    setPortFree(null);
    if (t.kind === "remote" || !(t.bindPort > 0 && t.bindPort < 65536)) return;
    if (existing && t.bindPort === initial.bindPort && t.bindAddress === initial.bindAddress) return; // may be our own running listener
    const h = setTimeout(() => {
      api.portAvailable(t.bindAddress, t.bindPort).then(setPortFree).catch(() => setPortFree(null));
    }, 250);
    return () => clearTimeout(h);
  }, [t.kind, t.bindAddress, t.bindPort, existing, initial.bindPort, initial.bindAddress]);

  const errors = {
    host: !t.hostId ? "Choose an SSH host" : null,
    bindPort: !(t.bindPort > 0 && t.bindPort < 65536) ? "1–65535" : null,
    targetHost: t.kind !== "dynamic" && !t.targetHost?.trim() ? "Required" : null,
    targetPort: t.kind !== "dynamic" && !(t.targetPort && t.targetPort > 0 && t.targetPort < 65536) ? "1–65535" : null,
  };
  const valid = !Object.values(errors).some(Boolean);

  const save = async () => {
    setTouched(true);
    if (!valid) return;
    const clean: Tunnel = {
      ...t,
      name: t.name.trim() || `${KIND_FLAG[t.kind]} ${t.bindPort}`,
      targetHost: t.kind === "dynamic" ? null : t.targetHost?.trim() ?? null,
      targetPort: t.kind === "dynamic" ? null : t.targetPort,
    };
    await useData.getState().saveTunnel(clean);
    onClose();
  };

  return (
    <Modal
      wide
      title={existing ? "Edit tunnel" : "New tunnel"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>{existing ? "Save" : "Create tunnel"}</button>
        </>
      }
    >
      <form className="col" style={{ gap: 16 }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Seg<TunnelKind>
          value={t.kind}
          onChange={(kind) => setT((p) => ({ ...p, kind, bindAddress: kind === "remote" ? "127.0.0.1" : p.bindAddress }))}
          options={[
            { value: "local", label: <><span className="mono">-L</span> Local</> },
            { value: "remote", label: <><span className="mono">-R</span> Remote</> },
            { value: "dynamic", label: <><span className="mono">-D</span> SOCKS5</> },
          ]}
        />
        <span className="field-hint">
          {t.kind === "local" && "Listen on this machine and forward each connection through SSH to a host reachable from the server (e.g. a private database)."}
          {t.kind === "remote" && "Ask the server to listen on a port and forward connections back to a host reachable from this machine."}
          {t.kind === "dynamic" && "Run a local SOCKS5 proxy; applications choose the destination, traffic exits from the server."}
        </span>

        <TunnelFlow t={t} host={host} big />

        <div className="grid-2">
          <Field label="Name"><input className="input" value={t.name} placeholder="Prod MySQL" onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="SSH host" error={touched && errors.host}>
            <select className="select" value={t.hostId} onChange={(e) => set("hostId", e.target.value)}>
              <option value="">Choose…</option>
              {hosts.map((h) => <option key={h.id} value={h.id}>{h.name} — {h.hostname}{h.jumpChain.length ? ` (via ${h.jumpChain.length} hop)` : ""}</option>)}
            </select>
          </Field>
        </div>

        <div className="grid-2">
          <Field label={t.kind === "remote" ? "Remote bind address" : "Local bind address"} hint={t.bindAddress !== "127.0.0.1" && t.bindAddress !== "localhost" ? "⚠ Listening beyond loopback exposes the tunnel to your network." : undefined}>
            <input className="input mono" value={t.bindAddress} onChange={(e) => set("bindAddress", e.target.value)} />
          </Field>
          <Field
            label={t.kind === "remote" ? "Remote port" : "Local port"}
            error={touched && errors.bindPort}
            hint={
              portFree === false ? undefined : portFree === true ? <span className="row" style={{ gap: 4, color: "var(--success)" }}><CheckCircle2 size={12} /> Port is free</span> : undefined
            }
          >
            <input className={cx("input mono", portFree === false && "invalid")} type="number" value={t.bindPort || ""} placeholder={t.kind === "dynamic" ? "1080" : "3307"} onChange={(e) => set("bindPort", Number(e.target.value))} />
            {portFree === false && <span className="field-error row" style={{ gap: 4 }}><AlertCircle size={12} /> Port is already in use on this machine</span>}
          </Field>
        </div>

        {t.kind !== "dynamic" && (
          <div className="grid-2">
            <Field label={t.kind === "local" ? "Destination host (as seen from server)" : "Destination host (as seen from this machine)"} error={touched && errors.targetHost}>
              <input className="input mono" value={t.targetHost ?? ""} placeholder={t.kind === "local" ? "10.0.2.20" : "127.0.0.1"} onChange={(e) => set("targetHost", e.target.value)} />
            </Field>
            <Field label="Destination port" error={touched && errors.targetPort}>
              <input className="input mono" type="number" value={t.targetPort ?? ""} placeholder="3306" onChange={(e) => set("targetPort", e.target.value ? Number(e.target.value) : null)} />
            </Field>
          </div>
        )}

        <div>
          <div className="switch-row">
            <div className="switch-text"><span>Start automatically</span><span className="field-hint">When Keystone launches (and the vault is unlocked if credentials are needed)</span></div>
            <Switch on={t.autoStart} onChange={(v) => set("autoStart", v)} />
          </div>
          <div className="switch-row">
            <div className="switch-text"><span>Reconnect automatically</span><span className="field-hint">Re-establish the SSH connection with backoff if it drops</span></div>
            <Switch on={t.autoReconnect} onChange={(v) => set("autoReconnect", v)} />
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
