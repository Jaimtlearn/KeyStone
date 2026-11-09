import { create } from "zustand";
import { api } from "../lib/api";
import { defaultSettings } from "../lib/defaults";
import type { AppSettings, AgentForwardPrompt, HostKeyPrompt, Id } from "../lib/types";

export type View = "hosts" | "vault" | "tunnels" | "files" | "settings" | "terminal";

export interface HostFilter {
  query: string;
  folderId: Id | null; // null = all
  tag: string | null;
  environment: string | null;
  project: string | null;
  favorites: boolean;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error" | "clipboard";
  title: string;
  detail?: string;
  /** For clipboard toasts: epoch ms when the clipboard is cleared. */
  until?: number;
}

interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

interface AppState {
  view: View;
  settings: AppSettings;
  settingsLoaded: boolean;
  filter: HostFilter;
  paletteOpen: boolean;
  hostEditor: { hostId: Id | null; preset?: { folderId?: Id | null } } | null;
  credentialEditor: { credentialId: Id | null; hostId?: Id | null } | null;
  hostKeyPrompts: HostKeyPrompt[];
  agentPrompts: AgentForwardPrompt[];
  toasts: Toast[];
  confirm: ConfirmRequest | null;
  narrow: boolean;

  setView: (v: View) => void;
  loadSettings: () => Promise<void>;
  updateSettings: (fn: (s: AppSettings) => AppSettings) => void;
  setFilter: (p: Partial<HostFilter>) => void;
  setPalette: (open: boolean) => void;
  openHostEditor: (hostId: Id | null, preset?: { folderId?: Id | null }) => void;
  closeHostEditor: () => void;
  openCredentialEditor: (credentialId: Id | null, hostId?: Id | null) => void;
  closeCredentialEditor: () => void;
  pushHostKey: (p: HostKeyPrompt) => void;
  popHostKey: (id: Id) => void;
  pushAgentPrompt: (p: AgentForwardPrompt) => void;
  popAgentPrompt: (id: Id) => void;
  toast: (t: Omit<Toast, "id">, ttlMs?: number) => void;
  dismissToast: (id: number) => void;
  askConfirm: (r: Omit<ConfirmRequest, "resolve">) => Promise<boolean>;
  setNarrow: (n: boolean) => void;
}

let toastSeq = 1;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useApp = create<AppState>((set, get) => ({
  view: "hosts",
  settings: defaultSettings(),
  settingsLoaded: false,
  filter: { query: "", folderId: null, tag: null, environment: null, project: null, favorites: false },
  paletteOpen: false,
  hostEditor: null,
  credentialEditor: null,
  hostKeyPrompts: [],
  agentPrompts: [],
  toasts: [],
  confirm: null,
  narrow: false,

  setView: (view) => set({ view }),
  loadSettings: async () => {
    try {
      // Backend returns null on first launch (nothing saved yet).
      const s: Partial<AppSettings> = (await api.settingsGet()) ?? {};
      const d = defaultSettings();
      // Merge with defaults so newly added settings keys always exist.
      set({
        settings: {
          ...d, ...s,
          terminal: { ...d.terminal, ...s.terminal },
          ui: { ...d.ui, ...s.ui },
          vault: { ...d.vault, ...s.vault },
          sessions: { ...d.sessions, ...s.sessions },
          keybindings: { ...d.keybindings, ...s.keybindings },
        },
        settingsLoaded: true,
      });
    } catch (e) {
      set({ settingsLoaded: true });
      get().toast({ kind: "error", title: "Could not load settings", detail: String(e) });
    }
  },
  updateSettings: (fn) => {
    const next = fn(get().settings);
    set({ settings: next });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.settingsSet(next).catch((e) => get().toast({ kind: "error", title: "Failed to save settings", detail: String(e) }));
    }, 300);
  },
  setFilter: (p) => set({ filter: { ...get().filter, ...p } }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  openHostEditor: (hostId, preset) => set({ hostEditor: { hostId, preset } }),
  closeHostEditor: () => set({ hostEditor: null }),
  openCredentialEditor: (credentialId, hostId) => set({ credentialEditor: { credentialId, hostId } }),
  closeCredentialEditor: () => set({ credentialEditor: null }),
  pushHostKey: (p) => set({ hostKeyPrompts: [...get().hostKeyPrompts, p] }),
  popHostKey: (id) => set({ hostKeyPrompts: get().hostKeyPrompts.filter((p) => p.requestId !== id) }),
  pushAgentPrompt: (p) => set({ agentPrompts: [...get().agentPrompts, p] }),
  popAgentPrompt: (id) => set({ agentPrompts: get().agentPrompts.filter((p) => p.requestId !== id) }),
  toast: (t, ttlMs = 4000) => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { ...t, id }] });
    setTimeout(() => get().dismissToast(id), t.until ? Math.max(ttlMs, t.until - Date.now() + 600) : ttlMs);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  askConfirm: (r) =>
    new Promise<boolean>((resolve) =>
      set({
        confirm: {
          ...r,
          resolve: (ok) => {
            set({ confirm: null });
            resolve(ok);
          },
        },
      }),
    ),
  setNarrow: (narrow) => set({ narrow }),
}));

export const toast = (t: Omit<Toast, "id">, ttl?: number) => useApp.getState().toast(t, ttl);
export const toastError = (title: string, e: unknown) =>
  useApp.getState().toast({ kind: "error", title, detail: e instanceof Error ? e.message : String(e) }, 6000);
