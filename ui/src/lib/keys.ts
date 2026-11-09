// Central keybinding dispatcher. Accelerators look like "Ctrl+Shift+K".

const MOD_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;

function keyName(e: KeyboardEvent): string | null {
  const k = e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(k)) return null;
  if (k === " ") return "Space";
  if (k === ",") return ",";
  if (k.length === 1) return k.toUpperCase();
  // With Shift held, digits/punctuation produce symbols; fall back to the physical key.
  return k;
}

export function eventToAccelerator(e: KeyboardEvent): string | null {
  let name = keyName(e);
  if (!name) return null;
  if (e.shiftKey && /^Digit\d$/.test(e.code)) name = e.code.slice(5);
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  return [...mods, name].join("+");
}

export function normalizeAccelerator(acc: string): string {
  const parts = acc.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? "";
  const mods = MOD_ORDER.filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase() || (m === "Ctrl" && p.toLowerCase() === "control") || (m === "Meta" && /^(cmd|super)$/i.test(p))));
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join("+");
}

export function matchBinding(bindings: Record<string, string>, e: KeyboardEvent): string | null {
  const acc = eventToAccelerator(e);
  if (!acc) return null;
  for (const [action, binding] of Object.entries(bindings)) {
    if (binding && normalizeAccelerator(binding) === acc) return action;
  }
  return null;
}
