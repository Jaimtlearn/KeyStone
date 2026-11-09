import { useCallback, useEffect, useState } from "react";
import {
  ArrowUp, Download, File as FileIcon, Folder, FolderPlus, Home, Link2, Pencil, RefreshCw, Trash2, Upload, Laptop, Server, CheckCircle2, XCircle,
} from "lucide-react";
import { api, EVENTS, listen } from "../lib/api";
import type { FileEntry, Id, TransferProgress } from "../lib/types";
import { cx, formatBytes, joinPath, parentPath, relativeTime } from "../lib/format";
import { useData } from "../store/data";
import { toastError } from "../store/app";
import { openContextMenu } from "./ContextMenu";
import { promptText } from "./Dialogs";
import { useApp } from "../store/app";

interface Transfer extends TransferProgress {
  name: string;
  direction: "up" | "down";
}

/** Dual-pane local ⇄ remote browser over SFTP. */
export function FileBrowser({ hostId }: { hostId: Id }) {
  const host = useData((s) => s.hosts.find((h) => h.id === hostId));
  const [sftpId, setSftpId] = useState<Id | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [localSel, setLocalSel] = useState<FileEntry | null>(null);
  const [remoteSel, setRemoteSel] = useState<FileEntry | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let id: Id | null = null;
    let cancelled = false;
    setSftpId(null);
    setError(null);
    (async () => {
      try {
        const [sid, lhome] = await Promise.all([api.sftpOpen(hostId), api.localHome()]);
        if (cancelled) { void api.sftpClose(sid); return; }
        id = sid;
        setLocalPath((p) => p || lhome);
        const rhome = await api.sftpHome(sid);
        if (cancelled) return;
        setRemotePath(rhome);
        setSftpId(sid);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (id) void api.sftpClose(id).catch(() => {});
    };
  }, [hostId, attempt]);

  useEffect(() => {
    let un: (() => void) | undefined;
    void listen<TransferProgress>(EVENTS.transferProgress, (p) => {
      setTransfers((ts) => {
        const next = ts.map((t) => (t.transferId === p.transferId ? { ...t, ...p } : t));
        if (p.done && !p.error) setTimeout(() => setRefreshKey((k) => k + 1), 50);
        return next;
      });
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  const upload = async () => {
    if (!sftpId || !localSel || localSel.isDir) return;
    try {
      const target = joinPath(remotePath, localSel.name);
      const tid = await api.sftpUpload(sftpId, localSel.path, target);
      setTransfers((t) => [{ transferId: tid, bytes: 0, total: localSel.size, done: false, error: null, name: localSel.name, direction: "up" as const }, ...t].slice(0, 30));
    } catch (e) {
      toastError("Upload failed", e);
    }
  };
  const download = async () => {
    if (!sftpId || !remoteSel || remoteSel.isDir) return;
    try {
      const sep = /^[A-Za-z]:\\/.test(localPath) ? "\\" : "/";
      const target = joinPath(localPath, remoteSel.name, sep);
      const tid = await api.sftpDownload(sftpId, remoteSel.path, target);
      setTransfers((t) => [{ transferId: tid, bytes: 0, total: remoteSel.size, done: false, error: null, name: remoteSel.name, direction: "down" as const }, ...t].slice(0, 30));
    } catch (e) {
      toastError("Download failed", e);
    }
  };

  if (error) {
    return (
      <div className="fb" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="col" style={{ alignItems: "center" }}>
          <XCircle size={22} color="var(--danger)" />
          <b>Could not open SFTP on {host?.name}</b>
          <span className="muted selectable">{error}</span>
          <button className="btn" onClick={() => setAttempt((a) => a + 1)}><RefreshCw size={14} /> Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fb">
      <div className="fb-panes">
        <FilePane
          title="Local"
          icon={<Laptop size={14} />}
          path={localPath}
          setPath={setLocalPath}
          list={(p) => api.localList(p)}
          selected={localSel}
          setSelected={setLocalSel}
          refreshKey={refreshKey}
          ready={!!localPath}
          action={<button className="btn btn-sm" disabled={!sftpId || !localSel || localSel.isDir} onClick={upload} title="Upload selected file to the remote folder"><Upload size={13} /> Upload</button>}
        />
        <FilePane
          title={host?.name ?? "Remote"}
          icon={<Server size={14} />}
          path={remotePath}
          setPath={setRemotePath}
          list={(p) => api.sftpList(sftpId!, p)}
          selected={remoteSel}
          setSelected={setRemoteSel}
          refreshKey={refreshKey}
          ready={!!sftpId && !!remotePath}
          remote={sftpId ? { sftpId, refresh: () => setRefreshKey((k) => k + 1) } : undefined}
          action={<button className="btn btn-sm" disabled={!remoteSel || remoteSel.isDir} onClick={download} title="Download selected file to the local folder"><Download size={13} /> Download</button>}
        />
      </div>
      {transfers.length > 0 && (
        <div className="card panel-pad">
          <div className="row" style={{ marginBottom: 8 }}>
            <b className="grow" style={{ fontSize: 12 }}>Transfers</b>
            <button className="btn btn-ghost btn-sm" onClick={() => setTransfers((t) => t.filter((x) => !x.done))}>Clear finished</button>
          </div>
          <div className="transfers">
            {transfers.map((t) => {
              const pct = t.total ? Math.round((t.bytes / t.total) * 100) : t.done ? 100 : 0;
              return (
                <div key={t.transferId} className="transfer">
                  <span className="row truncate">
                    {t.direction === "up" ? <Upload size={12} /> : <Download size={12} />}
                    <span className="truncate">{t.name}</span>
                    {t.done && !t.error && <CheckCircle2 size={12} color="var(--success)" />}
                  </span>
                  <div className={cx("progress", t.done && "done", t.error && "err")} title={t.error ?? undefined}><div style={{ width: `${pct}%` }} /></div>
                  <span className="faint" style={{ fontSize: 11, textAlign: "right" }}>{t.error ? "failed" : `${formatBytes(t.bytes)}`}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function FilePane({ title, icon, path, setPath, list, selected, setSelected, refreshKey, ready, action, remote }: {
  title: string; icon: React.ReactNode; path: string; setPath: (p: string) => void; list: (p: string) => Promise<FileEntry[]>;
  selected: FileEntry | null; setSelected: (f: FileEntry | null) => void; refreshKey: number; ready: boolean; action: React.ReactNode;
  remote?: { sftpId: Id; refresh: () => void };
}) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [localRefresh, setLocalRefresh] = useState(0);

  const load = useCallback(async () => {
    if (!ready || !path) return;
    setEntries(null);
    setErr(null);
    try {
      const e = await list(path);
      setEntries([...e].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setEntries([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ready, refreshKey, localRefresh]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => setSelected(null), [path]); // eslint-disable-line react-hooks/exhaustive-deps

  const win = /^[A-Za-z]:\\/.test(path);
  const sep = win ? "\\" : "/";
  const crumbs = path.split(sep).filter(Boolean);

  const remoteMenu = (e: React.MouseEvent, f: FileEntry | null) => {
    if (!remote) return;
    const { sftpId, refresh } = remote;
    openContextMenu(e, [
      {
        label: "New folder…", icon: <FolderPlus size={14} />, onSelect: async () => {
          const name = await promptText("New folder", "Folder name", "", "Create");
          if (name) await api.sftpMkdir(sftpId, joinPath(path, name)).then(refresh).catch((x) => toastError("mkdir failed", x));
        },
      },
      ...(f
        ? ([
            {
              label: "Rename…", icon: <Pencil size={14} />, onSelect: async () => {
                const name = await promptText("Rename", "New name", f.name, "Rename");
                if (name && name !== f.name) await api.sftpRename(sftpId, f.path, joinPath(path, name)).then(refresh).catch((x) => toastError("Rename failed", x));
              },
            },
            { type: "sep" },
            {
              label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: async () => {
                const ok = await useApp.getState().askConfirm({ title: `Delete ${f.name}?`, body: f.isDir ? "The directory must be empty." : "This cannot be undone.", confirmLabel: "Delete", danger: true });
                if (ok) await api.sftpRemove(sftpId, f.path, f.isDir).then(refresh).catch((x) => toastError("Delete failed", x));
              },
            },
          ] as const)
        : []),
    ]);
  };

  return (
    <div className="fb-pane" onContextMenu={(e) => remoteMenu(e, null)}>
      <div className="fb-head">
        <span className="row muted" style={{ gap: 6, flex: "none" }}>{icon}<b style={{ color: "var(--text)", fontSize: 12 }}>{title}</b></span>
        <button className="btn btn-ghost btn-xs" title="Up" onClick={() => setPath(parentPath(path))}><ArrowUp size={13} /></button>
        <div className="fb-crumbs">
          <button onClick={() => setPath(win ? path.slice(0, 3) : "/")}>{win ? path.slice(0, 2) : <Home size={11} />}</button>
          {crumbs.slice(win ? 1 : 0).map((c, i, arr) => (
            <span key={i} className="row" style={{ gap: 2 }}>
              <span className="faint">/</span>
              <button onClick={() => setPath((win ? path.slice(0, 3) : "/") + arr.slice(0, i + 1).join(sep))}>{c}</button>
            </span>
          ))}
        </div>
        <button className={cx("btn btn-ghost btn-xs")} style={showHidden ? { color: "var(--accent)" } : undefined} title="Show hidden files" onClick={() => setShowHidden(!showHidden)}>.*</button>
        <button className="btn btn-ghost btn-xs" title="Refresh" onClick={() => setLocalRefresh((k) => k + 1)}><RefreshCw size={12} /></button>
        {action}
      </div>
      <div className="fb-list" onClick={() => setSelected(null)}>
        {!entries ? (
          <div style={{ padding: 12 }} className="col">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 18 }} />)}</div>
        ) : err ? (
          <div style={{ padding: 16 }} className="muted selectable">{err}</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 16 }} className="faint">Empty folder</div>
        ) : (
          entries
            .filter((f) => showHidden || !f.name.startsWith("."))
            .map((f) => (
              <div
                key={f.path}
                className={cx("fb-row", f.isDir && "dir", selected?.path === f.path && "selected")}
                onClick={(e) => { e.stopPropagation(); setSelected(f); }}
                onDoubleClick={() => f.isDir && setPath(f.path)}
                onContextMenu={(e) => { setSelected(f); remoteMenu(e, f); }}
                title={f.permissions ?? undefined}
              >
                {f.isSymlink ? <Link2 size={14} /> : f.isDir ? <Folder size={14} /> : <FileIcon size={14} />}
                <span className="truncate">{f.name}</span>
                <span className="size">{f.isDir ? "" : formatBytes(f.size)}</span>
                <span className="date">{f.modified ? relativeTime(f.modified) : ""}</span>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
