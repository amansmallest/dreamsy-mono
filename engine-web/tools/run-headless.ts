// Quick headless run: tsx tools/run-headless.ts <packageDir> [ticks]
import { Package } from "@dreamsy/format";
import { Game } from "../core/index.js";

const dir = process.argv[2]!;
const ticks = Number(process.argv[3] ?? 300);
const game = await Game.load(await Package.fromDir(dir), { onLog: (l) => console.log(`[${l.level}] ${l.text}`) });
const p = game.avatar();
console.log("entities", game.world.count, "player", p?.get("position"));
for (let i = 0; i < ticks; i++) {
  game.input.setAxis("move_x", 1);
  if (i % 40 === 0) game.input.setButton("jump", true);
  if (i % 40 === 10) game.input.setButton("jump", false);
  game.step();
  if (i % 30 === 0) console.log(i, "player", p?.get("position"), "onFloor?", );
}
console.log("entities", game.world.count, "errors", game.errors.length, "mem", game.memoryUsed());
