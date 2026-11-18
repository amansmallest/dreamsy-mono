/**
 * Headless helpers for the tycoon kit (tests + harness):
 *  - runLuau(src, pkg?, {clock?}): runs a client script headless and returns what it `save.set("out", …)`.
 *  - balance(pkg, {hours}): greedy-player simulation (`@kit/tycoon/balance`) of the package's own data → pacing report.
 * The kit reads content itself (`Tycoon.new()` → data/tycoon.json + data/{generators,upgrades,achievements,events}/*.json).
 */
import { Package } from "@dreamsy/format";
import { Game, MemorySaveHost } from "../../engine-web/core/index.js";

// ---------- headless runs ----------

const MANIFEST = `format = "0"\nname = "kit test"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/__run.scene.json"\nkits = ["tycoon"]\n[style]\npreset = "clean"\n`;

/** Run `src` (a client script) inside `base` (or an empty package); returns `save.get("out")`, logs, errors. */
export async function runLuau(src: string, base?: Package, opts: { steps?: number; files?: Record<string, string>; until?: (save: Record<string, unknown>) => boolean; clock?: () => number; save?: MemorySaveHost } = {}) {
  let files: Record<string, Uint8Array | string> = {};
  if (base) for (const p of base.paths()) files[p] = base.bytes(p)!;
  files = {
    ...files,
    "dreamsy.toml": MANIFEST,
    "scenes/__run.scene.json": JSON.stringify({ format: "0", root: "run_root", entities: { run_root: { type: "Node2D" } } }),
    ...opts.files,
  };
  for (const p of Object.keys(files)) if (/^scripts\/(client|server)\//.test(p)) delete files[p];
  files["scripts/client/__run.luau"] = src;
  const host = opts.save ?? new MemorySaveHost();
  const game = await Game.load(Package.fromFiles(files), { seed: 1, save: host, clock: opts.clock });
  for (let i = 0; i < (opts.steps ?? 1); i++) game.step();
  if (opts.until) for (let i = 0; i < 100000 && !opts.until(host.data) && !game.errors.length; i++) game.step();
  const errors = game.errors.map((e) => `${e.script}:${e.line ?? "?"}: ${e.message}`);
  return { out: host.data.out as any, logs: game.logs.map((l) => l.text), errors };
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
export async function balance(pkg: Package, opts: { hours?: number; dt?: number; prestigeRatio?: number; stallSeconds?: number } = {}): Promise<BalanceReport> {
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
    { until: (d) => d.out !== undefined },
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
