import type { ITheme } from "@xterm/xterm";
import type { AppSettings, Theme } from "../lib/types";
import { BUILTIN_THEMES } from "./themes";

export function allThemes(settings: AppSettings | null): Theme[] {
  return [...BUILTIN_THEMES, ...(settings?.customThemes ?? [])];
}

export function findTheme(settings: AppSettings | null, id: string | null | undefined): Theme {
  const list = allThemes(settings);
  return list.find((t) => t.id === id) ?? list.find((t) => t.id === settings?.themeId) ?? BUILTIN_THEMES[0];
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

/** Writes theme + appearance settings into CSS custom properties on :root. */
export function applyAppearance(theme: Theme, settings: AppSettings) {
  const root = document.documentElement;
  const s = root.style;
  for (const [k, v] of Object.entries(theme.ui)) s.setProperty(`--${kebab(k)}`, v);
  for (const [k, v] of Object.entries(theme.terminal)) s.setProperty(`--term-${kebab(k)}`, v);

  const ui = settings.ui;
  s.setProperty("--radius", `${ui.radius}px`);
  s.setProperty("--radius-sm", `${Math.max(2, Math.round(ui.radius * 0.6))}px`);
  s.setProperty("--radius-lg", `${Math.round(ui.radius * 1.5)}px`);
  s.setProperty("--bg-alpha", `${Math.round(Math.min(1, Math.max(0.5, ui.transparency)) * 100)}%`);
  s.setProperty("--font-ui", `${quoteFont(ui.uiFontFamily)}, "Inter Variable", Inter, system-ui, sans-serif`);
  s.setProperty("--font-size", `${ui.uiFontSize}px`);
  s.setProperty("--font-mono", `${quoteFont(settings.terminal.fontFamily)}, "JetBrains Mono", ui-monospace, monospace`);
  s.setProperty("--sidebar-width", `${ui.sidebarWidth}px`);
  root.dataset.density = ui.density;
  root.dataset.themeKind = theme.kind;
  root.dataset.sidebar = ui.sidebarPosition;
  root.style.colorScheme = theme.kind;
}

function quoteFont(f: string) {
  const name = f.trim();
  if (!name) return "Inter";
  return /[\s]/.test(name) && !/^["']/.test(name) ? `"${name}"` : name;
}

export function xtermTheme(theme: Theme): ITheme {
  const p = theme.terminal;
  return {
    background: p.background,
    foreground: p.foreground,
    cursor: p.cursor,
    cursorAccent: p.background,
    selectionBackground: p.selection,
    black: p.black, red: p.red, green: p.green, yellow: p.yellow,
    blue: p.blue, magenta: p.magenta, cyan: p.cyan, white: p.white,
    brightBlack: p.brightBlack, brightRed: p.brightRed, brightGreen: p.brightGreen, brightYellow: p.brightYellow,
    brightBlue: p.brightBlue, brightMagenta: p.brightMagenta, brightCyan: p.brightCyan, brightWhite: p.brightWhite,
  };
}
