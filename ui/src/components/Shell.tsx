import { useState } from "react";
import {
  ArrowLeftRight, FolderOpen, KeyRound, Lock, LockOpen, PanelLeft, Plus, Search, Server, Settings, X, Columns2, Rows2, Pencil, TerminalSquare,
} from "lucide-react";
import { Kbd, Logo } from "./ui";
import { openContextMenu } from "./ContextMenu";
import { useApp, type View } from "../store/app";
import { useData } from "../store/data";
import { leaves, useWorkspace } from "../store/workspace";
import { lockVault, openLocalTerminal } from "../lib/actions";
import { cx } from "../lib/format";

const RAIL: { view: View; label: string; icon: typeof Server; action: string }[] = [
  { view: "hosts", label: "Hosts", icon: Server, action: "view.hosts" },
  { view: "vault", label: "Vault", icon: KeyRound, action: "view.vault" },
  { view: "tunnels", label: "Tunnels", icon: ArrowLeftRight, action: "view.tunnels" },
  { view: "files", label: "Files", icon: FolderOpen, action: "view.files" },
];

export function Rail() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const kb = useApp((s) => s.settings.keybindings);
  const tabs = useWorkspace((s) => s.tabs.length);
  const runningTunnels = useData((s) => Object.values(s.tunnelStatus).filter((t) => t.state === "running").length);
  const unlocked = useData((s) => s.vault?.unlocked);

  return (
    <nav className="rail" aria-label="Primary">
      <div className="rail-logo"><Logo size={30} /></div>
      {RAIL.map((r) => (
        <button
          key={r.view}
          className={cx("rail-btn", view === r.view && "active")}
          onClick={() => setView(r.view)}
          title={`${r.label}${kb[r.action] ? `  (${kb[r.action]})` : ""}`}
          aria-label={r.label}
          aria-current={view === r.view ? "page" : undefined}
        >
          <r.icon size={19} strokeWidth={1.75} />
          {r.view === "tunnels" && runningTunnels > 0 && <span className="rail-badge" />}
        </button>
      ))}
      {tabs > 0 && (
        <button
          className={cx("rail-btn", view === "terminal" && "active")}
          onClick={() => setView("terminal")}
          title="Terminals"
          aria-label="Terminals"
        >
          <TerminalSquare size={19} strokeWidth={1.75} />
          <span className="rail-badge" style={{ background: "var(--success)" }} />
        </button>
      )}
      <div className="rail-spacer" />
      <button
        className="rail-btn"
        title={unlocked ? "Lock vault" : "Vault locked"}
        aria-label={unlocked ? "Lock vault" : "Vault locked"}
        onClick={() => (unlocked ? void lockVault() : setView("vault"))}
      >
        {unlocked ? <LockOpen size={18} strokeWidth={1.75} color="var(--success)" /> : <Lock size={18} strokeWidth={1.75} />}
      </button>
      <button className={cx("rail-btn", view === "settings" && "active")} onClick={() => setView("settings")} title="Settings" aria-label="Settings">
        <Settings size={19} strokeWidth={1.75} />
      </button>
    </nav>
  );
}

export function TopBar() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const setPalette = useApp((s) => s.setPalette);
  const update = useApp((s) => s.updateSettings);
  const kb = useApp((s) => s.settings.keybindings);
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const runtime = useWorkspace((s) => s.runtime);
  const ws = useWorkspace.getState;
  const [editing, setEditing] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  return (
    <header className="topbar">
      {view !== "settings" && (
        <button
          className="btn btn-ghost btn-icon btn-sm"
          title={`Toggle sidebar (${kb["sidebar.toggle"] ?? ""})`}
          onClick={() => update((s) => ({ ...s, ui: { ...s.ui, sidebarCollapsed: !s.ui.sidebarCollapsed } }))}
        >
          <PanelLeft size={16} />
        </button>
      )}
      <div className="tabstrip" role="tablist">
        {tabs.map((t) => {
          const st = leaves(t.layout).map((l) => runtime[l.id]?.status ?? "idle");
          const status = st.includes("error") ? "error" : st.includes("reconnecting") ? "reconnecting" : st.includes("connecting") ? "connecting" : st.includes("connected") ? "connected" : "closed";
          const active = view === "terminal" && t.id === activeTabId;
          const panes = leaves(t.layout).length;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              className={cx("tab", active && "active", dragId === t.id && "dragging")}
              draggable={editing !== t.id}
              onDragStart={(e) => { setDragId(t.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => { e.preventDefault(); if (dragId && dragId !== t.id) ws().moveTab(dragId, t.id); }}
              onClick={() => { ws().activateTab(t.id); setView("terminal"); }}
              onKeyDown={(e) => e.key === "Enter" && (ws().activateTab(t.id), setView("terminal"))}
              onDoubleClick={() => setEditing(t.id)}
              onAuxClick={(e) => e.button === 1 && ws().closeTab(t.id)}
              onContextMenu={(e) =>
                openContextMenu(e, [
                  { label: "Rename", icon: <Pencil size={14} />, onSelect: () => setEditing(t.id) },
                  { label: "Split right", icon: <Columns2 size={14} />, onSelect: () => { ws().activateTab(t.id); ws().split(leaves(t.layout)[0].id, "horizontal"); } },
                  { label: "Split down", icon: <Rows2 size={14} />, onSelect: () => { ws().activateTab(t.id); ws().split(leaves(t.layout)[0].id, "vertical"); } },
                  { type: "sep" },
                  { label: "Close tab", icon: <X size={14} />, onSelect: () => ws().closeTab(t.id) },
                  { label: "Close other tabs", onSelect: () => tabs.filter((x) => x.id !== t.id).forEach((x) => ws().closeTab(x.id)) },
                ])
              }
            >
              <span className={cx("status-dot", status)} />
              {editing === t.id ? (
                <input
                  autoFocus
                  defaultValue={t.title}
                  onFocus={(e) => e.target.select()}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => { ws().renameTab(t.id, e.target.value.trim() || t.title); setEditing(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditing(null);
                    e.stopPropagation();
                  }}
                />
              ) : (
                <span className="tab-title">{t.title}</span>
              )}
              {panes > 1 && <span className="faint" style={{ fontSize: 11 }}>×{panes}</span>}
              <button
                className="btn btn-ghost btn-xs tab-close"
                aria-label="Close tab"
                onClick={(e) => { e.stopPropagation(); ws().closeTab(t.id); }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button className="btn btn-ghost btn-icon btn-sm" title={`New local terminal (${kb["terminal.newLocal"] ?? ""})`} onClick={() => openLocalTerminal()}>
          <Plus size={16} />
        </button>
      </div>
      <button className="btn btn-sm" style={{ minWidth: 220, justifyContent: "flex-start", color: "var(--text-muted)" }} onClick={() => setPalette(true)}>
        <Search size={14} />
        <span className="grow" style={{ textAlign: "left" }}>Search or run a command</span>
        <Kbd combo={kb["palette.open"] ?? "Ctrl+K"} />
      </button>
    </header>
  );
}
