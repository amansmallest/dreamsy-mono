import { writeFile } from "node:fs/promises";
import { Package } from "@dreamsy/format";
import { closeBrowser, playtestBrowser } from "../engine/browser.js";
import { SMOKE_TIMELINE, type TimelineStep } from "../engine/playtest.js";

const [dir, out, at = "3.5"] = process.argv.slice(2);
if (!dir || !out) {
  console.error("usage: shot <game dir> <out.jpg> [seconds]");
  process.exit(1);
}

const timeline: TimelineStep[] = [{ t: 0.4, tap: [360, 900] }, ...SMOKE_TIMELINE];
try {
  const r = await playtestBrowser(await Package.fromDir(dir), timeline, [Number(at)]);
  const shot = r.shots[0];
  if (!shot) throw new Error(r.loadError ?? "no screenshot");
  await writeFile(out, shot.jpeg);
  console.log(JSON.stringify({ ok: true, bytes: shot.jpeg.byteLength }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: (e as Error).message }));
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
