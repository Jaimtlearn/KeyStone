import { Command } from "cmdk";
import { useEffect, useState } from "react";
import {
  ArrowLeftRight, Columns2, Copy, KeyRound, Lock, Monitor, Palette, Play, Plus, Rows2, Search, Server, Settings, Square, TerminalSquare, Shield, FolderOpen, Pencil,
} from "lucide-react";
import { useApp } from "../store/app";
import { useData } from "../store/data";
import { useWorkspace } from "../store/workspace";
import { useVaultFilter } from "../store/vaultFilter";
import { allThemes } from "../theme/apply";
import { api } from "../lib/api";
import { connectHost, copySecret, lockVault, openLocalTerminal, openSftp, runAction } from "../lib/actions";
import { CredIcon } from "./icons";
import { Kbd } from "./ui";
import { promptText } from "./Dialogs";
import { toastError } from "../store/app";
import type { CredentialSummary } from "../lib/types";

function primarySecret(c: CredentialSummary) {
  const order = ["password", "token", "secretAccessKey", "passphrase", "privateKey", "kubeconfig", "note"];
  for (const k of order) {
    const f = c.fields.find((x) => x.key === k && x.secret && x.hasValue);
    if (f) return f;
  }
  return null;
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPalette);
  const settings = useApp((s) => s.settings);
  const hosts = useData((s) => s.hosts);
  const creds = useData((s) => s.credentials);
  const tunnels = useData((s) => s.tunnels);
  const tstatus = useData((s) => s.tunnelStatus);
  const vaultUnlocked = useData((s) => !!s.vault?.unlocked);
  const tabs = useWorkspace((s) => s.tabs);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  if (!open) return null;
  const kb = settings.keybindings;
  const run = (fn: () => unknown) => {
    setOpen(false);
    void fn();
  };
  const recentHosts = [...hosts].sort((a, b) => (b.lastConnectedAt ?? "").localeCompare(a.lastConnectedAt ?? "") || Number(b.favorite) - Number(a.favorite));

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <Command
        className="palette"
        label="Command palette"
        loop
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          }
        }}
      >
        <div className="palette-input">
          <Search size={17} />
          <Command.Input autoFocus value={search} onValueChange={setSearch} placeholder="Connect to a host, copy a secret, run an action…" />
        </div>
        <Command.List>
          <Command.Empty>No results for “{search}”.</Command.Empty>

          <Command.Group heading="Hosts">
            {recentHosts.slice(0, search ? 50 : 6).map((h) => (
              <Command.Item key={h.id} value={`host ${h.name} ${h.hostname} ${h.username} ${h.tags.join(" ")} ${h.environment ?? ""} ${h.project ?? ""}`} onSelect={() => run(() => connectHost(h.id))}>
                {h.isBastion ? <Shield size={15} /> : <Server size={15} />}
                <span>{h.name}</span>
                <span className="faint mono" style={{ fontSize: 11.5 }}>{h.username}@{h.hostname}</span>
                <span className="hint">{h.jumpChain.length > 0 && `via ${h.jumpChain.length} hop`} Connect</span>
              </Command.Item>
            ))}
            {search &&
              hosts.slice(0, 50).map((h) => (
                <Command.Item key={`sftp-${h.id}`} value={`sftp files ${h.name} ${h.hostname}`} onSelect={() => run(() => openSftp(h.id))}>
                  <FolderOpen size={15} /> <span>Open SFTP · {h.name}</span>
                </Command.Item>
              ))}
          </Command.Group>

          {tabs.length > 0 && (
            <Command.Group heading="Open sessions">
              {tabs.map((t) => (
                <Command.Item key={t.id} value={`session tab ${t.title}`} onSelect={() => run(() => { useWorkspace.getState().activateTab(t.id); useApp.getState().setView("terminal"); })}>
                  <TerminalSquare size={15} /> <span>{t.title}</span> <span className="hint">Switch</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          {vaultUnlocked && search && (
            <Command.Group heading="Vault">
              {creds.map((c) => {
                const sec = primarySecret(c);
                return (
                  <Command.Item
                    key={c.id}
                    value={`credential vault ${c.name} ${c.kind} ${c.tags.join(" ")}`}
                    onSelect={() =>
                      run(() => {
                        if (sec) void copySecret(c.id, sec.key, c.name);
                        else {
                          useVaultFilter.getState().select(c.id);
                          useApp.getState().setView("vault");
                        }
                      })
                    }
                  >
                    <CredIcon kind={c.kind} size={15} />
                    <span>{c.name}</span>
                    <span className="hint">{sec ? <><Copy size={12} /> Copy {sec.label.toLowerCase()}</> : "Open"}</span>
                  </Command.Item>
                );
              })}
            </Command.Group>
          )}

          {tunnels.length > 0 && (
            <Command.Group heading="Tunnels">
              {tunnels.map((t) => {
                const running = tstatus[t.id]?.state === "running";
                return (
                  <Command.Item
                    key={t.id}
                    value={`tunnel ${t.name} ${t.bindPort} ${t.targetHost ?? ""}`}
                    onSelect={() => run(() => void (running ? api.tunnelStop(t.id) : api.tunnelStart(t.id)).catch((e) => toastError("Tunnel action failed", e)))}
                  >
                    <ArrowLeftRight size={15} /> <span>{t.name}</span>
                    <span className="faint mono" style={{ fontSize: 11.5 }}>:{t.bindPort}</span>
                    <span className="hint">{running ? <><Square size={11} /> Stop</> : <><Play size={11} /> Start</>}</span>
                  </Command.Item>
                );
              })}
            </Command.Group>
          )}

          <Command.Group heading="Actions">
            <Command.Item value="new local terminal shell" onSelect={() => run(() => openLocalTerminal())}>
              <Monitor size={15} /> New local terminal <span className="hint"><Kbd combo={kb["terminal.newLocal"] ?? ""} /></span>
            </Command.Item>
            <Command.Item value="new host add server" onSelect={() => run(() => useApp.getState().openHostEditor(null))}>
              <Plus size={15} /> New host <span className="hint"><Kbd combo={kb["host.new"] ?? ""} /></span>
            </Command.Item>
            <Command.Item value="new vault item credential secret" onSelect={() => run(() => { useApp.getState().setView("vault"); if (vaultUnlocked) useApp.getState().openCredentialEditor(null); })}>
              <KeyRound size={15} /> New vault item
            </Command.Item>
            {tabs.length > 0 && (
              <>
                <Command.Item value="split pane right vertical" onSelect={() => run(() => runAction("pane.splitRight"))}>
                  <Columns2 size={15} /> Split pane right <span className="hint"><Kbd combo={kb["pane.splitRight"] ?? ""} /></span>
                </Command.Item>
                <Command.Item value="split pane down horizontal" onSelect={() => run(() => runAction("pane.splitDown"))}>
                  <Rows2 size={15} /> Split pane down <span className="hint"><Kbd combo={kb["pane.splitDown"] ?? ""} /></span>
                </Command.Item>
                <Command.Item value="rename tab" onSelect={() => run(async () => {
                  const ws = useWorkspace.getState();
                  const t = ws.tabs.find((x) => x.id === ws.activeTabId);
                  const name = t && (await promptText("Rename tab", "Tab name", t.title));
                  if (t && name) ws.renameTab(t.id, name);
                })}>
                  <Pencil size={15} /> Rename current tab
                </Command.Item>
              </>
            )}
            {vaultUnlocked && (
              <Command.Item value="lock vault" onSelect={() => run(() => void lockVault())}>
                <Lock size={15} /> Lock vault <span className="hint"><Kbd combo={kb["vault.lock"] ?? ""} /></span>
              </Command.Item>
            )}
            <Command.Item value="go hosts" onSelect={() => run(() => useApp.getState().setView("hosts"))}><Server size={15} /> Go to Hosts</Command.Item>
            <Command.Item value="go vault credentials" onSelect={() => run(() => useApp.getState().setView("vault"))}><KeyRound size={15} /> Go to Vault</Command.Item>
            <Command.Item value="go tunnels port forwarding" onSelect={() => run(() => useApp.getState().setView("tunnels"))}><ArrowLeftRight size={15} /> Go to Tunnels</Command.Item>
            <Command.Item value="go files sftp" onSelect={() => run(() => useApp.getState().setView("files"))}><FolderOpen size={15} /> Go to Files</Command.Item>
            <Command.Item value="settings preferences" onSelect={() => run(() => useApp.getState().setView("settings"))}><Settings size={15} /> Open Settings</Command.Item>
          </Command.Group>

          <Command.Group heading="Themes">
            {allThemes(settings).filter((t) => t.id !== "__draft__").map((t) => (
              <Command.Item key={t.id} value={`theme ${t.name}`} onSelect={() => run(() => useApp.getState().updateSettings((s) => ({ ...s, themeId: t.id })))}>
                <Palette size={15} /> <span>Theme: {t.name}</span>
                <span className="hint">
                  {[t.ui.bg, t.ui.accent, t.terminal.green, t.terminal.red].map((c, i) => (
                    <span key={i} style={{ width: 10, height: 10, borderRadius: 3, background: c, border: "1px solid var(--border)", display: "inline-block" }} />
                  ))}
                  {settings.themeId === t.id && " · active"}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
        <div className="palette-foot">
          <span><Kbd combo="↑" /><Kbd combo="↓" /> navigate</span>
          <span><Kbd combo="Enter" /> run</span>
          <span><Kbd combo="Esc" /> close</span>
        </div>
      </Command>
    </div>
  );
}
