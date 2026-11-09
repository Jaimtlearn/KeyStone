import { useState } from "react";
import { FolderOpen, Server } from "lucide-react";
import { useData } from "../store/data";
import { FileBrowser } from "../components/FileBrowser";
import { Empty } from "../components/ui";

export function FilesView() {
  const hosts = useData((s) => s.hosts);
  const [hostId, setHostId] = useState<string>("");
  const sorted = [...hosts].sort((a, b) => (b.lastConnectedAt ?? "").localeCompare(a.lastConnectedAt ?? "") || a.name.localeCompare(b.name));

  return (
    <div className="view">
      <div className="view-head">
        <div className="grow">
          <h1 className="view-title">Files</h1>
          <div className="view-sub">Transfer files between this machine and a server over SFTP — jump hosts are used automatically.</div>
        </div>
        <div className="row">
          <Server size={14} className="muted" />
          <select className="select" style={{ width: 280 }} value={hostId} onChange={(e) => setHostId(e.target.value)}>
            <option value="">Choose a host…</option>
            {sorted.map((h) => (
              <option key={h.id} value={h.id}>{h.name} — {h.username}@{h.hostname}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="view-body" style={{ display: "flex" }}>
        {hostId ? (
          <FileBrowser key={hostId} hostId={hostId} />
        ) : (
          <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
            <Empty icon={<FolderOpen size={22} />} title="Pick a host to browse">
              You can also right-click any host and choose “Open SFTP” to open a browser in a tab.
            </Empty>
          </div>
        )}
      </div>
    </div>
  );
}
