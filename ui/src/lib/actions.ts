import { api } from "./api";
import { liveTerminals } from "./sessions";
import type { Id } from "./types";
import { toast, toastError, useApp } from "../store/app";
import { useData } from "../store/data";
import { useWorkspace } from "../store/workspace";

export function connectHost(hostId: Id, mode: "tab" | "right" | "down" = "tab") {
  const host = useData.getState().hosts.find((h) => h.id === hostId);
  if (!host) return;
  useWorkspace.getState().open({ kind: "ssh", hostId }, mode, host.name);
  useApp.getState().setView("terminal");
}

export function openLocalTerminal(mode: "tab" | "right" | "down" = "tab") {
  useWorkspace.getState().open({ kind: "local", shell: null }, mode, "Local");
  useApp.getState().setView("terminal");
}

export function openSftp(hostId: Id) {
  const host = useData.getState().hosts.find((h) => h.id === hostId);
  useWorkspace.getState().open({ kind: "sftp", hostId }, "tab", host ? `SFTP · ${host.name}` : "SFTP");
  useApp.getState().setView("terminal");
}

export async function lockVault() {
  try {
    await api.vaultLock();
    useData.getState().onLocked();
  } catch (e) {
    toastError("Could not lock vault", e);
  }
}

export async function copySecret(credentialId: Id, fieldKey: string, label = "Secret") {
  try {
    const secs = await api.credentialCopy(credentialId, fieldKey);
    toast({ kind: "clipboard", title: `${label} copied`, until: Date.now() + secs * 1000 }, secs * 1000 + 600);
  } catch (e) {
    toastError("Copy failed", e);
  }
}

function focusedTerminal() {
  const id = useWorkspace.getState().focusedPaneId;
  return id ? liveTerminals.get(id) : undefined;
}

export async function copyTerminalSelection() {
  const t = focusedTerminal();
  const sel = t?.term.getSelection();
  if (sel) await navigator.clipboard.writeText(sel).catch(() => {});
}

export async function pasteIntoTerminal() {
  const t = focusedTerminal();
  if (!t) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) t.term.paste(text);
  } catch {
    /* clipboard permission denied */
  }
}

/** Dispatches a keybinding / palette action id. Returns true if handled. */
export function runAction(id: string): boolean {
  const app = useApp.getState();
  const ws = useWorkspace.getState();
  switch (id) {
    case "palette.open":
    case "search.global":
      app.setPalette(!app.paletteOpen);
      return true;
    case "terminal.newLocal":
      openLocalTerminal();
      return true;
    case "tab.close":
      if (ws.focusedPaneId) ws.closePane(ws.focusedPaneId);
      return true;
    case "tab.next":
      ws.cycleTab(1);
      app.setView("terminal");
      return true;
    case "tab.prev":
      ws.cycleTab(-1);
      app.setView("terminal");
      return true;
    case "pane.splitRight":
    case "pane.splitDown":
      if (ws.focusedPaneId) ws.split(ws.focusedPaneId, id === "pane.splitRight" ? "horizontal" : "vertical");
      else openLocalTerminal();
      app.setView("terminal");
      return true;
    case "pane.fullscreen":
      ws.toggleFullscreen();
      return true;
    case "terminal.search":
      focusedTerminal()?.openSearch();
      return true;
    case "host.new":
      app.openHostEditor(null);
      return true;
    case "vault.lock":
      void lockVault();
      return true;
    case "sidebar.toggle":
      app.updateSettings((s) => ({ ...s, ui: { ...s.ui, sidebarCollapsed: !s.ui.sidebarCollapsed } }));
      return true;
    case "view.hosts":
    case "view.vault":
    case "view.tunnels":
    case "view.files":
    case "view.settings":
      app.setView(id.slice(5) as "hosts");
      return true;
    default:
      return false;
  }
}
