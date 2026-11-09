import { useMemo, useRef, useState, type DragEvent } from "react";
import {
  ChevronRight, Clock, Folder as FolderIcon, FolderOpen, FolderPlus, Layers, Pencil, Plus, Server, Star, Tag, Trash2, Briefcase, X, TerminalSquare,
} from "lucide-react";
import { openContextMenu } from "./ContextMenu";
import { promptText } from "./Dialogs";
import { useApp, type HostFilter } from "../store/app";
import { useData } from "../store/data";
import { useWorkspace, leaves } from "../store/workspace";
import { useVaultFilter } from "../store/vaultFilter";
import { CREDENTIAL_KINDS, newId } from "../lib/defaults";
import { cx, envTone } from "../lib/format";
import { CredIcon } from "./icons";
import type { Folder, Id } from "../lib/types";

const HOST_DRAG = "application/x-keystone-host";
const FOLDER_DRAG = "application/x-keystone-folder";

export function Sidebar() {
  const view = useApp((s) => s.view);
  const ui = useApp((s) => s.settings.ui);
  const update = useApp((s) => s.updateSettings);
  const narrow = useApp((s) => s.narrow);
  const collapsed = ui.sidebarCollapsed || narrow;
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onResizeDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    startX.current = e.clientX;
    startW.current = ui.sidebarWidth;
    setDragging(true);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const dir = ui.sidebarPosition === "right" ? -1 : 1;
    const w = Math.round(Math.min(440, Math.max(200, startW.current + (e.clientX - startX.current) * dir)));
    document.documentElement.style.setProperty("--sidebar-width", `${w}px`);
  };
  const onResizeUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragging(false);
    const dir = ui.sidebarPosition === "right" ? -1 : 1;
    const w = Math.round(Math.min(440, Math.max(200, startW.current + (e.clientX - startX.current) * dir)));
    update((s) => ({ ...s, ui: { ...s.ui, sidebarWidth: w } }));
  };

  if (view === "settings") return null;

  return (
    <aside className={cx("sidebar", collapsed && "collapsed")} aria-label="Navigation">
      {view === "vault" ? <VaultSidebar /> : <HostsSidebar />}
      <div
        className={cx("sidebar-resizer", dragging && "dragging")}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onDoubleClick={() => update((s) => ({ ...s, ui: { ...s.ui, sidebarWidth: 264 } }))}
        role="separator"
        aria-orientation="vertical"
      />
    </aside>
  );
}

// ───────────────────────── hosts sidebar ─────────────────────────

function HostsSidebar() {
  const hosts = useData((s) => s.hosts);
  const folders = useData((s) => s.folders);
  const filter = useApp((s) => s.filter);
  const setFilter = useApp((s) => s.setFilter);
  const setView = useApp((s) => s.setView);
  const view = useApp((s) => s.view);

  const pick = (p: Partial<HostFilter>) => {
    setFilter({ folderId: null, tag: null, environment: null, project: null, favorites: false, ...p });
    if (view !== "hosts") setView("hosts");
  };
  const isAll = !filter.folderId && !filter.tag && !filter.environment && !filter.project && !filter.favorites;

  const envs = useMemo(() => countBy(hosts.map((h) => h.environment).filter(Boolean) as string[]), [hosts]);
  const projects = useMemo(() => countBy(hosts.map((h) => h.project).filter(Boolean) as string[]), [hosts]);
  const tags = useMemo(() => countBy(hosts.flatMap((h) => h.tags)), [hosts]);
  const favCount = hosts.filter((h) => h.favorite).length;

  const newFolder = async (parentId: Id | null) => {
    const name = await promptText("New folder", "Folder name", "", "Create");
    if (name) await useData.getState().saveFolder({ id: newId(), name, parentId, color: null, icon: null, sortOrder: folders.length });
  };

  return (
    <>
      <div className="sidebar-head">
        <span className="sidebar-title grow">Library</span>
        <button className="btn btn-ghost btn-xs" title="New folder" onClick={() => newFolder(null)}><FolderPlus size={14} /></button>
        <button className="btn btn-ghost btn-xs" title="New host" onClick={() => useApp.getState().openHostEditor(null)}><Plus size={14} /></button>
      </div>
      <div className="sidebar-scroll">
        <div className={cx("tree-row", isAll && view === "hosts" && "active")} onClick={() => pick({})}>
          <Server size={14} /> All hosts <span className="count">{hosts.length}</span>
        </div>
        <div className={cx("tree-row", filter.favorites && "active")} onClick={() => pick({ favorites: true })}>
          <Star size={14} /> Favorites <span className="count">{favCount}</span>
        </div>
        <RecentRow />
        <OpenSessions />

        <div className="sidebar-section">
          <div className="sidebar-title">Folders</div>
          <FolderTree parentId={null} depth={0} onNewFolder={newFolder} />
          {folders.length === 0 && <div className="faint" style={{ padding: "4px 8px", fontSize: 12 }}>No folders yet</div>}
        </div>

        {envs.length > 0 && (
          <div className="sidebar-section">
            <div className="sidebar-title">Environments</div>
            {envs.map(([env, n]) => (
              <div key={env} className={cx("tree-row", filter.environment === env && "active")} onClick={() => pick({ environment: env })}>
                <span className="dot" style={{ background: `var(--${toneVar(envTone(env))})` }} />
                <span style={{ textTransform: "capitalize" }}>{env}</span>
                <span className="count">{n}</span>
              </div>
            ))}
          </div>
        )}

        {projects.length > 0 && (
          <div className="sidebar-section">
            <div className="sidebar-title">Projects</div>
            {projects.map(([p, n]) => (
              <div key={p} className={cx("tree-row", filter.project === p && "active")} onClick={() => pick({ project: p })}>
                <Briefcase size={14} /> <span className="truncate">{p}</span> <span className="count">{n}</span>
              </div>
            ))}
          </div>
        )}

        {tags.length > 0 && (
          <div className="sidebar-section">
            <div className="sidebar-title">Tags</div>
            <div className="tag-cloud">
              {tags.slice(0, 40).map(([t]) => (
                <span key={t} className={cx("chip clickable", filter.tag === t && "on")} onClick={() => pick(filter.tag === t ? {} : { tag: t })}>
                  <Tag size={10} /> {t}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function RecentRow() {
  const recent = useData((s) => s.hosts.filter((h) => h.lastConnectedAt).length);
  const q = useApp((s) => s.filter.query);
  const setFilter = useApp((s) => s.setFilter);
  const active = q === "is:recent";
  return (
    <div
      className={cx("tree-row", active && "active")}
      onClick={() => {
        setFilter({ folderId: null, tag: null, environment: null, project: null, favorites: false, query: active ? "" : "is:recent" });
        useApp.getState().setView("hosts");
      }}
    >
      <Clock size={14} /> Recent <span className="count">{recent}</span>
    </div>
  );
}

function OpenSessions() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const runtime = useWorkspace((s) => s.runtime);
  const view = useApp((s) => s.view);
  if (!tabs.length) return null;
  return (
    <div className="sidebar-section">
      <div className="sidebar-title">Open sessions</div>
      {tabs.map((t) => {
        const st = leaves(t.layout).map((l) => runtime[l.id]?.status ?? "idle");
        const status = st.includes("error") ? "error" : st.includes("connecting") || st.includes("reconnecting") ? "connecting" : st.includes("connected") ? "connected" : "closed";
        return (
          <div
            key={t.id}
            className={cx("tree-row", view === "terminal" && t.id === activeTabId && "active")}
            onClick={() => {
              useWorkspace.getState().activateTab(t.id);
              useApp.getState().setView("terminal");
            }}
          >
            <TerminalSquare size={14} />
            <span className="truncate">{t.title}</span>
            <span className="count"><span className={cx("status-dot", status)} style={{ display: "inline-block" }} /></span>
          </div>
        );
      })}
    </div>
  );
}

function FolderTree({ parentId, depth, onNewFolder }: { parentId: Id | null; depth: number; onNewFolder: (p: Id | null) => void }) {
  const folders = useData((s) => s.folders);
  const children = folders.filter((f) => f.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  return (
    <>
      {children.map((f) => (
        <FolderRow key={f.id} folder={f} depth={depth} onNewFolder={onNewFolder} />
      ))}
    </>
  );
}

function descendantIds(folders: Folder[], id: Id): Set<Id> {
  const out = new Set<Id>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

function FolderRow({ folder, depth, onNewFolder }: { folder: Folder; depth: number; onNewFolder: (p: Id | null) => void }) {
  const folders = useData((s) => s.folders);
  const hosts = useData((s) => s.hosts);
  const filter = useApp((s) => s.filter);
  const setFilter = useApp((s) => s.setFilter);
  const [open, setOpen] = useState(depth < 1);
  const [drop, setDrop] = useState(false);
  const hasChildren = folders.some((f) => f.parentId === folder.id);
  const subtree = useMemo(() => descendantIds(folders, folder.id), [folders, folder.id]);
  const count = hosts.filter((h) => h.folderId && subtree.has(h.folderId)).length;
  const active = filter.folderId === folder.id;

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDrop(false);
    const data = useData.getState();
    const hostId = e.dataTransfer.getData(HOST_DRAG);
    const folderId = e.dataTransfer.getData(FOLDER_DRAG);
    if (hostId) {
      const h = data.hosts.find((x) => x.id === hostId);
      if (h && h.folderId !== folder.id) await data.saveHost({ ...h, folderId: folder.id });
    } else if (folderId && folderId !== folder.id) {
      const f = data.folders.find((x) => x.id === folderId);
      if (f && !descendantIds(data.folders, folderId).has(folder.id)) await data.saveFolder({ ...f, parentId: folder.id });
    }
  };

  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { label: "New host here", icon: <Plus size={14} />, onSelect: () => useApp.getState().openHostEditor(null, { folderId: folder.id }) },
      { label: "New subfolder", icon: <FolderPlus size={14} />, onSelect: () => onNewFolder(folder.id) },
      {
        label: "Rename…",
        icon: <Pencil size={14} />,
        onSelect: async () => {
          const name = await promptText("Rename folder", "Folder name", folder.name);
          if (name) await useData.getState().saveFolder({ ...folder, name });
        },
      },
      ...(folder.parentId ? [{ label: "Move to top level", icon: <Layers size={14} />, onSelect: () => void useData.getState().saveFolder({ ...folder, parentId: null }) }] : []),
      { type: "sep" },
      {
        label: "Delete folder",
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: async () => {
          const ok = await useApp.getState().askConfirm({
            title: `Delete “${folder.name}”?`,
            body: "Hosts and subfolders inside it move up one level. No hosts are deleted.",
            confirmLabel: "Delete folder",
            danger: true,
          });
          if (ok) {
            if (active) setFilter({ folderId: null });
            await useData.getState().deleteFolder(folder.id);
          }
        },
      },
    ]);

  return (
    <>
      <div
        className={cx("tree-row", active && "active", drop && "drop-target")}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable
        onDragStart={(e) => e.dataTransfer.setData(FOLDER_DRAG, folder.id)}
        onDragOver={(e) => { e.preventDefault(); setDrop(true); }}
        onDragLeave={() => setDrop(false)}
        onDrop={onDrop}
        onClick={() => {
          setFilter({ folderId: active ? null : folder.id, tag: null, environment: null, project: null, favorites: false, query: "" });
          useApp.getState().setView("hosts");
        }}
        onContextMenu={menu}
      >
        <span
          className={cx("chev", open && "open")}
          style={{ visibility: hasChildren ? "visible" : "hidden" }}
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        >
          <ChevronRight size={12} />
        </span>
        {open && hasChildren ? <FolderOpen size={14} color={folder.color ?? undefined} /> : <FolderIcon size={14} color={folder.color ?? undefined} />}
        <span className="truncate">{folder.name}</span>
        <span className="count">{count || ""}</span>
      </div>
      {open && hasChildren && <FolderTree parentId={folder.id} depth={depth + 1} onNewFolder={onNewFolder} />}
    </>
  );
}

export { HOST_DRAG };

// ───────────────────────── vault sidebar ─────────────────────────

function VaultSidebar() {
  const creds = useData((s) => s.credentials);
  const unlocked = useData((s) => s.vault?.unlocked);
  const { kind, setKind, expiring, setExpiring } = useVaultFilter();
  const counts = countBy(creds.map((c) => c.kind));
  const expCount = creds.filter((c) => c.expiresAt && new Date(c.expiresAt).getTime() - Date.now() < 14 * 864e5).length;
  return (
    <>
      <div className="sidebar-head"><span className="sidebar-title grow">Vault</span></div>
      <div className="sidebar-scroll">
        {!unlocked ? (
          <div className="faint" style={{ padding: "4px 8px", fontSize: 12 }}>Unlock the vault to browse credentials.</div>
        ) : (
          <>
            <div className={cx("tree-row", !kind && !expiring && "active")} onClick={() => { setKind(null); setExpiring(false); }}>
              <Layers size={14} /> All items <span className="count">{creds.length}</span>
            </div>
            <div className={cx("tree-row", expiring && "active")} onClick={() => { setKind(null); setExpiring(true); }}>
              <Clock size={14} /> Expiring / expired <span className="count">{expCount || ""}</span>
            </div>
            <div className="sidebar-section">
              <div className="sidebar-title">Types</div>
              {CREDENTIAL_KINDS.map((k) => (
                <div key={k.kind} className={cx("tree-row", kind === k.kind && "active")} onClick={() => { setKind(kind === k.kind ? null : k.kind); setExpiring(false); }}>
                  <CredIcon kind={k.kind} size={14} /> {k.label}
                  <span className="count">{counts.find(([x]) => x === k.kind)?.[1] ?? ""}</span>
                </div>
              ))}
            </div>
            {(kind || expiring) && (
              <div style={{ padding: "12px 8px" }}>
                <button className="btn btn-ghost btn-sm" onClick={() => { setKind(null); setExpiring(false); }}><X size={12} /> Clear filter</button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ───────────────────────── helpers ─────────────────────────

function countBy(list: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function toneVar(t: ReturnType<typeof envTone>) {
  return t === "info" ? "accent" : t === "neutral" ? "text-faint" : t;
}
