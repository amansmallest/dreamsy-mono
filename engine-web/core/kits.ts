// Kit sources (DREAMSY.MD §12.1): engine-web/kits/<kit>/**/*.luau, keyed "kits/<kit>/<path>.luau",
// plus each kit's optional kit.json manifest ({ "requires": ["core", ...] }, keyed "kits/<kit>/kit.json").
// Bundled by Vite's glob import (browser build, vitest); under plain Node (tsx) the glob isn't
// available, so they're read from disk next to this file. Load once with loadKitSources().

let sources: Record<string, string> | null = null;

function fromGlob(): Record<string, string> | null {
  try {
    const mods = import.meta.glob("../kits/**/*.luau", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const manifests = import.meta.glob("../kits/*/kit.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...mods, ...manifests })) out[k.replace(/^\.\.\//, "")] = v;
    return out;
  } catch {
    return null; // not running under Vite
  }
}

async function fromDisk(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const fsName = "node:fs", pathName = "node:path", urlName = "node:url";
    const fs = await import(/* @vite-ignore */ fsName) as typeof import("node:fs");
    const path = await import(/* @vite-ignore */ pathName) as typeof import("node:path");
    const url = await import(/* @vite-ignore */ urlName) as typeof import("node:url");
    const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../kits");
    if (!fs.existsSync(root)) return out;
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.name.endsWith(".luau") || (e.name === "kit.json" && path.dirname(abs) !== root && path.dirname(path.dirname(abs)) === root)) out[`kits/${path.relative(root, abs).split(path.sep).join("/")}`] = fs.readFileSync(abs, "utf8");
      }
    };
    walk(root);
  } catch { /* no filesystem (browser without the glob) */ }
  return out;
}

export async function loadKitSources(): Promise<Record<string, string>> {
  sources ??= fromGlob() ?? (await fromDisk());
  return sources;
}

/** Override/add kit sources (tests, harness). Keys are "kits/<kit>/<path>.luau". */
export function setKitSources(extra: Record<string, string>, replace = false) {
  sources = replace ? { ...extra } : { ...(sources ?? {}), ...extra };
}

export function kitSource(path: string): string | undefined {
  return sources?.[path];
}

/** Declared dependencies per kit (kits/<kit>/kit.json "requires"). Load sources first. */
export function kitDependencies(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(sources ?? {})) {
    const m = /^kits\/([a-z][a-z0-9-]*)\/kit\.json$/.exec(k);
    if (!m) continue;
    try {
      const r = (JSON.parse(v) as { requires?: unknown }).requires;
      out[m[1]!] = Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
    } catch {
      out[m[1]!] = [];
    }
  }
  return out;
}

/** Kits enabled for a game: the listed kits plus their declared dependencies (transitively). */
export function expandKits(listed: readonly string[], deps: Record<string, readonly string[]> = kitDependencies()): string[] {
  const out: string[] = [];
  const visit = (k: string) => {
    if (out.includes(k)) return;
    out.push(k);
    for (const d of deps[k] ?? []) visit(d);
  };
  for (const k of listed) visit(k);
  return out;
}
