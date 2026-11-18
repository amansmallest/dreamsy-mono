/**
 * Browser playtests: the C++ web player (engine/build/web/dreamsy-player.html) in headless Chromium.
 * No server: Playwright answers every request from disk (page.route), like engine/tools/parity.mts.
 * The player runs in manual mode (?manual=1): this driver steps fixed 60 Hz ticks with
 * window.__dreamsy.step(n) up to each input event and screenshot, so times are GAME time and runs
 * are reproducible however slow the machine is. Real 2.5D: the player draws z, blocks and shadows.
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { parseManifest, referenceSize, type Package } from "@dreamsy/format";
import { PLAYTEST_EPOCH, REPO_ROOT, type BrowserPlaytest, type Control, type StartAt, type TimelineStep } from "./playtest.js";

const HOST = "http://dreamsy.test";
const KEY: Record<Control, string> = { left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", jump: "Space", action: "KeyE", action2: "KeyQ" };
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".dpk": "application/octet-stream", ".data": "application/octet-stream" };

/** The web player build: $DREAMSY_WEB_BUILD, else engine/build/web (needs dreamsy-player.html and kits/). */
export function webBuild(): string {
  const dir = resolve(process.env.DREAMSY_WEB_BUILD ?? join(REPO_ROOT, "engine/build/web"));
  if (!existsSync(join(dir, "dreamsy-player.html")) || !existsSync(join(dir, "kits"))) {
    throw new Error(`C++ web player not built in ${dir}: source ~/emsdk/emsdk_env.sh && cd engine && cmake --preset web && cmake --build --preset web --target dreamsy-player (or set DREAMSY_WEB_BUILD)`);
  }
  return dir;
}

let sharedBrowser: Promise<Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let inUse = 0;
/** Idle time before the shared browser closes itself (so scripts exit without calling closeBrowser). */
export const BROWSER_IDLE_MS = 3000;
function browser(): Promise<Browser> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  sharedBrowser ??= chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  return sharedBrowser;
}
function release() {
  if (--inUse > 0 || !sharedBrowser) return;
  idleTimer = setTimeout(() => { idleTimer = null; if (inUse === 0) void closeBrowser(); }, BROWSER_IDLE_MS);
}
export async function closeBrowser() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (sharedBrowser) { const b = await sharedBrowser; sharedBrowser = null; await b.close(); }
}

async function routeFiles(page: Page, build: string, pack: Uint8Array) {
  await page.route(`${HOST}/**`, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === "/pkg.dpk") return route.fulfill({ status: 200, body: Buffer.from(pack), contentType: MIME[".dpk"] });
    const file = path.startsWith("/player/") ? resolve(build, path.slice("/player/".length)) : "";
    if (!file || !file.startsWith(build) || !existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, body: readFileSync(file), contentType: MIME[extname(file)] ?? "application/octet-stream" });
  });
}

export interface BrowserOptions extends StartAt { seed?: number; clock?: number; width?: number; height?: number }

/** Real renderer in headless Chromium; JPEG screenshots at the requested game times. */
export async function playtestBrowser(pkg: Package, timeline: TimelineStep[], shotTimes: number[], opts: BrowserOptions = {}): Promise<BrowserPlaytest> {
  const build = webBuild();
  const m = parseManifest(pkg.text("dreamsy.toml") ?? "").manifest;
  const ref = m ? referenceSize(m) : [1280, 720] as [number, number];
  const width = opts.width ?? ref[0], height = opts.height ?? ref[1];
  const toView = (x: number, y: number): [number, number] => {
    const s = Math.min(width / ref[0], height / ref[1]);
    return [(width - ref[0] * s) / 2 + x * s, (height - ref[1] * s) / 2 + y * s];
  };
  inUse++;
  let page: Page;
  try { page = await (await browser()).newPage({ viewport: { width, height }, deviceScaleFactor: 1 }); } catch (e) { release(); throw e; }
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    // The engine log goes to stderr (console.error) as "[level] text"; game logs are "[game] ..." and
    // game script errors are reported by the headless run, so only engine errors count here.
    const text = msg.text();
    if (msg.type() === "error" && !/^\[(info|warn|debug)\]/.test(text) && !/\[game\]/.test(text)) consoleErrors.push(text.slice(0, 300));
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));
  try {
    await routeFiles(page, build, pkg.toPack());
    const q = new URLSearchParams({ pkg: "/pkg.dpk", kits: "/player/kits/", manual: "1", seed: String(opts.seed ?? 1), clock: String(opts.clock ?? PLAYTEST_EPOCH) });
    if (opts.scene) q.set("scene", opts.scene);
    if (opts.sceneParams) q.set("params", JSON.stringify(opts.sceneParams));
    if (opts.save) q.set("save", JSON.stringify(opts.save));
    await page.goto(`${HOST}/player/dreamsy-player.html?${q}`);
    await page.waitForFunction(() => (window as any).__dreamsy?.ready || (window as any).__dreamsy?.error, null, { timeout: 60_000 });
    const failed = await page.evaluate(() => (window as any).__dreamsy?.error as string | undefined);
    const loadError = failed ? [failed, ...consoleErrors.slice(0, 3)].join(": ") : undefined;
    const shots: BrowserPlaytest["shots"] = [];
    if (!loadError) {
      let ticks = 0;
      const stepTo = async (seconds: number) => {
        const target = Math.round(seconds * 60);
        while (ticks < target) {
          const ran = await page.evaluate((n) => (window as any).__dreamsy.step(n) as number, Math.min(30, target - ticks));
          if (ran === 0) break; // paused
          ticks += ran;
        }
      };
      type Ev = { t: number; run: () => Promise<unknown> };
      const events: Ev[] = [];
      for (const s of timeline) {
        for (const c of s.hold ?? []) if (KEY[c]) events.push({ t: s.t, run: () => page.keyboard.down(KEY[c]) });
        for (const c of s.release ?? []) if (KEY[c]) events.push({ t: s.t, run: () => page.keyboard.up(KEY[c]) });
        for (const c of s.press ?? []) {
          if (!KEY[c]) continue;
          events.push({ t: s.t, run: () => page.keyboard.down(KEY[c]) });
          events.push({ t: s.t + 0.1, run: () => page.keyboard.up(KEY[c]) });
        }
        if (s.tap) { const [x, y] = toView(s.tap[0], s.tap[1]); events.push({ t: s.t, run: () => page.mouse.click(x, y) }); }
        if (s.swipe) {
          const sw = s.swipe, dur = Math.max(0, sw.seconds ?? 0.15);
          const [fx, fy] = toView(sw.from[0], sw.from[1]), [tx, ty] = toView(sw.to[0], sw.to[1]);
          events.push({ t: s.t, run: async () => { await page.mouse.move(fx, fy); await page.mouse.down(); } });
          for (let k = 1; k <= 3; k++) events.push({ t: s.t + (dur * k) / 4, run: () => page.mouse.move(fx + ((tx - fx) * k) / 4, fy + ((ty - fy) * k) / 4) });
          events.push({ t: s.t + dur, run: async () => { await page.mouse.move(tx, ty); await page.mouse.up(); } });
        }
      }
      for (const t of shotTimes) {
        events.push({ t, run: async () => {
          // The page keeps drawing in real time; wait two frames so the last step is on screen.
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          shots.push({ t, jpeg: new Uint8Array(await page.screenshot({ type: "jpeg", quality: 70 })) });
        } });
      }
      events.sort((a, b) => a.t - b.t); // stable: same-time events keep timeline order
      for (const e of events) {
        await stepTo(e.t);
        await e.run();
      }
    }
    const scriptErrors = loadError ? 0 : await page.evaluate(() => ((window as any).__dreamsy?.errors?.() as number) ?? 0);
    return { loadError, consoleErrors, shots, scriptErrors };
  } finally {
    await page.close();
    release();
  }
}
