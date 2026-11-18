// Screenshots of the web player (build/web/dreamsy-player.html) in headless Chromium.
// No server: Playwright answers every request from the build folder (page.route).
//
//   node tools/web_screenshot.cjs [out-dir] [WxH] [views]     (from engine/, after the web build)
//
// Takes one screenshot per view (default: side,topdown,oblique,iso; "-smooth" suffix forces
// smooth mode, e.g. iso-smooth) via dreamsy-player.html#<view>, and fails if the page logs an error. Needs Playwright: `pnpm install` at the repo root, then run with
// NODE_PATH=../engine-web/node_modules (or any folder where `require("playwright")` resolves).
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const buildDir = path.resolve(__dirname, "../build/web");
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
    await page.goto(`http://dreamsy.test/dreamsy-player.html#${view}`);
    await page.waitForTimeout(2500);  // load, first frames, a bit of animation
    const out = path.join(outDir, `web-${view}-${width}x${height}.png`);
    await page.screenshot({ path: out });
    console.log(`${out}${errors.length ? "  ERRORS:\n    " + errors.join("\n    ") : ""}`);
    if (errors.length) failed = true;
    await page.close();
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
