// tower-defense kit CLI (C++ engine: needs engine/build/<preset>/dreamsy-tool, see kits/_tools/engine.ts):
//   npx tsx kits/tower-defense/cli.ts balance <packageDir> [--endless 30]   → JSON balance report
//   npx tsx kits/tower-defense/cli.ts validate <packageDir>                 → content schema issues
import { dirPackage } from "../_tools/engine.js";
import { balance, validateContent } from "./harness.js";

const [cmd, dir, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
if (!cmd || !dir) {
  console.error("usage: cli.ts balance|validate <packageDir> …");
  process.exit(2);
}
if (cmd === "balance") {
  const t = Date.now();
  const r = await balance(dir, { endlessWaves: Number(flag("--endless") ?? 30) });
  console.log(JSON.stringify(r, null, 2));
  console.error(`(${Date.now() - t} ms)`);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === "validate") {
  const issues = validateContent(dirPackage(dir));
  for (const i of issues) console.log(i);
  process.exit(issues.length ? 1 : 0);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
