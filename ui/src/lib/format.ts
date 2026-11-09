export function relativeTime(isoStr: string | null | undefined): string {
  if (!isoStr) return "Never";
  const diff = Date.now() - new Date(isoStr).getTime();
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  const fmt = (n: number, u: string) => {
    const v = Math.floor(n);
    return future ? `in ${v}${u}` : `${v}${u} ago`;
  };
  if (s < 45) return future ? "in a moment" : "just now";
  if (s < 3600) return fmt(s / 60, "m");
  if (s < 86400) return fmt(s / 3600, "h");
  if (s < 86400 * 30) return fmt(s / 86400, "d");
  return new Date(isoStr).toLocaleDateString();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Environment → semantic color token. */
export function envTone(env: string | null | undefined): "danger" | "warning" | "success" | "info" | "neutral" {
  switch ((env ?? "").toLowerCase()) {
    case "production":
    case "prod":
      return "danger";
    case "staging":
    case "stage":
      return "warning";
    case "development":
    case "dev":
      return "success";
    case "testing":
    case "test":
    case "qa":
      return "info";
    default:
      return "neutral";
  }
}

export function expiryState(isoStr: string | null): "expired" | "soon" | "ok" | null {
  if (!isoStr) return null;
  const ms = new Date(isoStr).getTime() - Date.now();
  if (ms <= 0) return "expired";
  if (ms < 14 * 86400_000) return "soon";
  return "ok";
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function joinPath(dir: string, name: string, sep = "/"): string {
  if (!dir) return name;
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

export function parentPath(p: string): string {
  const win = /^[A-Za-z]:\\/.test(p);
  const sep = win ? "\\" : "/";
  const trimmed = p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
  const i = trimmed.lastIndexOf(sep);
  if (i <= 0) return win ? trimmed.slice(0, 3) : "/";
  if (win && i === 2) return trimmed.slice(0, 3);
  return trimmed.slice(0, i);
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
