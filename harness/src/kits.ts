import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerKitDependencies } from "@dreamsy/format";

const ROOT = fileURLToPath(new URL("../../kits/", import.meta.url));

/** Kit → kits it requires, from kits/<kit>/kit.json `requires` (docs/kits.md §12.1). */
export function kitDependencies(root = ROOT): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!existsSync(root)) return out;
  for (const id of readdirSync(root).sort()) {
    const file = join(root, id, "kit.json");
    if (!existsSync(file)) continue;
    try {
      const r = (JSON.parse(readFileSync(file, "utf8")) as { requires?: unknown }).requires;
      out[id] = Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
    } catch {
      out[id] = [];
    }
  }
  return out;
}

// Kits can require other kits (kits/<kit>/kit.json); validation must know the map, otherwise a game
// listing only "rpg" that also requires @kit/core would be flagged.
registerKitDependencies(kitDependencies());

/** Genre kits shipped with the engine (docs/kits.md §12.1): kits/<kit>/KIT.md + schemas. */
export interface Kit {
  id: string;
  /** API reference pasted into the builder's prompt. */
  doc: string;
  /** First paragraph of KIT.md, for the router. */
  summary: string;
  /** JSON Schemas for content files, keyed by file name (e.g. "creature.json"). */
  schemas: Record<string, unknown>;
}

let cache: Map<string, Kit> | null = null;

/** Re-read on every call in dev would be wasteful; kits only change between deploys. */
export function kits(): Map<string, Kit> {
  if (cache) return cache;
  cache = new Map();
  if (!existsSync(ROOT)) return cache;
  for (const id of readdirSync(ROOT).sort()) {
    if (id.startsWith("_") || id.startsWith(".")) continue;
    const docPath = join(ROOT, id, "KIT.md");
    if (!existsSync(docPath)) continue;
    const doc = readFileSync(docPath, "utf8");
    const summary = doc.split("\n").filter((l) => l.trim() && !l.startsWith("#"))[0]?.trim() ?? id;
    const schemas: Record<string, unknown> = {};
    const sdir = join(ROOT, id, "schemas");
    if (existsSync(sdir)) {
      for (const f of readdirSync(sdir).filter((f) => f.endsWith(".json"))) {
        try { schemas[f] = JSON.parse(readFileSync(join(sdir, f), "utf8")); } catch { /* skip broken schema */ }
      }
    }
    cache.set(id, { id, doc, summary, schemas });
  }
  return cache;
}

export function kitMenu(): string {
  const list = [...kits().values()];
  return list.length ? list.map((k) => `- ${k.id}: ${k.summary.slice(0, 200)}`).join("\n") : "(no kits installed)";
}

/** Clear the cache (tests, hot reload). */
export function resetKits() {
  cache = null;
}
