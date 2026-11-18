// Touch-input screenshots of the web player in headless Chromium, as a phone: real touch events
// (CDP Input.dispatchTouchEvent) go through sokol_app into the engine's input routing.
//
//   node tools/web_touch_screenshot.cjs [out-dir] [WxH]      (from engine/, after the web build)
//
// Shots: <out>/touch-0-start.png (dialog open, controls dimmed), touch-1-dialog-tapped.png (after
// tapping through the dialogs), touch-2-held.png (joystick pushed right + A held). The joystick and
// A positions are engine-web's portrait layout in CSS px (input/touch_controls.cpp touch_layout).
// Needs Playwright (NODE_PATH=../engine-web/node_modules), like tools/web_screenshot.cjs.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const buildDir = path.resolve(__dirname, "../build/web");
const outDir = path.resolve(process.argv[2] || "/tmp/dreamsy-e5");
const [width, height] = (process.argv[3] || "540x960").split("x").map(Number);
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".data": "application/octet-stream" };

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const errors = [];
  page.on("console", (m) => { if (/error|panic|abort/i.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("http://dreamsy.test/**", (route) => {
    const file = path.join(buildDir, new URL(route.request().url()).pathname);
    if (!file.startsWith(buildDir) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    route.fulfill({ status: 200, body: fs.readFileSync(file), contentType: types[path.extname(file)] || "application/octet-stream" });
  });
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) });
  const shot = async (name) => {
    const out = path.join(outDir, `touch-${name}.png`);
    await page.screenshot({ path: out });
    console.log(out);
  };

  await page.goto("http://dreamsy.test/dreamsy-player.html");
  await page.waitForTimeout(2500);
  await shot("0-start");
  // Tap through the dialogs in the middle of the screen.
  for (let i = 0; i < 10; i++) {
    await touch("touchStart", [[width / 2, height * 0.4, 1]]);
    await touch("touchEnd", []);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(600);
  await shot("1-dialog-tapped");
  // Joystick (portrait: 116 px at left 28 / bottom 40) pushed right; A (96 px at right 26 / bottom 52) held.
  const stick = [28 + 58, height - 40 - 58];
  const a = [width - 26 - 48, height - 52 - 48];
  await touch("touchStart", [[stick[0], stick[1], 2]]);
  await touch("touchMove", [[stick[0] + 45, stick[1] + 4, 2]]);
  await touch("touchStart", [[stick[0] + 45, stick[1] + 4, 2], [a[0], a[1], 3]]);
  await page.waitForTimeout(400);
  await shot("2-held");
  await touch("touchEnd", []);
  if (errors.length) console.log("ERRORS:\n  " + errors.join("\n  "));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
