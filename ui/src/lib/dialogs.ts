// File pickers: native dialogs inside Tauri, browser fallbacks otherwise.
import { isTauri } from "./api";

type Filter = { name: string; extensions: string[] };

export async function pickOpenPath(opts: { title?: string; filters?: Filter[]; directory?: boolean } = {}): Promise<string | null> {
  if (!isTauri) {
    const p = window.prompt(`${opts.title ?? "Path"} (browser mock: type a path)`);
    return p || null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ title: opts.title, filters: opts.filters, directory: opts.directory, multiple: false });
  return typeof r === "string" ? r : null;
}

export async function pickSavePath(opts: { title?: string; defaultPath?: string; filters?: Filter[] } = {}): Promise<string | null> {
  if (!isTauri) {
    const p = window.prompt(`${opts.title ?? "Save to"} (browser mock: type a path)`, opts.defaultPath ?? "");
    return p || null;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  return (await save({ title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters })) ?? null;
}

/** Text import (themes). Uses a hidden <input type=file> — works in both Tauri and browsers. */
export function readTextFile(accept = ".json"): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? await f.text() : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Text export (themes). Blob download works in browsers and in the Tauri webview. */
export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
