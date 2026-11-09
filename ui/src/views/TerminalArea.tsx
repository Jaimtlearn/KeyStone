import { Fragment, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Plus, TerminalSquare } from "lucide-react";
import { useApp } from "../store/app";
import { leaves, useWorkspace } from "../store/workspace";
import { TerminalPane } from "../components/TerminalPane";
import { FileBrowser } from "../components/FileBrowser";
import { Empty, Kbd } from "../components/ui";
import { openLocalTerminal } from "../lib/actions";
import { cx } from "../lib/format";
import type { Id, PaneNode } from "../lib/types";

/*
 * Pane content (xterm instances, SFTP browsers) is rendered through portals into
 * one persistent DOM element per pane. The layout tree only renders empty "slots"
 * and moves that element into place. This way splitting, closing siblings or
 * re-arranging panes never remounts a terminal — the SSH session survives.
 */
const paneEls = new Map<Id, HTMLDivElement>();
function paneEl(id: Id): HTMLDivElement {
  let el = paneEls.get(id);
  if (!el) {
    el = document.createElement("div");
    el.style.cssText = "width:100%;height:100%;display:flex;min-width:0;min-height:0";
    paneEls.set(id, el);
  }
  return el;
}

/** Always mounted so terminals keep their sessions while other views are shown. */
export function TerminalArea() {
  const view = useApp((s) => s.view);
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const kb = useApp((s) => s.settings.keybindings);
  const visible = view === "terminal";

  return (
    <div className={cx("term-area", !visible && "hidden")}>
      {tabs.length === 0 && visible && (
        <div className="view" style={{ justifyContent: "center" }}>
          <Empty
            icon={<TerminalSquare size={22} />}
            title="No open sessions"
            action={
              <button className="btn btn-primary" onClick={() => openLocalTerminal()}>
                <Plus size={14} /> New local terminal <Kbd combo={kb["terminal.newLocal"] ?? ""} />
              </button>
            }
          >
            Connect to a host from the Hosts view, or press <Kbd combo={kb["palette.open"] ?? "Ctrl+K"} /> to search.
          </Empty>
        </div>
      )}
      {tabs.map((t) => (
        <div key={t.id} className={cx("term-tab", t.id !== activeTabId && "inactive")}>
          <PaneTree node={t.layout} />
        </div>
      ))}
      {tabs.flatMap((t) =>
        leaves(t.layout).map((l) => (
          <PaneHost key={l.id} leaf={l} visible={visible && t.id === activeTabId} />
        )),
      )}
    </div>
  );
}

function PaneHost({ leaf, visible }: { leaf: Extract<PaneNode, { type: "leaf" }>; visible: boolean }) {
  const el = paneEl(leaf.id);
  useLayoutEffect(() => () => {
    el.remove();
    paneEls.delete(leaf.id);
  }, [el, leaf.id]);
  const content =
    leaf.target.kind === "sftp" ? (
      <div className="pane" style={{ background: "var(--bg)" }}>
        <div style={{ padding: 10, display: "flex", flex: 1, minHeight: 0 }}>
          <FileBrowser hostId={leaf.target.hostId} />
        </div>
      </div>
    ) : (
      <TerminalPane paneId={leaf.id} target={leaf.target} visible={visible} />
    );
  return createPortal(content, el);
}

function PaneSlot({ id }: { id: Id }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = paneEl(id);
    if (ref.current && el.parentElement !== ref.current) ref.current.appendChild(el);
  });
  return <div ref={ref} style={{ width: "100%", height: "100%", display: "flex", minWidth: 0, minHeight: 0 }} />;
}

function PaneTree({ node }: { node: PaneNode }) {
  const setSizes = useWorkspace((s) => s.setSizes);
  if (node.type === "leaf") return <PaneSlot id={node.id} />;
  const childIds = node.children.map((c) => c.id);
  return (
    <Group
      key={node.id + childIds.join()}
      className="pane-group"
      orientation={node.direction}
      onLayoutChanged={(layout) => {
        const sizes = childIds.map((id) => layout[id] ?? 100 / childIds.length);
        if (sizes.some((s, i) => Math.abs(s - (node.sizes[i] ?? 0)) > 0.5)) setSizes(node.id, sizes);
      }}
    >
      {node.children.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && <Separator className="split-handle" />}
          <Panel id={c.id} defaultSize={`${node.sizes[i] ?? 100 / node.children.length}%`} minSize="8%">
            <PaneTree node={c} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}
