import type { Theme, TerminalPalette } from "../lib/types";

type UI = Theme["ui"];

function t(id: string, name: string, kind: "dark" | "light", ui: UI, terminal: TerminalPalette): Theme {
  return { id, name, kind, builtin: true, ui, terminal };
}

/** Keystone's signature theme: deep slate with a cool "keystone blue" accent. */
const midnight = t(
  "midnight",
  "Midnight",
  "dark",
  {
    bg: "#0b0d12",
    surface: "#11141b",
    surface2: "#181c25",
    border: "#232835",
    text: "#e4e8f1",
    textMuted: "#8a93a6",
    accent: "#6d8cff",
    accentText: "#0b0d12",
    success: "#4fd1a1",
    warning: "#f2b85c",
    danger: "#ff6b7a",
  },
  {
    background: "#0b0d12", foreground: "#d7dcea", cursor: "#8fa7ff", selection: "#2a3350",
    black: "#1b1f2a", red: "#ff6b7a", green: "#4fd1a1", yellow: "#f2b85c",
    blue: "#6d8cff", magenta: "#c49bff", cyan: "#5cc8e6", white: "#c9cfdd",
    brightBlack: "#4a5266", brightRed: "#ff8c97", brightGreen: "#7ae3bb", brightYellow: "#ffcf85",
    brightBlue: "#93aaff", brightMagenta: "#d8bbff", brightCyan: "#8adcf0", brightWhite: "#f2f4f9",
  },
);

const nord = t(
  "nord",
  "Nord",
  "dark",
  {
    bg: "#2e3440", surface: "#323846", surface2: "#3b4252", border: "#434c5e",
    text: "#eceff4", textMuted: "#a3adbf", accent: "#88c0d0", accentText: "#2e3440",
    success: "#a3be8c", warning: "#ebcb8b", danger: "#bf616a",
  },
  {
    background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", selection: "#434c5e",
    black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
    blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
    brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
  },
);

const dracula = t(
  "dracula",
  "Dracula",
  "dark",
  {
    bg: "#21222c", surface: "#282a36", surface2: "#303241", border: "#3c3f52",
    text: "#f8f8f2", textMuted: "#a0a4c0", accent: "#bd93f9", accentText: "#21222c",
    success: "#50fa7b", warning: "#f1fa8c", danger: "#ff5555",
  },
  {
    background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", selection: "#44475a",
    black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
    blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
    brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5",
    brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
  },
);

const tokyoNight = t(
  "tokyo-night",
  "Tokyo Night",
  "dark",
  {
    bg: "#16161e", surface: "#1a1b26", surface2: "#222436", border: "#2a2e42",
    text: "#c0caf5", textMuted: "#7a82a8", accent: "#7aa2f7", accentText: "#16161e",
    success: "#9ece6a", warning: "#e0af68", danger: "#f7768e",
  },
  {
    background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5", selection: "#283457",
    black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
    blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
    brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a", brightYellow: "#e0af68",
    brightBlue: "#7aa2f7", brightMagenta: "#bb9af7", brightCyan: "#7dcfff", brightWhite: "#c0caf5",
  },
);

const catppuccin = t(
  "catppuccin-mocha",
  "Catppuccin Mocha",
  "dark",
  {
    bg: "#11111b", surface: "#181825", surface2: "#1e1e2e", border: "#313244",
    text: "#cdd6f4", textMuted: "#9399b2", accent: "#cba6f7", accentText: "#11111b",
    success: "#a6e3a1", warning: "#f9e2af", danger: "#f38ba8",
  },
  {
    background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc", selection: "#45475a",
    black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
    blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
    brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af",
    brightBlue: "#89b4fa", brightMagenta: "#f5c2e7", brightCyan: "#94e2d5", brightWhite: "#a6adc8",
  },
);

const gruvbox = t(
  "gruvbox",
  "Gruvbox",
  "dark",
  {
    bg: "#1d2021", surface: "#282828", surface2: "#32302f", border: "#3c3836",
    text: "#ebdbb2", textMuted: "#a89984", accent: "#fabd2f", accentText: "#1d2021",
    success: "#b8bb26", warning: "#fe8019", danger: "#fb4934",
  },
  {
    background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2", selection: "#504945",
    black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921",
    blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#a89984",
    brightBlack: "#928374", brightRed: "#fb4934", brightGreen: "#b8bb26", brightYellow: "#fabd2f",
    brightBlue: "#83a598", brightMagenta: "#d3869b", brightCyan: "#8ec07c", brightWhite: "#ebdbb2",
  },
);

const solarized = t(
  "solarized-dark",
  "Solarized Dark",
  "dark",
  {
    bg: "#00212b", surface: "#002b36", surface2: "#073642", border: "#0d4654",
    text: "#eee8d5", textMuted: "#839496", accent: "#268bd2", accentText: "#fdf6e3",
    success: "#859900", warning: "#b58900", danger: "#dc322f",
  },
  {
    background: "#002b36", foreground: "#839496", cursor: "#93a1a1", selection: "#073642",
    black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
    blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
    brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83",
    brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
  },
);

const lightMinimal = t(
  "light-minimal",
  "Light Minimal",
  "light",
  {
    bg: "#f6f7f9", surface: "#ffffff", surface2: "#eef0f4", border: "#e1e4ea",
    text: "#1a1d24", textMuted: "#69707f", accent: "#3b5bdb", accentText: "#ffffff",
    success: "#1f9d6b", warning: "#c27c0e", danger: "#d6334a",
  },
  {
    background: "#ffffff", foreground: "#24292f", cursor: "#3b5bdb", selection: "#d5ddf7",
    black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#9a6700",
    blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
    brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01",
    brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
  },
);

export const BUILTIN_THEMES: Theme[] = [midnight, nord, dracula, tokyoNight, catppuccin, gruvbox, solarized, lightMinimal];

export const TERMINAL_COLOR_KEYS: (keyof TerminalPalette)[] = [
  "background", "foreground", "cursor", "selection",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

export const UI_COLOR_KEYS: (keyof UI)[] = [
  "bg", "surface", "surface2", "border", "text", "textMuted", "accent", "accentText", "success", "warning", "danger",
];

export function isTheme(x: unknown): x is Theme {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.name !== "string") return false;
  if (o.kind !== "dark" && o.kind !== "light") return false;
  const ui = o.ui as Record<string, unknown> | undefined;
  const term = o.terminal as Record<string, unknown> | undefined;
  if (!ui || !term) return false;
  return UI_COLOR_KEYS.every((k) => typeof ui[k] === "string") && TERMINAL_COLOR_KEYS.every((k) => typeof term[k] === "string");
}
