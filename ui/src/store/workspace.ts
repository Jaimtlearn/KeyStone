import { create } from "zustand";
import { newId } from "../lib/defaults";
import type { Id, PaneNode, PaneTarget, SessionStatus, TabState, Workspace } from "../lib/types";

export interface PaneRuntime {
  status: SessionStatus | "idle";
  message: string | null;
  hop: { index: number; total: number; name: string } | null;
}

type OpenMode = "tab" | "right" | "down";

interface WorkspaceState {
  tabs: TabState[];
  activeTabId: Id | null;
  focusedPaneId: Id | null;
  fullscreenPaneId: Id | null;
  activeProject: string | null;
  sidebarSection: string;
  runtime: Record<Id, PaneRuntime>;
  /** Panes restored from a previous launch that should wait for a click before connecting. */
  deferred: Record<Id, true>;
  /** Bumped to ask a pane to reconnect. */
  reconnectNonce: Record<Id, number>;

  open: (target: PaneTarget, mode?: OpenMode, title?: string) => Id;
  split: (paneId: Id, direction: "horizontal" | "vertical", target?: PaneTarget) => void;
  closePane: (paneId: Id) => void;
  closeTab: (tabId: Id) => void;
  activateTab: (tabId: Id) => void;
  cycleTab: (delta: number) => void;
  renameTab: (tabId: Id, title: string) => void;
  moveTab: (fromId: Id, toId: Id) => void;
  focusPane: (paneId: Id) => void;
  toggleFullscreen: (paneId?: Id) => void;
  setSizes: (splitId: Id, sizes: number[]) => void;
  setRuntime: (paneId: Id, r: Partial<PaneRuntime>) => void;
  reconnect: (paneId: Id) => void;
  undefer: (paneId: Id) => void;
  setProject: (p: string | null) => void;
  setSidebarSection: (s: string) => void;
  restore: (w: Workspace, deferConnect: boolean) => void;
  snapshot: () => Workspace;
}

export function leaves(node: PaneNode): Extract<PaneNode, { type: "leaf" }>[] {
  return node.type === "leaf" ? [node] : node.children.flatMap(leaves);
}

function mapNode(node: PaneNode, fn: (n: PaneNode) => PaneNode | null): PaneNode | null {
  const mapped = fn(node);
  if (mapped !== node || mapped === null || mapped.type === "leaf") return mapped;
  const children = mapped.children.map((c) => mapNode(c, fn)).filter((c): c is PaneNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const sizes = children.length === mapped.children.length ? mapped.sizes : children.map(() => 100 / children.length);
  return { ...mapped, children, sizes };
}

export function findTabOfPane(tabs: TabState[], paneId: Id): TabState | undefined {
  return tabs.find((t) => leaves(t.layout).some((l) => l.id === paneId));
}

const leaf = (target: PaneTarget, title: string | null = null): PaneNode => ({ type: "leaf", id: newId(), target, title });

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  focusedPaneId: null,
  fullscreenPaneId: null,
  activeProject: null,
  sidebarSection: "hosts",
  runtime: {},
  deferred: {},
  reconnectNonce: {},

  open: (target, mode = "tab", title) => {
    const { tabs, activeTabId, focusedPaneId } = get();
    const active = tabs.find((t) => t.id === activeTabId);
    if (mode !== "tab" && active) {
      const anchor = focusedPaneId && findTabOfPane([active], focusedPaneId) ? focusedPaneId : leaves(active.layout)[0].id;
      const n = leaf(target, title ?? null);
      const direction = mode === "right" ? "horizontal" : "vertical";
      const layout = mapNode(active.layout, (node) =>
        node.type === "leaf" && node.id === anchor
          ? { type: "split", id: newId(), direction, sizes: [50, 50], children: [node, n] }
          : node,
      )!;
      set({ tabs: tabs.map((t) => (t.id === active.id ? { ...t, layout } : t)), focusedPaneId: n.id, fullscreenPaneId: null });
      return n.id;
    }
    const n = leaf(target, title ?? null);
    const tab: TabState = { id: newId(), title: title ?? "Terminal", layout: n };
    set({ tabs: [...tabs, tab], activeTabId: tab.id, focusedPaneId: n.id, fullscreenPaneId: null });
    return n.id;
  },
  split: (paneId, direction, target) => {
    const tab = findTabOfPane(get().tabs, paneId);
    if (!tab) return;
    const src = leaves(tab.layout).find((l) => l.id === paneId)!;
    const n = leaf(target ?? src.target);
    const layout = mapNode(tab.layout, (node) =>
      node.type === "leaf" && node.id === paneId
        ? { type: "split", id: newId(), direction, sizes: [50, 50], children: [node, n] }
        : node,
    )!;
    set({ tabs: get().tabs.map((t) => (t.id === tab.id ? { ...t, layout } : t)), focusedPaneId: n.id, fullscreenPaneId: null });
  },
  closePane: (paneId) => {
    const { tabs } = get();
    const tab = findTabOfPane(tabs, paneId);
    if (!tab) return;
    const layout = mapNode(tab.layout, (node) => (node.type === "leaf" && node.id === paneId ? null : node));
    const { [paneId]: _r, ...runtime } = get().runtime;
    if (!layout) {
      get().closeTab(tab.id);
      set({ runtime });
      return;
    }
    set({
      tabs: tabs.map((t) => (t.id === tab.id ? { ...t, layout } : t)),
      focusedPaneId: leaves(layout)[0].id,
      fullscreenPaneId: get().fullscreenPaneId === paneId ? null : get().fullscreenPaneId,
      runtime,
    });
  },
  closeTab: (tabId) => {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const next = tabs.filter((t) => t.id !== tabId);
    let active = activeTabId;
    if (activeTabId === tabId) active = next[Math.min(idx, next.length - 1)]?.id ?? null;
    const activeTab = next.find((t) => t.id === active);
    set({ tabs: next, activeTabId: active, focusedPaneId: activeTab ? leaves(activeTab.layout)[0].id : null, fullscreenPaneId: null });
  },
  activateTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    set({ activeTabId: tabId, focusedPaneId: leaves(tab.layout)[0].id, fullscreenPaneId: null });
  },
  cycleTab: (delta) => {
    const { tabs, activeTabId } = get();
    if (!tabs.length) return;
    const i = tabs.findIndex((t) => t.id === activeTabId);
    get().activateTab(tabs[(i + delta + tabs.length) % tabs.length].id);
  },
  renameTab: (tabId, title) => set({ tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, title } : t)) }),
  moveTab: (fromId, toId) => {
    const tabs = [...get().tabs];
    const from = tabs.findIndex((t) => t.id === fromId);
    const to = tabs.findIndex((t) => t.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [m] = tabs.splice(from, 1);
    tabs.splice(to, 0, m);
    set({ tabs });
  },
  focusPane: (paneId) => {
    if (get().focusedPaneId !== paneId) set({ focusedPaneId: paneId });
  },
  toggleFullscreen: (paneId) => {
    const id = paneId ?? get().focusedPaneId;
    set({ fullscreenPaneId: get().fullscreenPaneId ? null : id });
  },
  setSizes: (splitId, sizes) => {
    const tabs = get().tabs.map((t) => ({
      ...t,
      layout: mapNode(t.layout, (n) => (n.type === "split" && n.id === splitId ? { ...n, sizes } : n))!,
    }));
    set({ tabs });
  },
  setRuntime: (paneId, r) => {
    const prev = get().runtime[paneId] ?? { status: "idle", message: null, hop: null };
    set({ runtime: { ...get().runtime, [paneId]: { ...prev, ...r } } });
  },
  reconnect: (paneId) => {
    const { [paneId]: _d, ...deferred } = get().deferred;
    set({ deferred, reconnectNonce: { ...get().reconnectNonce, [paneId]: (get().reconnectNonce[paneId] ?? 0) + 1 } });
  },
  undefer: (paneId) => {
    const { [paneId]: _d, ...deferred } = get().deferred;
    set({ deferred });
  },
  setProject: (activeProject) => set({ activeProject }),
  setSidebarSection: (sidebarSection) => set({ sidebarSection }),
  restore: (w, deferConnect) => {
    const deferred: Record<Id, true> = {};
    if (deferConnect) for (const t of w.tabs) for (const l of leaves(t.layout)) if (l.target.kind !== "local") deferred[l.id] = true;
    const active = w.tabs.find((t) => t.id === w.activeTabId) ?? w.tabs[0];
    set({
      tabs: w.tabs,
      activeTabId: active?.id ?? null,
      focusedPaneId: active ? leaves(active.layout)[0].id : null,
      activeProject: w.activeProject,
      sidebarSection: w.sidebarSection || "hosts",
      deferred,
    });
  },
  snapshot: () => {
    const s = get();
    return { tabs: s.tabs, activeTabId: s.activeTabId, activeProject: s.activeProject, sidebarSection: s.sidebarSection };
  },
}));
