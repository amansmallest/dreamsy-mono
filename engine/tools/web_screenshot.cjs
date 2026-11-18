// Screenshots of the web player (build/web/dreamsy-player.html) in headless Chromium.
// No server: Playwright answers every request from the build folder (page.route).
//
//   node tools/web_screenshot.cjs [out-dir] [WxH] [views]     (from engine/, after the web build)
//
// Takes one screenshot per view (default: side,topdown,oblique,iso; "-smooth" suffix forces
// smooth mode, e.g. iso-smooth) via dreamsy-player.html#<view>, and fails if the page logs an error.
// The view "game" adds no hash: the package's own view (manifest / scene `view`).
// Env: DREAMSY_WEB_BUILD = the build folder (default build/web), DREAMSY_SHOT_MS = wait before the
// shot (default 2500), DREAMSY_SHOT_KEYS = "key@ms,key@ms" keys held from that time (e.g. "d@0,Space@900";
// "-key@ms" releases it, "key~@ms" taps it), DREAMSY_SHOT_TAPS = "x:y@ms,..." mouse clicks in page pixels. Needs Playwright: `pnpm install` at the repo root, then run with
// NODE_PATH=../engine-web/node_modules (or any folder where `require("playwright")` resolves).
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const buildDir = path.resolve(process.env.DREAMSY_WEB_BUILD || path.join(__dirname, "../build/web"));
const waitMs = Number(process.env.DREAMSY_SHOT_MS || 2500);
const keys = (process.env.DREAMSY_SHOT_KEYS || "").split(",").filter(Boolean).map((k) => {
  const [key, at] = k.split("@");
  return { key, at: Number(at || 0) };
});
for (const t of (process.env.DREAMSY_SHOT_TAPS || "").split(",").filter(Boolean)) {
  const [xy, at] = t.split("@");
  keys.push({ tap: xy.split(":").map(Number), at: Number(at || 0) });
}
const outDir = path.resolve(process.argv[2] || "/tmp/dreamsy-e4");
const [width, height] = (process.argv[3] || "540x960").split("x").map(Number);
const views = (process.argv[4] || "side,topdown,oblique,iso").split(",");
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".data": "application/octet-stream" };

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  let failed = false;
  for (const view of views) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("console", (m) => {
      const text = m.text();
      if (/error|panic|abort/i.test(text)) errors.push(text);
      if (/\[info\]|\[warn\]/.test(text)) console.log(`  ${view}: ${text}`);
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.route("http://dreamsy.test/**", (route) => {
      const file = path.join(buildDir, new URL(route.request().url()).pathname);
      if (!file.startsWith(buildDir) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
      route.fulfill({ status: 200, body: fs.readFileSync(file), contentType: types[path.extname(file)] || "application/octet-stream" });
    });
    await page.goto(`http://dreamsy.test/dreamsy-player.html${view === "game" ? "" : "#" + view}`);
    // load, first frames, a bit of animation; optional held keys on the way
    let t = 0;
    for (const k of [...keys].sort((a, b) => a.at - b.at)) {
      if (k.at > t) await page.waitForTimeout(k.at - t);
      t = Math.max(t, k.at);
      if (k.tap) await page.mouse.click(k.tap[0], k.tap[1]);
      else if (k.key.startsWith("-")) await page.keyboard.up(k.key.slice(1));
      else if (k.key.endsWith("~")) await page.keyboard.press(k.key.slice(0, -1));
      else await page.keyboard.down(k.key);
    }
    if (waitMs > t) await page.waitForTimeout(waitMs - t);
    const out = path.join(outDir, `web-${view}-${width}x${height}.png`);
    await page.screenshot({ path: out });
    console.log(`${out}${errors.length ? "  ERRORS:\n    " + errors.join("\n    ") : ""}`);
    if (errors.length) failed = true;
    await page.close();
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
