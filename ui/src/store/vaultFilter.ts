import { create } from "zustand";
import type { CredentialKind, Id } from "../lib/types";

interface VaultFilter {
  kind: CredentialKind | null;
  expiring: boolean;
  query: string;
  selectedId: Id | null;
  setKind: (k: CredentialKind | null) => void;
  setExpiring: (v: boolean) => void;
  setQuery: (q: string) => void;
  select: (id: Id | null) => void;
}

export const useVaultFilter = create<VaultFilter>((set) => ({
  kind: null,
  expiring: false,
  query: "",
  selectedId: null,
  setKind: (kind) => set({ kind }),
  setExpiring: (expiring) => set({ expiring }),
  setQuery: (query) => set({ query }),
  select: (selectedId) => set({ selectedId }),
}));
