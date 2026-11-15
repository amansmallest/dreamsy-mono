// Playtest screenshot: boots a package in headless Chromium with the real renderer and saves a PNG.
//   tsx tools/screenshot.ts <packageDir> <out.png> [--seconds 3] [--hold right,jump] [--size 720x1280]
//     (default size = the game's reference screen: 720×1280 portrait, 1280×720 landscape)
//     [--scene scenes/level_2.scene.json] [--params '{"level":3}'] [--save '{"coins":50}'] [--clock 1767225600]
//     [--tap 640,400@0.5] [--rebuild]
// Time is GAME time: the page runs in manual mode (no rAF loop) and the tool steps fixed ticks up to each tap /
// the shot, so results are reproducible no matter how slow headless Chromium renders.
// dist/ is rebuilt automatically when engine sources (core, render, input, dev, kits, luau, format) are newer.
// Starts a static server inside this process only (dist/ + the package zip) and tears it down.
import { createServer, type Server } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Package, parseManifest, referenceSize } from "@dreamsy/format";
import { PLAYTEST_EPOCH } from "../core/index.js";
import { chromium, type Browser, type Page } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

/** Start state for tools: mid-game scene, its params, preloaded save data, fixed clock. */
export interface BootOptions {
  /** Start in this scene instead of entry_scene, e.g. "scenes/level_2.scene.json". */
  scene?: string;
  /** sceneParams() of the start scene. */
  sceneParams?: Record<string, unknown>;
  /** Preloaded save data (save.get sees it; in-memory, nothing persists). */
  save?: Record<string, unknown>;
  /** clock.now() base (unix seconds); default PLAYTEST_EPOCH. */
  clock?: number;
  seed?: number;
  /** Per-call Luau CPU budget (ms). */
  budgetMs?: number;
}

export interface ScreenshotOptions extends BootOptions {
  seconds?: number;
  width?: number;
  height?: number;
  /** Keys held for the whole run, e.g. ["ArrowRight"]; "Space" taps periodically when `tapJump`. */
  holdKeys?: string[];
  tapJumpEvery?: number;
  rebuild?: boolean;
  /** Extra page query, e.g. "insets=47,0,34,0". */
  query?: string;
  /** UI taps in reference coords (720×1280 portrait / 1280×720 landscape), mapped into the letterboxed viewport. */
  taps?: { t: number; at: [number, number] }[];
  /** Show on-screen touch controls (default off). */
  touch?: boolean;
  /** Reuse a browser across calls. */
  browser?: Browser;
}

export interface ScreenshotResult {
  path: string;
  errors: { script: string; line?: number; message: string; count: number }[];
  logs: string[];
  loadError?: string;
  fps?: number;
  /** Sim + render time of the last frame (ms). */
  frameMs?: number;
  entities?: number;
  consoleErrors: string[];
}

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

/** Newest mtime (ms) of engine sources that end up in dist/. */
export function newestSourceMtime(): number {
  let newest = 0;
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  for (const d of ["core", "render", "input", "dev", "kits", "luau/dist"]) walk(join(ROOT, d));
  walk(join(ROOT, "../format/src"));
  for (const f of ["../format/catalog.json", "vite.config.ts", "package.json"]) if (existsSync(join(ROOT, f))) newest = Math.max(newest, statSync(join(ROOT, f)).mtimeMs);
  return newest;
}

/** Build dist/ if missing, forced, or older than any engine source (kits included). */
export function ensureBuilt(rebuild = false) {
  const index = join(DIST, "index.html");
  const stale = !existsSync(index) || statSync(index).mtimeMs < newestSourceMtime();
  if (rebuild || stale) {
    execFileSync(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--logLevel", "warn"], { cwd: ROOT, stdio: "inherit" });
  }
}

export function serve(zip: Uint8Array): Promise<{ server: Server; url: string }> {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      if (path === "/pkg.zip") {
        res.writeHead(200, { "content-type": "application/zip" });
        res.end(Buffer.from(zip));
        return;
      }
      const file = resolve(DIST, "." + (path === "/" ? "/index.html" : path));
      if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      ok({ server, url: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}` });
    });
  });
}

/** Default viewport for a package: its reference screen (portrait 720×1280, landscape 1280×720). */
export function defaultViewport(pkg: Package): [number, number] {
  const m = parseManifest(pkg.text("dreamsy.toml") ?? "").manifest;
  return m ? referenceSize(m) : [1280, 720];
}

/** Page URL query + init script for BootOptions (manual stepping on). */
export async function bootPage(page: Page, base: string, boot: BootOptions, extraQuery = ""): Promise<string | undefined> {
  if (boot.save || boot.sceneParams) {
    await page.addInitScript((b) => { (window as any).__dreamsyBoot = b; }, { save: boot.save, sceneParams: boot.sceneParams });
  }
  const q = new URLSearchParams({ zip: "/pkg.zip", manual: "1", seed: String(boot.seed ?? 1), clock: String(boot.clock ?? PLAYTEST_EPOCH), save: "0" });
  if (boot.scene) q.set("scene", boot.scene);
  if (boot.budgetMs) q.set("budget", String(boot.budgetMs));
  await page.goto(`${base}/index.html?${q}${extraQuery ? `&${extraQuery}` : ""}`);
  await page.waitForFunction(() => (window as any).__dreamsy?.ready || (window as any).__dreamsy?.error, null, { timeout: 60000 });
  return page.evaluate(() => (window as any).__dreamsy?.error as string | undefined);
}

/** Manual mode: step the game to `seconds` of game time (ticks at 60 Hz). Returns the tick reached. */
export async function stepTo(page: Page, seconds: number): Promise<number> {
  const target = Math.round(seconds * 60);
  for (;;) {
    const r = await page.evaluate((target) => {
      const d = (window as any).__dreamsy;
      const g = d.game;
      const n = Math.min(30, target - g.tick);
      if (n <= 0) return { tick: g.tick, done: true };
      const ran = d.step(n);
      return { tick: g.tick, done: ran === 0 };
    }, target);
    if (r.done) {
      await page.evaluate(() => (window as any).__dreamsy.step(0)); // render the current state
      return r.tick;
    }
  }
}

/** Reference coords → viewport px for a letterboxed game rect. */
export function refToViewport(ref: [number, number], vw: number, vh: number, x: number, y: number): [number, number] {
  const s = Math.min(vw / ref[0], vh / ref[1]);
  return [(vw - ref[0] * s) / 2 + x * s, (vh - ref[1] * s) / 2 + y * s];
}

export async function screenshot(packageDir: string, outPng: string, opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  ensureBuilt(opts.rebuild);
  const pkg = await Package.fromDir(packageDir);
  const ref = defaultViewport(pkg);
  const width = opts.width ?? ref[0], height = opts.height ?? ref[1];
  const { server, url } = await serve(pkg.toZip());
  const browser = opts.browser ?? (await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] }));
  const consoleErrors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    const loadError = await bootPage(page, url, opts, `touch=${opts.touch ? 1 : 0}${opts.query ? `&${opts.query}` : ""}`);
    if (!loadError) {
      // everything below is in game time (manual stepping)
      type Ev = { t: number; run: () => Promise<unknown> };
      const total = opts.seconds ?? 3;
      const events: Ev[] = [];
      for (const k of opts.holdKeys ?? []) { events.push({ t: 0, run: () => page.keyboard.down(k) }); events.push({ t: total, run: () => page.keyboard.up(k) }); }
      if (opts.tapJumpEvery) {
        for (let t = 0; t < total; t += opts.tapJumpEvery) {
          events.push({ t, run: () => page.keyboard.down("Space") });
          events.push({ t: t + 0.12, run: () => page.keyboard.up("Space") });
        }
      }
      for (const tap of opts.taps ?? []) {
        const [x, y] = refToViewport(ref, width, height, tap.at[0], tap.at[1]);
        events.push({ t: tap.t, run: () => page.mouse.click(x, y) });
      }
      events.sort((a, b) => a.t - b.t);
      for (const e of events) {
        if (e.t > total) break;
        await stepTo(page, e.t);
        await e.run();
      }
      await stepTo(page, total);
    }
    await mkdir(dirname(resolve(outPng)), { recursive: true });
    await writeFile(outPng, await page.screenshot());
    const info = await page.evaluate(() => {
      const g = (window as any).__dreamsy?.game;
      return {
        errors: g ? g.errors.map((e: any) => ({ script: e.script, line: e.line, message: e.message, count: e.count })) : [],
        logs: g ? g.logs.map((l: any) => `[${l.level}] ${l.text}`) : [],
        fps: (window as any).__dreamsy?.stats?.fps,
        frameMs: (window as any).__dreamsy?.stats?.frameMs,
        entities: g?.world.count,
      };
    });
    await page.close();
    return { path: outPng, loadError, consoleErrors, ...info };
  } finally {
    if (!opts.browser) await browser.close();
    server.close();
  }
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const seconds = Number(flag("--seconds") ?? 3);
  const size = flag("--size");
  const hold = flag("--hold");
  const scene = flag("--scene");
  const sceneParams = flag("--params"), saveJson = flag("--save"), clock = flag("--clock");
  const tapFlags: string[] = []; // "x,y[@seconds]", repeatable
  for (let t = flag("--tap"); t !== undefined; t = flag("--tap")) tapFlags.push(t);
  const rebuild = args.includes("--rebuild");
  const pos = args.filter((a) => !a.startsWith("--"));
  if (pos.length < 2) {
    console.error("usage: tsx tools/screenshot.ts <packageDir> <out.png> [--seconds 3] [--hold ArrowRight] [--size WxH (default: game orientation)] [--scene scenes/x.scene.json] [--params JSON] [--save JSON] [--clock unix] [--tap x,y@sec]... (repeatable) [--touch] [--query insets=47,0,34,0] [--rebuild]");
    process.exit(2);
  }
  const touch = args.includes("--touch");
  const query = flag("--query");
  const [w, h] = size ? size.split("x").map(Number) : [undefined, undefined];
  const r = await screenshot(pos[0]!, pos[1]!, { seconds, width: w, height: h, rebuild, scene, touch, query, holdKeys: hold ? hold.split(",") : [],
    sceneParams: sceneParams ? JSON.parse(sceneParams) : undefined, save: saveJson ? JSON.parse(saveJson) : undefined, clock: clock ? Number(clock) : undefined,
    taps: tapFlags.map((tap) => ({ t: Number(tap.split("@")[1] ?? 0.5), at: tap.split("@")[0]!.split(",").map(Number) as [number, number] })) });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.loadError || r.errors.length ? 1 : 0);
}
