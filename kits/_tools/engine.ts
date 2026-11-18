/**
 * Headless kit runs on the C++ engine (`dreamsy-tool eval`, engine/apps/tool/playtest.cpp), shared by
 * the kits' balance simulators (kits/<kit>/harness.ts). No npm dependencies, so `tsx kits/<kit>/cli.ts`
 * works from anywhere. (Folders starting with `_` are never loadable kits.)
 *
 * The engine binary: $DREAMSY_TOOL, else engine/build/{release,headless,debug}/dreamsy-tool
 * (cd engine && cmake --preset release && cmake --build --preset release --target dreamsy-tool).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** What the runners need from a package: @dreamsy/format's Package fits, so does dirPackage(). */
export interface PackageLike {
  paths(prefix?: string): string[];
  bytes(path: string): Uint8Array | undefined;
  text(path: string): string | undefined;
}

/** A package directory on disk as a PackageLike (no @dreamsy/format needed). */
export function dirPackage(dir: string): PackageLike {
  const root = resolve(dir);
  const all: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else all.push(relative(root, p).split("\\").join("/"));
    }
  };
  walk(root);
  return {
    paths: (prefix = "") => all.filter((p) => p.startsWith(prefix)),
    bytes: (p) => (all.includes(p) ? new Uint8Array(readFileSync(join(root, p))) : undefined),
    text: (p) => (all.includes(p) ? readFileSync(join(root, p), "utf8") : undefined),
  };
}

export function dreamsyTool(): string {
  if (process.env.DREAMSY_TOOL) return process.env.DREAMSY_TOOL;
  for (const preset of ["release", "headless", "debug"]) {
    const p = join(REPO, "engine/build", preset, "dreamsy-tool");
    if (existsSync(p)) return p;
  }
  throw new Error("dreamsy-tool not found: cd engine && cmake --preset release && cmake --build --preset release --target dreamsy-tool (or set DREAMSY_TOOL)");
}

export interface EvalOptions {
  /** Kits to enable (dependencies come along, kits/<kit>/kit.json). */
  kits: string[];
  /** The package whose data/ and shared modules the script sees (its client/server scripts are dropped). */
  base?: PackageLike | string;
  /** Extra files laid over the base (path → content). */
  files?: Record<string, string | Uint8Array>;
  /** Ticks to run (default 1). */
  steps?: number;
  /** Then keep ticking until save data has this key (or a script error), at most maxTicks. */
  until?: string;
  maxTicks?: number;
  /** Per-call Luau CPU budget in ms (default 250). */
  budgetMs?: number;
  /** clock.now() at game time 0 (unix seconds; default 2026-01-01), game time is added. */
  clock?: number;
  /** Save data the game starts with. */
  save?: Record<string, unknown>;
  seed?: number;
}

export interface EvalResult {
  /** save.get(until ?? "out") at the end. */
  out: any;
  save: Record<string, unknown>;
  logs: string[];
  /** "script:line: message" */
  errors: string[];
  ticks: number;
}

/** Runs `src` (a Luau client script) headless and returns what it saved. */
export function evalLuau(src: string, opts: EvalOptions): EvalResult {
  const dir = mkdtempSync(join(tmpdir(), "dreamsy-kit-"));
  try {
    const script = join(dir, "run.luau");
    writeFileSync(script, src);
    let base: string | undefined;
    if (opts.base !== undefined || opts.files) {
      base = join(dir, "pkg");
      mkdirSync(base);
      if (typeof opts.base === "string") cpSync(opts.base, base, { recursive: true });
      else if (opts.base) for (const p of opts.base.paths()) write(base, p, opts.base.bytes(p)!);
      for (const [p, v] of Object.entries(opts.files ?? {})) write(base, p, v);
    }
    const args = ["eval", "--script", script, "--kits", opts.kits.join(","), "--ticks", String(opts.steps ?? 1)];
    if (base) args.push("--base", base);
    if (opts.until) args.push("--until", opts.until, "--max-ticks", String(opts.maxTicks ?? 100_000));
    if (opts.budgetMs !== undefined) args.push("--budget", String(opts.budgetMs));
    if (opts.clock !== undefined) args.push("--clock", String(opts.clock));
    if (opts.seed !== undefined) args.push("--seed", String(opts.seed));
    if (opts.save) args.push("--save", JSON.stringify(opts.save));
    const r = spawnSync(dreamsyTool(), args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.error) throw r.error;
    let j: { loadError?: string; out?: unknown; save?: Record<string, unknown>; logs?: string[]; errors?: { script: string; line?: number; message: string }[]; ticks?: number };
    try {
      j = JSON.parse(r.stdout);
    } catch {
      throw new Error(`dreamsy-tool eval failed: ${(r.stderr || r.stdout || `signal ${r.signal}`).trim().slice(0, 800)}`);
    }
    if (j.loadError) throw new Error(`dreamsy-tool eval: ${j.loadError}`);
    return {
      out: j.out ?? undefined,
      save: j.save ?? {},
      logs: j.logs ?? [],
      errors: (j.errors ?? []).map((e) => `${e.script}:${e.line ?? "?"}: ${e.message}`),
      ticks: j.ticks ?? 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(root: string, path: string, content: string | Uint8Array) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
