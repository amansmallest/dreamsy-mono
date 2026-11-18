/**
 * Headless helpers for the tower-defense kit (tests + harness), on the C++ engine (`dreamsy-tool eval`). The kit reads
 * its content from the package itself (`TD.content()` → engine `data.list/data.read`). `pkg` is a Package or a directory.
 *  - runLuau(src, base?): runs a client script in the package headless and returns what it `save.set("out", …)`.
 *  - balance(pkg): auto-places a reference build on every campaign level (Luau sim, `@kit/tower-defense/balance`)
 *    and reports winnable / lives left / stars per level.
 *  - validateContent(pkg): checks data/** against schemas/*.json.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evalLuau, type PackageLike } from "../_tools/engine.js";

const KITS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- headless runs (C++ engine: dreamsy-tool eval) ----------

/** Run `src` (Luau, a client script) inside `base` (a package or its directory; default: an empty package) with the
 *  tower-defense kit enabled; returns `save.get("out")`, logs, errors ("script:line: message") and the save data. */
export async function runLuau(src: string, base?: PackageLike | string, opts: { steps?: number; files?: Record<string, string>; budgetMs?: number } = {}) {
  const r = evalLuau(src, { kits: ["tower-defense"], base, files: opts.files, steps: opts.steps, budgetMs: opts.budgetMs ?? 120_000 });
  return { out: r.out, logs: r.logs, errors: r.errors, save: r.save };
}

export interface LevelReport { level: string; won: boolean; lives: number; maxLives: number; stars: number; wavesCleared: number; waves: number; leaked: number; spent: number; towers: string[]; seconds: number }
export interface BalanceReport { ok: boolean; levels: LevelReport[]; endless?: { wavesSurvived: number }; problems: string[] }

/**
 * Balance simulation for the harness: for each campaign level, auto-place the kit's reference build
 * (greedy: best coverage tiles, cheapest unlocked towers first, upgrades when rich) and run the level at
 * fixed 30 Hz. Reports winnable + lives left; `problems` lists levels that are lost or trivially easy.
 */
export async function balance(pkg: PackageLike | string, opts: { endlessWaves?: number } = {}): Promise<BalanceReport> {
  const { out, errors, logs } = await runLuau(
    `local TD = require("@kit/tower-defense")\nsave.set("out", TD.Balance.campaign(TD.content(), { endlessWaves = ${opts.endlessWaves ?? 30} }))`,
    pkg,
  );
  if (errors.length || !out) throw new Error(`balance sim failed:\n${errors.join("\n")}\n${logs.slice(-5).join("\n")}`);
  // Luau empty tables arrive as {}: normalize the arrays
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []) as T[];
  const r = out as BalanceReport;
  r.problems = arr(r.problems);
  r.levels = arr<LevelReport>(r.levels).map((l) => ({ ...l, towers: arr(l.towers) }));
  return r;
}

// ---------- content validation (JSON Schema subset: type, required, properties, additionalProperties,
// items, minItems/maxItems, enum, pattern, minimum/maximum) — enough for the kit's schemas/*.json ----------

type Schema = Record<string, any>;
const SCHEMA_OF: [RegExp, string][] = [
  [/^data\/enemies\/[^/]+\.json$/, "enemy"],
  [/^data\/towers\/[^/]+\.json$/, "tower"],
  [/^data\/waves\/[^/]+\.json$/, "waves"],
  [/^data\/levels\/[^/]+\.json$/, "level"],
  [/^data\/campaign\.json$/, "campaign"],
];

export function loadSchema(name: string): Schema {
  return JSON.parse(readFileSync(join(KITS_DIR, "tower-defense", "schemas", `${name}.schema.json`), "utf8"));
}

function check(v: unknown, s: Schema, at: string, out: string[]) {
  const t = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
  if (s.enum && !s.enum.includes(v)) out.push(`${at}: must be one of ${s.enum.join(", ")}`);
  if (s.type) {
    const ok = s.type === "integer" ? Number.isInteger(v) : s.type === t;
    if (!ok) { out.push(`${at}: expected ${s.type}, got ${t}`); return; }
  }
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) out.push(`${at}: ${v} < minimum ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) out.push(`${at}: ${v} > maximum ${s.maximum}`);
  }
  if (typeof v === "string" && s.pattern && !new RegExp(s.pattern).test(v)) out.push(`${at}: "${v}" doesn't match ${s.pattern}`);
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) out.push(`${at}: needs ≥ ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) out.push(`${at}: at most ${s.maxItems} items`);
    if (s.items) v.forEach((x, i) => check(x, s.items, `${at}[${i}]`, out));
  } else if (t === "object") {
    const o = v as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in o)) out.push(`${at}: missing "${r}"`);
    for (const [k, x] of Object.entries(o)) {
      const ps = s.properties?.[k];
      if (ps) check(x, ps, `${at}.${k}`, out);
      else if (s.additionalProperties === false) out.push(`${at}: unknown key "${k}"`);
      else if (typeof s.additionalProperties === "object") check(x, s.additionalProperties, `${at}.${k}`, out);
    }
  }
}

/** Validate a package's TD content files against schemas/*.json. Returns issues ("file: path: message"). */
export function validateContent(pkg: Pick<PackageLike, "paths" | "text">): string[] {
  const out: string[] = [];
  const cache: Record<string, Schema> = {};
  for (const p of pkg.paths("data/")) {
    const hit = SCHEMA_OF.find(([re]) => re.test(p));
    if (!hit) continue;
    let v: unknown;
    try { v = JSON.parse(pkg.text(p)!); } catch (e) { out.push(`${p}: invalid JSON (${(e as Error).message})`); continue; }
    const issues: string[] = [];
    check(v, (cache[hit[1]] ??= loadSchema(hit[1])), "$", issues);
    out.push(...issues.map((i) => `${p}: ${i}`));
  }
  return out;
}
