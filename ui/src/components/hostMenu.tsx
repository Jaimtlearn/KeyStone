import { Columns2, Copy, CopyPlus, FolderOpen, Pencil, Play, Rows2, Star, Trash2 } from "lucide-react";
import type { MenuItem } from "./ContextMenu";
import type { Host } from "../lib/types";
import { connectHost, openSftp } from "../lib/actions";
import { toast, useApp } from "../store/app";
import { useData } from "../store/data";

export function hostMenuItems(h: Host): MenuItem[] {
  const app = useApp.getState();
  const data = useData.getState();
  return [
    { label: "Connect", icon: <Play size={14} />, onSelect: () => connectHost(h.id) },
    { label: "Connect in split (right)", icon: <Columns2 size={14} />, onSelect: () => connectHost(h.id, "right") },
    { label: "Connect in split (down)", icon: <Rows2 size={14} />, onSelect: () => connectHost(h.id, "down") },
    { label: "Open SFTP", icon: <FolderOpen size={14} />, onSelect: () => openSftp(h.id) },
    { type: "sep" },
    { label: "Edit…", icon: <Pencil size={14} />, onSelect: () => app.openHostEditor(h.id) },
    { label: "Duplicate", icon: <CopyPlus size={14} />, onSelect: () => void data.duplicateHost(h.id) },
    { label: h.favorite ? "Remove from favorites" : "Add to favorites", icon: <Star size={14} />, onSelect: () => void data.toggleFavorite(h.id) },
    {
      label: "Copy hostname",
      icon: <Copy size={14} />,
      onSelect: () => {
        void navigator.clipboard.writeText(h.hostname);
        toast({ kind: "success", title: "Hostname copied", detail: h.hostname }, 2000);
      },
    },
    { type: "sep" },
    {
      label: "Delete",
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: async () => {
        const dependents = data.hosts.filter((x) => x.jumpChain.includes(h.id));
        const ok = await app.askConfirm({
          title: `Delete “${h.name}”?`,
          body: dependents.length
            ? `${dependents.length} host(s) use it as a jump host and will lose that hop: ${dependents.map((d) => d.name).join(", ")}.`
            : "This removes the connection profile. Vault credentials are not deleted.",
          confirmLabel: "Delete host",
          danger: true,
        });
        if (ok) await data.deleteHost(h.id);
      },
    },
  ];
}
