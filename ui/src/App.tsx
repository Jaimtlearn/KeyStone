import { useEffect, useMemo } from "react";
import { Rail, TopBar } from "./components/Shell";
import { Sidebar } from "./components/Sidebar";
import { ContextMenuHost } from "./components/ContextMenu";
import { GlobalDialogs } from "./components/Dialogs";
import { HostEditor } from "./components/HostEditor";
import { CredentialEditor } from "./components/CredentialEditor";
import { CommandPalette } from "./components/CommandPalette";
import { HostsView } from "./views/HostsView";
import { VaultView } from "./views/VaultView";
import { TunnelsView } from "./views/TunnelsView";
import { FilesView } from "./views/FilesView";
import { SettingsView } from "./views/SettingsView";
import { TerminalArea } from "./views/TerminalArea";
import { useApp } from "./store/app";
import { useData } from "./store/data";
import { useWorkspace } from "./store/workspace";
import { api, EVENTS, listen } from "./lib/api";
import { matchBinding } from "./lib/keys";
import { runAction } from "./lib/actions";
import { applyAppearance, findTheme } from "./theme/apply";
import type { AgentForwardPrompt, HostKeyPrompt, TunnelStatus } from "./lib/types";

export function App() {
  const view = useApp((s) => s.view);
  const settings = useApp((s) => s.settings);
  const settingsLoaded = useApp((s) => s.settingsLoaded);

  // ── boot ──
  useEffect(() => {
    void (async () => {
      await useApp.getState().loadSettings();
      await useData.getState().load();
      const s = useApp.getState().settings;
      if (s.sessions.restoreOnLaunch) {
        try {
          const w = await api.workspaceGet();
          if (w && w.tabs.length) {
            useWorkspace.getState().restore(w, !s.sessions.autoReconnect);
            useApp.getState().setView("terminal");
          }
        } catch {
          /* no saved workspace */
        }
      }
      workspaceReady = true;
    })();
  }, []);

  // ── backend events ──
  useEffect(() => {
    const subs = [
      listen<null>(EVENTS.vaultLocked, () => {
        useData.getState().onLocked();
        window.dispatchEvent(new Event("ks-vault-locked"));
      }),
      listen<HostKeyPrompt>(EVENTS.hostKeyPrompt, (p) => useApp.getState().pushHostKey(p)),
      listen<AgentForwardPrompt>(EVENTS.agentForwardPrompt, (p) => useApp.getState().pushAgentPrompt(p)),
      listen<TunnelStatus>(EVENTS.tunnelStatus, (s) => useData.getState().setTunnelStatus(s)),
    ];
    return () => {
      subs.forEach((p) => void p.then((un) => un()));
    };
  }, []);

  // ── appearance ──
  const theme = useMemo(() => findTheme(settings, settings.themeId), [settings]);
  useEffect(() => applyAppearance(theme, settings), [theme, settings]);

  // ── keybindings ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const action = matchBinding(useApp.getState().settings.keybindings, e);
      if (!action) return;
      const app = useApp.getState();
      if (app.paletteOpen && action !== "palette.open" && action !== "search.global") return;
      if (runAction(action)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── workspace persistence (layout only — never terminal contents) ──
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = useWorkspace.subscribe((s, prev) => {
      if (!workspaceReady) return;
      if (s.tabs === prev.tabs && s.activeTabId === prev.activeTabId && s.activeProject === prev.activeProject && s.sidebarSection === prev.sidebarSection) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => void api.workspaceSave(useWorkspace.getState().snapshot()).catch(() => {}), 800);
    });
    return () => {
      unsub();
      if (t) clearTimeout(t);
    };
  }, []);

  // ── vault inactivity: report activity (throttled) so the backend's auto-lock timer resets ──
  useEffect(() => {
    let last = 0;
    const touch = () => {
      const now = Date.now();
      if (now - last < 20_000 || !useData.getState().vault?.unlocked) return;
      last = now;
      void api.vaultTouch().catch(() => {});
    };
    window.addEventListener("keydown", touch, true);
    window.addEventListener("pointerdown", touch, true);
    window.addEventListener("wheel", touch, { passive: true, capture: true });
    return () => {
      window.removeEventListener("keydown", touch, true);
      window.removeEventListener("pointerdown", touch, true);
      window.removeEventListener("wheel", touch, true);
    };
  }, []);

  // ── responsive ──
  useEffect(() => {
    const check = () => useApp.getState().setNarrow(window.innerWidth < 1100);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  if (!settingsLoaded) {
    return <div style={{ height: "100%", display: "grid", placeItems: "center" }}><div className="spinner" /></div>;
  }

  return (
    <div className="app">
      <Rail />
      <Sidebar />
      <main className="main">
        <TopBar />
        {view === "hosts" && <HostsView />}
        {view === "vault" && <VaultView />}
        {view === "tunnels" && <TunnelsView />}
        {view === "files" && <FilesView />}
        {view === "settings" && <SettingsView />}
        <TerminalArea />
      </main>
      <HostEditor />
      <CredentialEditor />
      <CommandPalette />
      <ContextMenuHost />
      <GlobalDialogs />
    </div>
  );
}

let workspaceReady = false;
