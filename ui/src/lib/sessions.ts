// Non-reactive registry of live terminal instances, keyed by pane id.
// Lets global actions (search, copy, paste, focus) reach the focused terminal.
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import type { Id } from "./types";

export interface LiveTerminal {
  term: Terminal;
  search: SearchAddon;
  sessionId: Id | null;
  openSearch: () => void;
}

export const liveTerminals = new Map<Id, LiveTerminal>();
