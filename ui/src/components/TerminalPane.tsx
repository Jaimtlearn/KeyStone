import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { ArrowDown, ArrowUp, Columns2, Maximize2, Minimize2, Monitor, Play, RotateCcw, Rows2, Search, Server, X, CaseSensitive, Regex } from "lucide-react";
import { api } from "../lib/api";
import { liveTerminals } from "../lib/sessions";
import { b64ToBytes, cx } from "../lib/format";
import { matchBinding } from "../lib/keys";
import { copyTerminalSelection, pasteIntoTerminal } from "../lib/actions";
import { useApp } from "../store/app";
import { useData } from "../store/data";
import { useWorkspace } from "../store/workspace";
import { findTheme, xtermTheme } from "../theme/apply";
import { ConnectionChain } from "./ConnectionChain";
import type { Id, PaneTarget, TermEvent } from "../lib/types";

interface Props {
  paneId: Id;
  target: Extract<PaneTarget, { kind: "ssh" } | { kind: "local" }>;
  visible: boolean;
}

export function TerminalPane({ paneId, target, visible }: Props) {
  const hostEl = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const sessionRef = useRef<Id | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const settings = useApp((s) => s.settings);
  const host = useData((s) => (target.kind === "ssh" ? s.hosts.find((h) => h.id === target.hostId) : undefined));
  const focused = useWorkspace((s) => s.focusedPaneId === paneId);
  const fullscreen = useWorkspace((s) => s.fullscreenPaneId === paneId);
  const runtime = useWorkspace((s) => s.runtime[paneId]);
  const deferred = useWorkspace((s) => !!s.deferred[paneId]);
  const nonce = useWorkspace((s) => s.reconnectNonce[paneId] ?? 0);
  const ws = useWorkspace.getState;

  const overrides = host?.terminal;
  const theme = findTheme(settings, overrides?.themeId ?? settings.themeId);

  // ── create terminal once ──
  useEffect(() => {
    const s = useApp.getState().settings;
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: `${overrides?.fontFamily ?? s.terminal.fontFamily}, "JetBrains Mono", monospace`,
      fontSize: overrides?.fontSize ?? s.terminal.fontSize,
      lineHeight: s.terminal.lineHeight,
      cursorStyle: s.terminal.cursorStyle,
      cursorBlink: s.terminal.cursorBlink,
      scrollback: overrides?.scrollback ?? s.terminal.scrollback,
      theme: xtermTheme(theme),
      allowTransparency: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    term.open(hostEl.current!);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // App shortcuts win over the terminal; Ctrl+Shift+C/V are copy/paste.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.ctrlKey && e.shiftKey && e.code === "KeyC") { void copyTerminalSelection(); return false; }
      if (e.ctrlKey && e.shiftKey && e.code === "KeyV") { void pasteIntoTerminal(); return false; }
      if (matchBinding(useApp.getState().settings.keybindings, e)) return false;
      return true;
    });
    const dataSub = term.onData((d) => {
      if (sessionRef.current) void api.sessionWrite(sessionRef.current, d).catch(() => {});
    });
    const selSub = term.onSelectionChange(() => {
      if (useApp.getState().settings.terminal.copyOnSelect) {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
      }
    });
    term.textarea?.addEventListener("focus", () => ws().focusPane(paneId));

    liveTerminals.set(paneId, { term, search, sessionId: null, openSearch: () => setSearchOpen(true) });

    let lastCols = 0;
    let lastRows = 0;
    const ro = new ResizeObserver(() => {
      const el = hostEl.current;
      if (!el || el.clientWidth < 20 || el.clientHeight < 20) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        if (sessionRef.current) void api.sessionResize(sessionRef.current, term.cols, term.rows).catch(() => {});
      }
    });
    ro.observe(hostEl.current!);

    return () => {
      ro.disconnect();
      dataSub.dispose();
      selSub.dispose();
      liveTerminals.delete(paneId);
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  // ── connect / reconnect ──
  useEffect(() => {
    const term = termRef.current;
    if (!term || deferred) {
      if (deferred) ws().setRuntime(paneId, { status: "idle", message: null, hop: null });
      return;
    }
    let cancelled = false;
    let sid: Id | null = null;
    if (nonce > 0) term.write("\r\n\x1b[2m── reconnecting ──\x1b[0m\r\n");
    ws().setRuntime(paneId, { status: "connecting", message: null, hop: null });

    const onEvent = (e: TermEvent) => {
      if (cancelled) return;
      if (e.type === "data") term.write(b64ToBytes(e.data));
      else if (e.type === "status") {
        ws().setRuntime(paneId, { status: e.status, message: e.message, ...(e.status === "connected" ? { hop: null } : {}) });
        if (e.status === "connected") {
          // the PTY may have been created with a stale size
          try { fitRef.current?.fit(); } catch { /* hidden */ }
          if (sid) void api.sessionResize(sid, term.cols, term.rows).catch(() => {});
        }
      } else if (e.type === "hop") ws().setRuntime(paneId, { hop: { index: e.index, total: e.total, name: e.name } });
    };

    try { fitRef.current?.fit(); } catch { /* not visible yet */ }
    const cols = Math.max(term.cols, 20);
    const rows = Math.max(term.rows, 5);
    const p = target.kind === "ssh" ? api.sshOpen(target.hostId, cols, rows, onEvent) : api.localOpen(target.shell, cols, rows, onEvent);
    p.then((id) => {
      if (cancelled) {
        void api.sessionClose(id).catch(() => {});
        return;
      }
      sid = id;
      sessionRef.current = id;
      const live = liveTerminals.get(paneId);
      if (live) live.sessionId = id;
    }).catch((err) => {
      if (!cancelled) ws().setRuntime(paneId, { status: "error", message: err instanceof Error ? err.message : String(err), hop: null });
    });

    return () => {
      cancelled = true;
      sessionRef.current = null;
      if (sid) void api.sessionClose(sid).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, nonce, deferred]);

  // ── live appearance updates ──
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermTheme(theme);
    term.options.fontFamily = `${overrides?.fontFamily ?? settings.terminal.fontFamily}, "JetBrains Mono", monospace`;
    term.options.fontSize = overrides?.fontSize ?? settings.terminal.fontSize;
    term.options.lineHeight = settings.terminal.lineHeight;
    term.options.cursorStyle = settings.terminal.cursorStyle;
    term.options.cursorBlink = settings.terminal.cursorBlink;
    term.options.scrollback = overrides?.scrollback ?? settings.terminal.scrollback;
    try { fitRef.current?.fit(); } catch { /* hidden */ }
  }, [theme, settings.terminal, overrides]);

  // focus when becoming visible+focused
  useEffect(() => {
    if (visible && focused) {
      const t = setTimeout(() => {
        try { fitRef.current?.fit(); } catch { /* */ }
        termRef.current?.focus();
      }, 30);
      return () => clearTimeout(t);
    }
  }, [visible, focused, fullscreen]);

  const status = deferred ? "idle" : runtime?.status ?? "connecting";
  const title = target.kind === "local" ? "Local shell" : host?.name ?? "Unknown host";
  const showOverlay = deferred || status === "connecting" || status === "error" || status === "closed" || status === "reconnecting";
  const termBg = theme.terminal.background;

  return (
    <div
      className={cx("pane", focused && "focused", fullscreen && "fullscreen")}
      style={{ ["--term-background" as string]: termBg, ["--term-foreground" as string]: theme.terminal.foreground }}
      onMouseDown={() => ws().focusPane(paneId)}
    >
      <div className="pane-head" onDoubleClick={() => ws().toggleFullscreen(paneId)}>
        <span className={cx("status-dot", status === "idle" ? "closed" : status)} />
        {target.kind === "local" ? <Monitor size={13} /> : <Server size={13} />}
        <span style={{ color: theme.terminal.foreground, fontWeight: 500 }} className="truncate">{title}</span>
        {host && (
          <span className="mono faint truncate" style={{ fontSize: 11 }}>{host.username}@{host.hostname}</span>
        )}
        {host && host.jumpChain.length > 0 && (
          <span style={{ marginLeft: 6, minWidth: 0, overflow: "hidden" }}>
            <ConnectionChain host={host} mini activeHop={status === "connected" ? host.jumpChain.length + 1 : runtime?.hop?.index ?? null} />
          </span>
        )}
        <div className="pane-actions">
          <button className="btn btn-ghost btn-xs" title="Find (Ctrl+Shift+F)" onClick={() => setSearchOpen((v) => !v)}><Search size={13} /></button>
          <button className="btn btn-ghost btn-xs" title="Split right" onClick={() => ws().split(paneId, "horizontal")}><Columns2 size={13} /></button>
          <button className="btn btn-ghost btn-xs" title="Split down" onClick={() => ws().split(paneId, "vertical")}><Rows2 size={13} /></button>
          <button className="btn btn-ghost btn-xs" title={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={() => ws().toggleFullscreen(paneId)}>
            {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button className="btn btn-ghost btn-xs" title="Close pane" onClick={() => ws().closePane(paneId)}><X size={13} /></button>
        </div>
      </div>
      <div className="pane-body" style={{ background: termBg }}>
        <div ref={hostEl} style={{ height: "100%", width: "100%" }} />
        {searchOpen && <TermSearch paneId={paneId} onClose={() => { setSearchOpen(false); termRef.current?.focus(); }} />}
        {showOverlay && (
          <PaneOverlay
            status={status}
            message={runtime?.message ?? null}
            hostName={title}
            host={host}
            hop={runtime?.hop ?? null}
            onConnect={() => ws().reconnect(paneId)}
            onClose={() => ws().closePane(paneId)}
          />
        )}
      </div>
    </div>
  );
}

function PaneOverlay({ status, message, hostName, host, hop, onConnect, onClose }: {
  status: string; message: string | null; hostName: string; host: ReturnType<typeof useData.getState>["hosts"][number] | undefined;
  hop: { index: number; total: number; name: string } | null; onConnect: () => void; onClose: () => void;
}) {
  if (status === "connecting" || status === "reconnecting") {
    return (
      <div className="pane-overlay">
        <div className="overlay-card">
          <div className="row"><div className="spinner" /><b>{status === "reconnecting" ? "Reconnecting" : "Connecting"} to {hostName}</b></div>
          {hop && <span className="muted">Hop {hop.index + 1} of {hop.total} · {hop.name}</span>}
          {host && host.jumpChain.length > 0 && <ConnectionChain host={host} activeHop={hop?.index ?? 0} />}
          {message && <span className="muted">{message}</span>}
          <button className="btn btn-sm" onClick={onClose}>Cancel</button>
        </div>
      </div>
    );
  }
  if (status === "idle") {
    return (
      <div className="pane-overlay">
        <div className="overlay-card">
          <b>{hostName}</b>
          <span className="muted">Restored from your last session. Connect when you're ready.</span>
          <div className="row">
            <button className="btn btn-primary" autoFocus onClick={onConnect}><Play size={14} /> Connect</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="pane-overlay">
      <div className="overlay-card">
        <b style={{ color: status === "error" ? "var(--danger)" : undefined }}>{status === "error" ? "Connection failed" : "Session ended"}</b>
        {message && <span className="muted selectable" style={{ wordBreak: "break-word" }}>{message}</span>}
        <div className="row">
          <button className="btn btn-primary" autoFocus onClick={onConnect}><RotateCcw size={14} /> Reconnect</button>
          <button className="btn" onClick={onClose}>Close pane</button>
        </div>
      </div>
    </div>
  );
}

function TermSearch({ paneId, onClose }: { paneId: Id; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [caseSensitive, setCase] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<{ idx: number; count: number } | null>(null);
  const live = liveTerminals.get(paneId);

  useEffect(() => {
    if (!live) return;
    const sub = live.search.onDidChangeResults((r) => setResult(r ? { idx: r.resultIndex, count: r.resultCount } : null));
    return () => {
      sub.dispose();
      live.search.clearDecorations();
    };
  }, [live]);

  const opts = {
    caseSensitive,
    regex,
    decorations: {
      matchBackground: "#f2b85c55",
      activeMatchBackground: "#f2b85c",
      matchOverviewRuler: "#f2b85c",
      activeMatchColorOverviewRuler: "#ff9f1c",
    },
  };
  const next = () => q && live?.search.findNext(q, opts);
  const prev = () => q && live?.search.findPrevious(q, opts);

  return (
    <div className="term-search" onMouseDown={(e) => e.stopPropagation()}>
      <input
        className="input"
        autoFocus
        placeholder="Find in output"
        value={q}
        onChange={(e) => { setQ(e.target.value); if (e.target.value) live?.search.findNext(e.target.value, { ...opts, incremental: true }); else live?.search.clearDecorations(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.shiftKey ? prev() : next());
          if (e.key === "Escape") onClose();
          e.stopPropagation();
        }}
      />
      <span className="faint" style={{ fontSize: 11, minWidth: 44, textAlign: "center" }}>
        {result && q ? (result.count ? `${result.idx + 1}/${result.count}` : "0/0") : ""}
      </span>
      <button className={cx("btn btn-ghost btn-xs", caseSensitive && "on")} style={caseSensitive ? { color: "var(--accent)" } : undefined} title="Match case" onClick={() => setCase(!caseSensitive)}><CaseSensitive size={14} /></button>
      <button className="btn btn-ghost btn-xs" style={regex ? { color: "var(--accent)" } : undefined} title="Regex" onClick={() => setRegex(!regex)}><Regex size={13} /></button>
      <button className="btn btn-ghost btn-xs" title="Previous (Shift+Enter)" onClick={prev}><ArrowUp size={13} /></button>
      <button className="btn btn-ghost btn-xs" title="Next (Enter)" onClick={next}><ArrowDown size={13} /></button>
      <button className="btn btn-ghost btn-xs" title="Close" onClick={onClose}><X size={13} /></button>
    </div>
  );
}
