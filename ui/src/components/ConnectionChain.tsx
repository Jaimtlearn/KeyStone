import { Fragment } from "react";
import { Laptop, Server, Shield } from "lucide-react";
import { useData } from "../store/data";
import type { Host } from "../lib/types";
import { cx } from "../lib/format";

/**
 * Visual route: Local → bastion(s) → target.
 * `activeHop` (0-based index into jump chain + target) highlights progress during connect.
 */
export function ConnectionChain({ host, activeHop, mini, jumpChain }: { host: Host; activeHop?: number | null; mini?: boolean; jumpChain?: string[] }) {
  const hosts = useData((s) => s.hosts);
  const chain = (jumpChain ?? host.jumpChain).map((id) => hosts.find((h) => h.id === id));
  const iconSize = mini ? 11 : 13;
  const nodes = [
    ...chain.map((h, i) => ({ key: `j${i}`, label: h?.name ?? "missing host", kind: "bastion" as const, missing: !h })),
    { key: "t", label: host.name || host.hostname || "target", kind: "target" as const, missing: false },
  ];
  return (
    <div className={cx("chain", mini && "mini")}>
      <span className="chain-node local"><Laptop size={iconSize} />Local</span>
      {nodes.map((n, i) => (
        <Fragment key={n.key}>
          <span className="chain-link" />
          <span
            className={cx(
              "chain-node",
              n.kind,
              activeHop != null && i === activeHop && "active",
              activeHop != null && i < activeHop && "done",
            )}
            style={n.missing ? { color: "var(--danger)" } : undefined}
            title={n.missing ? "This jump host no longer exists" : undefined}
          >
            {n.kind === "bastion" ? <Shield size={iconSize} /> : <Server size={iconSize} />}
            {n.label}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
