// Screenshots every package under games/examples + games/showcase.
//   tsx tools/screenshot-all.ts <outDir> [--rebuild]
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { ensureBuilt, screenshot } from "./screenshot.js";

const out = resolve(process.argv[2] ?? "shots");
const games = resolve(import.meta.dirname, "../../games");
ensureBuilt(process.argv.includes("--rebuild"));
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
let failed = 0;
for (const group of ["examples", "showcase"]) {
  const root = join(games, group);
  if (!existsSync(root)) continue;
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    if (!existsSync(join(dir, "dreamsy.toml"))) continue;
    const r = await screenshot(dir, join(out, `${d}.png`), { browser, seconds: 3, holdKeys: ["ArrowRight"], tapJumpEvery: 1 });
    const status = r.loadError ? `LOAD: ${r.loadError}` : r.errors.length ? `${r.errors.length} script errors` : "ok";
    if (r.errors.length || r.consoleErrors.length) failed++;
    console.log(`${group}/${d}: ${status} · ${r.entities ?? "-"} entities · ${r.fps?.toFixed(0) ?? "-"} fps · ${r.frameMs?.toFixed(1) ?? "-"} ms/frame → ${r.path}`);
    for (const e of r.errors) console.log(`   ${e.script}:${e.line ?? "?"}: ${e.message} (x${e.count})`);
    for (const e of r.consoleErrors) console.log(`   console: ${e}`);
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
