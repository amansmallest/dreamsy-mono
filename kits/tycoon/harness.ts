/**
 * Headless helpers for the tycoon kit (tests + harness):
 *  - runLuau(src, pkg?, {clock?}): runs a client script headless (C++ engine) and returns what it `save.set("out", …)`.
 *  - balance(pkg, {hours}): greedy-player simulation (`@kit/tycoon/balance`) of the package's own data → pacing report.
 *    `pkg` is a Package or a package directory. CLI: `tsx kits/tycoon/cli.ts balance <packageDir> [--hours 2]`.
 * The kit reads content itself (`Tycoon.new()` → data/tycoon.json + data/{generators,upgrades,achievements,events}/*.json).
 */
import { evalLuau, type PackageLike } from "../_tools/engine.js";

// ---------- headless runs (C++ engine: dreamsy-tool eval) ----------

/** A save store shared across runs (= relaunching the game): starts from `data`, gets the final save back. */
export interface SaveStore { data: Record<string, unknown> }

/** Run `src` (a client script) inside `base` (a package or its directory; default: an empty package) with the tycoon
 *  kit enabled; returns `save.get("out")`, logs, errors ("script:line: message") and the final save data.
 *  `clock`: clock.now() at game time 0 (a function is read once, at load). `save`: initial data, or a SaveStore. */
export async function runLuau(src: string, base?: PackageLike | string, opts: { steps?: number; files?: Record<string, string>; until?: string; clock?: number | (() => number); save?: Record<string, unknown> | SaveStore; budgetMs?: number } = {}) {
  const store = opts.save && typeof (opts.save as SaveStore).data === "object" && (opts.save as SaveStore).data !== null ? opts.save as SaveStore : undefined;
  const clock = typeof opts.clock === "function" ? opts.clock() : opts.clock;
  const r = evalLuau(src, { kits: ["tycoon"], base, files: opts.files, steps: opts.steps, until: opts.until, clock, save: store ? store.data : opts.save as Record<string, unknown> | undefined, budgetMs: opts.budgetMs });
  if (store) {
    for (const k of Object.keys(store.data)) delete store.data[k];
    Object.assign(store.data, r.save);
  }
  return { out: r.out, logs: r.logs, errors: r.errors, save: r.save };
}

export interface BalanceReport {
  hours: number;
  /** Seconds of play until the first prestige (null = never). */
  firstPrestige: number | null;
  prestiges: { t: number; layer: string; gain: number }[];
  /** Generator id → seconds when it unlocked / was first bought. */
  unlocks: Record<string, number>;
  firstBuy: Record<string, number>;
  allGeneratorsAt: number | null;
  allUpgradesAt: number | null;
  purchases: number;
  /** Seconds between consecutive purchases. */
  gaps: { median: number; p90: number; max: number; maxAt: number };
  /** Waits longer than stallSeconds (default 180). */
  stalls: { at: number; wait: number }[];
  smooth: boolean;
  /** Every 5 simulated minutes: income/s and all-time earned of the main currency. */
  samples: { t: number; income: number; allTime: number }[];
  final: { cur: Record<string, number>; income: number; owned: Record<string, number>; achievements: number };
}

/** Greedy-player pacing simulation of the package's tycoon content (see balance.luau for options). */
export async function balance(pkg: PackageLike | string, opts: { hours?: number; dt?: number; prestigeRatio?: number; stallSeconds?: number } = {}): Promise<BalanceReport> {
  const o = { hours: 2, dt: 1, ...opts };
  const { out, errors, logs } = await runLuau(
    // the sim runs in slices across ticks (each script call has a 250 ms budget)
    `local B = require("@kit/tycoon/balance")
local run = B.runner(nil, { hours = ${o.hours}, dt = ${o.dt}${o.prestigeRatio ? `, prestigeRatio = ${o.prestigeRatio}` : ""}${o.stallSeconds ? `, stallSeconds = ${o.stallSeconds}` : ""} })
local done = false
onTick(function()
	if done then return end
	local t0 = os.clock()
	while os.clock() - t0 < 0.05 do
		if run.advance(5) then
			done = true
			save.set("out", run.report())
			return
		end
	end
end)`,
    pkg,
    { until: "out" },
  );
  if (errors.length || !out) throw new Error(`tycoon balance sim failed:\n${errors.join("\n")}\n${logs.slice(-5).join("\n")}`);
  const r = out as BalanceReport;
  r.firstPrestige ??= null;
  r.allGeneratorsAt ??= null;
  r.allUpgradesAt ??= null;
  // empty Luau tables arrive as {} — normalise lists
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []) as T[];
  r.stalls = list(r.stalls);
  r.prestiges = list(r.prestiges);
  r.samples = list(r.samples);
  return r;
}
