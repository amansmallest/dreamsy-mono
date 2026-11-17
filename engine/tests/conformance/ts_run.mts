// Runs a package headless in engine-web and prints a report that `dreamsy-tool run` reproduces exactly:
//   npx tsx ../engine/tests/conformance/ts_run.mts <dir> [ticks] [seed] [budgetMs]   (run from format/ or engine-web/)
// Logs as "[level] text", then errors, audio events, final save data and game time.
import { Package } from "../../../format/src/index.ts";
import { Game } from "../../../engine-web/core/index.ts";

const [dir, ticksArg, seedArg, budgetArg] = process.argv.slice(2);
const ticks = Number(ticksArg ?? 120), seed = Number(seedArg ?? 1);
const out: string[] = [];
let game: Game | undefined;
game = await Game.load(await Package.fromDir(dir!), {
  seed, clock: () => 1767225600 + (game?.time ?? 0), budgetMs: budgetArg ? Number(budgetArg) : undefined,
  onLog: (l) => out.push(`[${l.level}] ${l.text}`),
});
const g = game!;
for (let i = 0; i < ticks; i++) g.step();
for (const e of g.errors) out.push(`error ${e.script}:${e.line ?? 0} x${e.count}: ${e.message}`);
for (const a of g.audioLog) {
  const ev = a as unknown as Record<string, unknown>;
  out.push(`audio ${ev.kind} ${ev.id ?? ""} ${ev.volume ?? ""} ${ev.pitch ?? ""} ${ev.fade ?? ""} ${ev.time}`);
}
out.push(`save ${JSON.stringify(g.save)}`);
out.push(`time ${g.time}`);
console.log(out.join("\n"));
