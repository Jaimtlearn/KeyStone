import { create } from "zustand";
import { api } from "../lib/api";
import type { CredentialSummary, Folder, Host, Id, Tunnel, TunnelStatus, VaultStatus } from "../lib/types";
import { toastError } from "./app";

interface DataState {
  loaded: boolean;
  hosts: Host[];
  folders: Folder[];
  tunnels: Tunnel[];
  tunnelStatus: Record<Id, TunnelStatus>;
  vault: VaultStatus | null;
  /** Summaries only — never contains secret values. Cleared on lock. */
  credentials: CredentialSummary[];

  load: () => Promise<void>;
  saveHost: (h: Host) => Promise<Host | null>;
  deleteHost: (id: Id) => Promise<void>;
  duplicateHost: (id: Id) => Promise<void>;
  toggleFavorite: (id: Id) => Promise<void>;
  saveFolder: (f: Folder) => Promise<void>;
  deleteFolder: (id: Id) => Promise<void>;
  saveTunnel: (t: Tunnel) => Promise<void>;
  deleteTunnel: (id: Id) => Promise<void>;
  setTunnelStatus: (s: TunnelStatus) => void;
  refreshTunnelStatus: () => Promise<void>;
  refreshVault: () => Promise<void>;
  refreshCredentials: () => Promise<void>;
  upsertCredential: (c: CredentialSummary) => void;
  removeCredential: (id: Id) => void;
  onLocked: () => void;
}

export const useData = create<DataState>((set, get) => ({
  loaded: false,
  hosts: [],
  folders: [],
  tunnels: [],
  tunnelStatus: {},
  vault: null,
  credentials: [],

  load: async () => {
    try {
      const snap = await api.storeLoad();
      set({ hosts: snap.hosts, folders: snap.folders, tunnels: snap.tunnels, loaded: true });
    } catch (e) {
      set({ loaded: true });
      toastError("Failed to load profiles", e);
    }
    await Promise.all([get().refreshVault(), get().refreshTunnelStatus()]);
  },
  saveHost: async (h) => {
    try {
      const saved = await api.hostSave(h);
      const hosts = get().hosts;
      const i = hosts.findIndex((x) => x.id === saved.id);
      set({ hosts: i >= 0 ? hosts.map((x) => (x.id === saved.id ? saved : x)) : [...hosts, saved] });
      return saved;
    } catch (e) {
      toastError("Could not save host", e);
      return null;
    }
  },
  deleteHost: async (id) => {
    try {
      await api.hostDelete(id);
      set({
        hosts: get().hosts.filter((h) => h.id !== id).map((h) => ({ ...h, jumpChain: h.jumpChain.filter((j) => j !== id) })),
      });
    } catch (e) {
      toastError("Could not delete host", e);
    }
  },
  duplicateHost: async (id) => {
    try {
      const h = await api.hostDuplicate(id);
      set({ hosts: [...get().hosts, h] });
    } catch (e) {
      toastError("Could not duplicate host", e);
    }
  },
  toggleFavorite: async (id) => {
    const h = get().hosts.find((x) => x.id === id);
    if (h) await get().saveHost({ ...h, favorite: !h.favorite });
  },
  saveFolder: async (f) => {
    try {
      const saved = await api.folderSave(f);
      const folders = get().folders;
      set({ folders: folders.some((x) => x.id === saved.id) ? folders.map((x) => (x.id === saved.id ? saved : x)) : [...folders, saved] });
    } catch (e) {
      toastError("Could not save folder", e);
    }
  },
  deleteFolder: async (id) => {
    try {
      await api.folderDelete(id);
      await get().load();
    } catch (e) {
      toastError("Could not delete folder", e);
    }
  },
  saveTunnel: async (t) => {
    try {
      const saved = await api.tunnelSave(t);
      const list = get().tunnels;
      set({ tunnels: list.some((x) => x.id === saved.id) ? list.map((x) => (x.id === saved.id ? saved : x)) : [...list, saved] });
    } catch (e) {
      toastError("Could not save tunnel", e);
    }
  },
  deleteTunnel: async (id) => {
    try {
      await api.tunnelDelete(id);
      const { [id]: _removed, ...rest } = get().tunnelStatus;
      set({ tunnels: get().tunnels.filter((t) => t.id !== id), tunnelStatus: rest });
    } catch (e) {
      toastError("Could not delete tunnel", e);
    }
  },
  setTunnelStatus: (s) => set({ tunnelStatus: { ...get().tunnelStatus, [s.id]: s } }),
  refreshTunnelStatus: async () => {
    try {
      const list = await api.tunnelStatuses();
      set({ tunnelStatus: Object.fromEntries(list.map((s) => [s.id, s])) });
    } catch {
      /* backend may not be ready; ignore */
    }
  },
  refreshVault: async () => {
    try {
      const vault = await api.vaultStatus();
      set({ vault });
      if (vault.unlocked) await get().refreshCredentials();
      else set({ credentials: [] });
    } catch (e) {
      toastError("Vault unavailable", e);
    }
  },
  refreshCredentials: async () => {
    try {
      set({ credentials: await api.credentialList() });
    } catch (e) {
      toastError("Could not load credentials", e);
    }
  },
  upsertCredential: (c) => {
    const list = get().credentials;
    set({ credentials: list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c] });
  },
  removeCredential: (id) => set({ credentials: get().credentials.filter((c) => c.id !== id) }),
  onLocked: () => {
    const v = get().vault;
    set({ credentials: [], vault: v ? { ...v, unlocked: false } : v });
  },
}));

export function hostById(id: Id | null | undefined): Host | undefined {
  return id ? useData.getState().hosts.find((h) => h.id === id) : undefined;
}
