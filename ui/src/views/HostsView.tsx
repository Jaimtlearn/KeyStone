import { useMemo, useState } from "react";
import {
  Download, FileInput, LayoutGrid, List, MoreHorizontal, Play, Plus, Search, Server, Shield, Star, Upload, X, Route, Tag,
} from "lucide-react";
import { useApp } from "../store/app";
import { useData } from "../store/data";
import { Empty, Seg } from "../components/ui";
import { openContextMenu } from "../components/ContextMenu";
import { hostMenuItems } from "../components/hostMenu";
import { HOST_DRAG, toneVar } from "../components/Sidebar";
import { connectHost } from "../lib/actions";
import { api } from "../lib/api";
import { pickOpenPath, pickSavePath } from "../lib/dialogs";
import { cx, envTone, relativeTime } from "../lib/format";
import { toast, toastError } from "../store/app";
import type { Folder, Host } from "../lib/types";

type Layout = "grid" | "list";
type GroupBy = "folder" | "environment" | "none";

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

export function matchesQuery(h: Host, q: string): boolean {
  if (!q) return true;
  if (q === "is:recent") return !!h.lastConnectedAt;
  const hay = [h.name, h.hostname, h.username, h.description, h.environment, h.project, ...h.tags].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
}

function folderPath(folders: Folder[], id: string | null): string {
  const parts: string[] = [];
  let cur = folders.find((f) => f.id === id);
  let guard = 0;
  while (cur && guard++ < 32) {
    parts.unshift(cur.name);
    cur = folders.find((f) => f.id === cur!.parentId);
  }
  return parts.join(" / ");
}

function descendants(folders: Folder[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

export function HostsView() {
  const hosts = useData((s) => s.hosts);
  const folders = useData((s) => s.folders);
  const loaded = useData((s) => s.loaded);
  const filter = useApp((s) => s.filter);
  const setFilter = useApp((s) => s.setFilter);
  const openEditor = useApp((s) => s.openHostEditor);
  const [layout, setLayout] = useState<Layout>(() => readPref("ks.hosts.layout", "grid"));
  const [groupBy, setGroupBy] = useState<GroupBy>(() => readPref("ks.hosts.group", "folder"));

  const filtered = useMemo(() => {
    const inFolder = filter.folderId ? descendants(folders, filter.folderId) : null;
    let list = hosts.filter(
      (h) =>
        matchesQuery(h, filter.query) &&
        (!inFolder || (h.folderId && inFolder.has(h.folderId))) &&
        (!filter.tag || h.tags.includes(filter.tag)) &&
        (!filter.environment || h.environment === filter.environment) &&
        (!filter.project || h.project === filter.project) &&
        (!filter.favorites || h.favorite),
    );
    if (filter.query === "is:recent") list = [...list].sort((a, b) => (b.lastConnectedAt ?? "").localeCompare(a.lastConnectedAt ?? ""));
    else list = [...list].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
    return list;
  }, [hosts, folders, filter]);

  const groups = useMemo(() => {
    if (groupBy === "none" || filter.query === "is:recent") return [{ key: "all", title: null as string | null, hosts: filtered }];
    const m = new Map<string, Host[]>();
    for (const h of filtered) {
      const k = groupBy === "folder" ? h.folderId ?? "" : h.environment ?? "";
      m.set(k, [...(m.get(k) ?? []), h]);
    }
    return [...m.entries()]
      .map(([k, hs]) => ({
        key: k,
        title: groupBy === "folder" ? (k ? folderPath(folders, k) : "Unfiled") : k || "No environment",
        hosts: hs,
      }))
      .sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : a.title!.localeCompare(b.title!)));
  }, [filtered, groupBy, folders, filter.query]);

  const activeFilters = [
    filter.folderId && { label: folderPath(folders, filter.folderId), clear: { folderId: null } },
    filter.environment && { label: filter.environment, clear: { environment: null } },
    filter.project && { label: filter.project, clear: { project: null } },
    filter.tag && { label: `#${filter.tag}`, clear: { tag: null } },
    filter.favorites && { label: "Favorites", clear: { favorites: false } },
  ].filter(Boolean) as { label: string; clear: Partial<typeof filter> }[];

  const importConfig = async () => {
    try {
      const n = await api.sshConfigImport(null);
      await useData.getState().load();
      toast({ kind: "success", title: `Imported ${n} host${n === 1 ? "" : "s"} from ~/.ssh/config` });
    } catch (e) {
      toastError("Import failed", e);
    }
  };
  const importProfiles = async () => {
    const path = await pickOpenPath({ title: "Import connection profiles", filters: [{ name: "Keystone profiles", extensions: ["json"] }] });
    if (!path) return;
    try {
      const n = await api.profilesImport(path);
      await useData.getState().load();
      toast({ kind: "success", title: `Imported ${n} profile${n === 1 ? "" : "s"}` });
    } catch (e) {
      toastError("Import failed", e);
    }
  };
  const exportProfiles = async () => {
    const path = await pickSavePath({ title: "Export connection profiles", defaultPath: "keystone-profiles.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    try {
      const ids = filtered.length !== hosts.length ? filtered.map((h) => h.id) : null;
      const n = await api.profilesExport(path, ids);
      toast({ kind: "success", title: `Exported ${n} profile${n === 1 ? "" : "s"}`, detail: "Profiles contain no secrets — only references to vault items." });
    } catch (e) {
      toastError("Export failed", e);
    }
  };

  return (
    <div className="view">
      <div className="view-head">
        <div className="grow">
          <h1 className="view-title">Hosts</h1>
          <div className="view-sub">
            {hosts.length} connection{hosts.length === 1 ? "" : "s"} · {hosts.filter((h) => h.isBastion).length} bastion{hosts.filter((h) => h.isBastion).length === 1 ? "" : "s"}
          </div>
        </div>
        <button
          className="btn btn-ghost btn-icon"
          title="Import / export"
          onClick={(e) =>
            openContextMenu(e, [
              { label: "Import from ~/.ssh/config", icon: <FileInput size={14} />, onSelect: importConfig },
              { label: "Import profiles…", icon: <Upload size={14} />, onSelect: importProfiles },
              { label: filtered.length !== hosts.length ? `Export ${filtered.length} filtered profiles…` : "Export all profiles…", icon: <Download size={14} />, onSelect: exportProfiles },
            ])
          }
        >
          <MoreHorizontal size={16} />
        </button>
        <button className="btn btn-primary" onClick={() => openEditor(null, { folderId: filter.folderId })}>
          <Plus size={15} /> New host
        </button>
      </div>

      <div className="toolbar">
        <div className="input-wrap" style={{ flex: "1 1 280px", maxWidth: 460 }}>
          <Search size={14} />
          <input
            className="input"
            placeholder="Filter by name, address, tag, project…"
            value={filter.query}
            onChange={(e) => setFilter({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && filtered[0]) connectHost(filtered[0].id);
              if (e.key === "Escape") setFilter({ query: "" });
            }}
          />
          {filter.query && (
            <span className="input-suffix">
              <button className="btn btn-ghost btn-xs" onClick={() => setFilter({ query: "" })} aria-label="Clear"><X size={12} /></button>
            </span>
          )}
        </div>
        {activeFilters.map((f) => (
          <span key={f.label} className="chip on" style={{ textTransform: "capitalize" }}>
            {f.label}
            <button onClick={() => setFilter(f.clear)} aria-label={`Remove filter ${f.label}`}><X size={11} /></button>
          </span>
        ))}
        <div className="grow" />
        <Seg
          value={groupBy}
          onChange={(v) => { setGroupBy(v); writePref("ks.hosts.group", v); }}
          options={[{ value: "folder", label: "Folder" }, { value: "environment", label: "Env" }, { value: "none", label: "Flat" }]}
        />
        <Seg
          value={layout}
          onChange={(v) => { setLayout(v); writePref("ks.hosts.layout", v); }}
          options={[
            { value: "grid", label: <LayoutGrid size={14} />, title: "Cards" },
            { value: "list", label: <List size={14} />, title: "List" },
          ]}
        />
      </div>

      <div className="view-body">
        {!loaded ? (
          <div className="host-grid">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 150 }} />)}</div>
        ) : hosts.length === 0 ? (
          <Empty
            icon={<Server size={22} />}
            title="No hosts yet"
            action={
              <div className="row">
                <button className="btn btn-primary" onClick={() => openEditor(null)}><Plus size={14} /> Add your first host</button>
                <button className="btn" onClick={importConfig}><FileInput size={14} /> Import ~/.ssh/config</button>
              </div>
            }
          >
            Add servers manually or import them from your OpenSSH config. Bastions you add once can be reused as jump hosts everywhere.
          </Empty>
        ) : filtered.length === 0 ? (
          <Empty icon={<Search size={22} />} title="Nothing matches">
            Try a different search or clear the filters.
          </Empty>
        ) : layout === "grid" ? (
          groups.map((g) => (
            <section key={g.key}>
              {g.title !== null && <div className="host-group-title">{g.title} <span className="faint">{g.hosts.length}</span></div>}
              <div className="host-grid">{g.hosts.map((h) => <HostCard key={h.id} host={h} />)}</div>
            </section>
          ))
        ) : (
          <HostTable groups={groups} />
        )}
      </div>
    </div>
  );
}

function initials(name: string) {
  const parts = name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(" ");
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase() || "?";
}

function EnvBadge({ env }: { env: string | null }) {
  if (!env) return null;
  return <span className={`badge tone-${envTone(env)}`}>{env}</span>;
}

function HostCard({ host: h }: { host: Host }) {
  const toggleFavorite = useData((s) => s.toggleFavorite);
  const tone = envTone(h.environment);
  const hops = h.jumpChain.length;
  return (
    <div
      className="host-card"
      tabIndex={0}
      role="button"
      aria-label={`Connect to ${h.name}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData(HOST_DRAG, h.id)}
      style={{ ["--lintel" as string]: h.color ?? (tone === "neutral" ? undefined : `var(--${toneVar(tone)})`) }}
      onDoubleClick={() => connectHost(h.id)}
      onKeyDown={(e) => e.key === "Enter" && connectHost(h.id)}
      onContextMenu={(e) => openContextMenu(e, hostMenuItems(h))}
    >
      <span className="lintel" />
      <div className="host-card-head">
        <div className="host-avatar" style={h.isBastion ? { color: "var(--warning)" } : undefined}>
          {h.isBastion ? <Shield size={16} /> : initials(h.name)}
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className="host-name truncate">{h.name || h.hostname}</span>
          </div>
          <div className="host-addr truncate">
            {h.username}@{h.hostname}
            {h.port !== 22 && <span className="faint">:{h.port}</span>}
          </div>
        </div>
        <div className="host-actions">
          <button className={cx("btn btn-ghost btn-xs fav", h.favorite && "on")} onClick={(e) => { e.stopPropagation(); void toggleFavorite(h.id); }} aria-label="Toggle favorite">
            <Star size={13} fill={h.favorite ? "currentColor" : "none"} />
          </button>
          <button className="btn btn-ghost btn-xs" onClick={(e) => openContextMenu(e, hostMenuItems(h))} aria-label="More actions">
            <MoreHorizontal size={14} />
          </button>
        </div>
        {h.favorite && <Star size={12} className="fav on" fill="currentColor" style={{ flex: "none", marginTop: 3 }} />}
      </div>

      <div className="host-tags">
        <EnvBadge env={h.environment} />
        {h.isBastion && <span className="badge tone-warning">bastion</span>}
        {h.tags.slice(0, 3).map((t) => <span key={t} className="chip"><Tag size={9} />{t}</span>)}
        {h.tags.length > 3 && <span className="chip">+{h.tags.length - 3}</span>}
      </div>

      <div className="host-meta">
        {hops > 0 ? (
          <span className="row" style={{ gap: 4 }} title="Connects via jump host(s)">
            <Route size={12} /> via {hops === 1 ? useData.getState().hosts.find((x) => x.id === h.jumpChain[0])?.name ?? "jump host" : `${hops} hops`}
          </span>
        ) : (
          <span>{relativeTime(h.lastConnectedAt)}</span>
        )}
        <button
          className="btn btn-sm connect-cta"
          onClick={(e) => { e.stopPropagation(); connectHost(h.id); }}
        >
          <Play size={12} /> Connect
        </button>
      </div>
    </div>
  );
}

function HostTable({ groups }: { groups: { key: string; title: string | null; hosts: Host[] }[] }) {
  return (
    <table className="host-table">
      <thead>
        <tr>
          <th style={{ width: 28 }} />
          <th>Name</th>
          <th>Address</th>
          <th>Environment</th>
          <th>Route</th>
          <th>Tags</th>
          <th>Last connected</th>
          <th style={{ width: 90 }} />
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => [
          g.title !== null && (
            <tr key={`g-${g.key}`}>
              <td colSpan={8} style={{ height: 34, paddingTop: 12 }}>
                <span className="muted" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase" }}>{g.title}</span>
              </td>
            </tr>
          ),
          ...g.hosts.map((h) => (
            <tr
              key={h.id}
              className="host-row"
              tabIndex={0}
              draggable
              onDragStart={(e) => e.dataTransfer.setData(HOST_DRAG, h.id)}
              onDoubleClick={() => connectHost(h.id)}
              onKeyDown={(e) => e.key === "Enter" && connectHost(h.id)}
              onContextMenu={(e) => openContextMenu(e, hostMenuItems(h))}
            >
              <td>{h.favorite ? <Star size={12} className="fav on" fill="currentColor" /> : h.isBastion ? <Shield size={13} color="var(--warning)" /> : <Server size={13} className="faint" />}</td>
              <td style={{ fontWeight: 500 }}>{h.name}</td>
              <td className="mono muted">{h.username}@{h.hostname}{h.port !== 22 ? `:${h.port}` : ""}</td>
              <td><EnvBadge env={h.environment} /></td>
              <td>{h.jumpChain.length ? <RouteText host={h} /> : <span className="faint">direct</span>}</td>
              <td><div className="row" style={{ gap: 4 }}>{h.tags.slice(0, 3).map((t) => <span key={t} className="chip">{t}</span>)}</div></td>
              <td className="muted">{relativeTime(h.lastConnectedAt)}</td>
              <td>
                <div className="row" style={{ gap: 2, justifyContent: "flex-end" }}>
                  <button className="btn btn-ghost btn-xs" title="Connect" onClick={() => connectHost(h.id)}><Play size={13} /></button>
                  <button className="btn btn-ghost btn-xs" title="More" onClick={(e) => openContextMenu(e, hostMenuItems(h))}><MoreHorizontal size={13} /></button>
                </div>
              </td>
            </tr>
          )),
        ])}
      </tbody>
    </table>
  );
}

function RouteText({ host }: { host: Host }) {
  const hosts = useData((s) => s.hosts);
  const names = host.jumpChain.map((id) => hosts.find((x) => x.id === id)?.name ?? "missing");
  return (
    <span className="row muted" style={{ gap: 4, fontSize: 12 }} title={["Local", ...names, host.name].join(" → ")}>
      <Route size={12} />
      <span className="truncate" style={{ maxWidth: 220 }}>{names.join(" → ")}</span>
    </span>
  );
}
