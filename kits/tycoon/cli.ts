// tycoon kit CLI (C++ engine: needs engine/build/<preset>/dreamsy-tool, see kits/_tools/engine.ts):
//   npx tsx kits/tycoon/cli.ts balance <packageDir> [--hours 2] [--dt 1] [--prestige-ratio 2] [--stall 180]   → JSON pacing report
import { balance } from "./harness.js";

const [cmd, dir, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? Number(rest[i + 1]) : undefined; };
if (cmd !== "balance" || !dir) {
  console.error("usage: cli.ts balance <packageDir> [--hours 2] [--dt 1] [--prestige-ratio 2] [--stall 180]");
  process.exit(2);
}
const t = Date.now();
const opts = Object.fromEntries(Object.entries({ hours: flag("--hours"), dt: flag("--dt"), prestigeRatio: flag("--prestige-ratio"), stallSeconds: flag("--stall") }).filter(([, v]) => v !== undefined));
const r = await balance(dir, opts);
console.log(JSON.stringify(r, null, 2));
console.error(`(${Date.now() - t} ms)`);
process.exit(r.smooth ? 0 : 1);
