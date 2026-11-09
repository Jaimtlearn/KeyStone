import {
  Cloud, Database, FileKey, Key, KeyRound, LockKeyhole, Network, StickyNote, Boxes, Server, Shield, Zap,
} from "lucide-react";
import type { CredentialKind } from "../lib/types";

export function CredIcon({ kind, size = 16 }: { kind: CredentialKind; size?: number }) {
  switch (kind) {
    case "sshKey": return <KeyRound size={size} />;
    case "sshPassword": return <Key size={size} />;
    case "password": return <LockKeyhole size={size} />;
    case "mysql":
    case "postgres":
    case "clickhouse": return <Database size={size} />;
    case "redis": return <Zap size={size} />;
    case "apiToken": return <FileKey size={size} />;
    case "aws": return <Cloud size={size} />;
    case "kubernetes": return <Boxes size={size} />;
    case "secureNote": return <StickyNote size={size} />;
  }
}

export { Server as HostIcon, Shield as BastionIcon, Network as TunnelIcon };
