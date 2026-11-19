import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerKitDependencies } from "@dreamsy/format";
import { repoPath } from "../paths.js";

const ROOT = repoPath("kits") + "/";

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

registerKitDependencies(kitDependencies());

export interface Kit {
  id: string;
  doc: string;
  summary: string;
  schemas: Record<string, unknown>;
}

let cache: Map<string, Kit> | null = null;

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
        try { schemas[f] = JSON.parse(readFileSync(join(sdir, f), "utf8")); } catch {}
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

export function resetKits() {
  cache = null;
}
