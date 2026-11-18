// Runs a package headless in engine-web and prints a report that `dreamsy-tool run` reproduces:
//   npx tsx ../engine/tests/conformance/ts_run.mts <dir> [ticks] [seed] [budgetMs] [inputPlan] [dumpSpec]
// (run from format/ or engine-web/). Logs as "[level] text" as they happen, entity dumps, then errors,
// audio events, final save data and game time.
//
// inputPlan (same format as `dreamsy-tool run --input`): items separated by ';'
//   "30-200:move_x=1"  axis on ticks 30..200 (0 after)   "40-45:jump"  button held   "60:jump"  tap
// dumpSpec (same as `--dump`): "N:id,#tag" -> every N ticks "dump <tick> <id> <x> <y> [<vx> <vy>]".
import { Package } from "../../../format/src/index.ts";
import { Game } from "../../../engine-web/core/index.ts";
import { global2D, type Entity } from "../../../engine-web/core/world.ts";

const [dir, ticksArg, seedArg, budgetArg, planArg, dumpArg] = process.argv.slice(2);
const ticks = Number(ticksArg ?? 120), seed = Number(seedArg ?? 1);

interface InputItem { from: number; to: number; name: string; axis: boolean; tap: boolean; value: number }
const plan: InputItem[] = [];
for (const raw of (planArg ?? "").split(";")) {
  const item = raw.trim();
  if (!item) continue;
  const [t, w] = [item.slice(0, item.indexOf(":")), item.slice(item.indexOf(":") + 1)];
  const [a, b] = t.split("-");
  const it: InputItem = { from: Number(a), to: Number(b ?? a), name: w, axis: false, tap: b === undefined, value: 0 };
  if (w.includes("=")) { it.axis = true; it.tap = false; it.name = w.slice(0, w.indexOf("=")); it.value = Number(w.slice(w.indexOf("=") + 1)); }
  plan.push(it);
}
const dumpEvery = dumpArg ? Number(dumpArg.slice(0, dumpArg.indexOf(":"))) : 0;
const dumpSel = dumpArg ? dumpArg.slice(dumpArg.indexOf(":") + 1).split(",").map((s) => s.trim()).filter(Boolean) : [];

const out: string[] = [];
let game: Game | undefined;
game = await Game.load(await Package.fromDir(dir!), {
  seed, clock: () => 1767225600 + (game?.time ?? 0), budgetMs: budgetArg ? Number(budgetArg) : undefined,
  onLog: (l) => out.push(`[${l.level}] ${l.text}`),
});
const g = game!;
for (let i = 1; i <= ticks; i++) {
  for (const it of plan) {
    if (it.tap) { if (i === it.from) g.input.tap(it.name); }
    else if (it.axis) { if (i === it.from) g.input.setAxis(it.name, it.value); if (i === it.to + 1) g.input.setAxis(it.name, 0); }
    else { if (i === it.from) g.input.setButton(it.name, true); if (i === it.to + 1) g.input.setButton(it.name, false); }
  }
  g.step();
  if (dumpEvery > 0 && i % dumpEvery === 0) {
    for (const sel of dumpSel) {
      const list: Entity[] = sel.startsWith("#") ? g.world.tagged(sel.slice(1)) : [g.world.byId.get(sel)].filter((e): e is Entity => !!e);
      for (const e of list) {
        const m = global2D(e);
        let line = `dump ${i} ${e.id} ${m[4]} ${m[5]}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const physics = (g as any).physics;
        if (e.type === "Body2D" && physics) { const v = physics.getVelocity(e); line += ` ${v[0]} ${v[1]}`; }
        out.push(line);
      }
    }
  }
}
for (const e of g.errors) out.push(`error ${e.script}:${e.line ?? 0} x${e.count}: ${e.message}`);
for (const a of g.audioLog) {
  const ev = a as unknown as Record<string, unknown>;
  out.push(`audio ${ev.kind} ${ev.id ?? ""} ${ev.volume ?? ""} ${ev.pitch ?? ""} ${ev.fade ?? ""} ${ev.time}`);
}
out.push(`save ${JSON.stringify(g.save)}`);
out.push(`time ${g.time}`);
console.log(out.join("\n"));
