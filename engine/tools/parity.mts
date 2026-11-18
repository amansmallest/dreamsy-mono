// Side-by-side parity screenshots: every game in engine-web (the reference) and the C++ web player,
// at the same reference size and the same game time, with the same scripted input. Writes per-game
// pairs (engine-web | C++ | difference), a contact sheet and a pixel-difference score per shot.
//
//   cd engine && ../engine-web/node_modules/.bin/tsx tools/parity.mts [options] [game-dir ...]
//
//   --out DIR          output folder (default /tmp/dreamsy-parity)
//   --games a,b        only these games (folder name, or group/name like mine/coin-dash)
//   --baseline FILE    an earlier run's results.json: the table shows before -> after
//   --only cpp|web     re-shoot one engine (the other's PNGs from an earlier run in --out are reused)
//
// Game dirs default to games/examples, games/showcase and games/mine (when present). Needs the web
// player (cmake --build --preset web --target dreamsy-player) and pnpm-installed engine-web; the
// engine-web dist/ is rebuilt when its sources changed (engine-web/tools/screenshot.ts ensureBuilt).
//
// No server is started: Playwright answers every request from disk (page.route). Both engines run
// in manual mode (?manual=1): the tool steps fixed 60 Hz ticks up to each input event and the shot,
// so results don't depend on how fast headless Chromium renders.
//
// Shots per game (override per game in tools/parity_games.json):
//   title  1.5 s, no input
//   play   tap the screen center at 1.6 s, hold ArrowRight, tap Space every second; shot at 4.5 s
//
// Score: mean absolute RGB difference in percent, measured on both images downscaled 4x (so
// antialiasing and font hinting barely count; layout, color and missing things do). 0 = identical.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { Package } from "../../format/src/index.ts";
import { PLAYTEST_EPOCH } from "../../engine-web/core/index.ts";
import { bootPage, defaultViewport, ensureBuilt, refToViewport, stepTo } from "../../engine-web/tools/screenshot.ts";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(ENGINE, "..");
const CPP_BUILD = join(ENGINE, "build/web");
const WEB_DIST = join(REPO, "engine-web/dist");
const HOST = "http://dreamsy.test";
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".zip": "application/zip" };
// Playwright is an engine-web dev dependency; resolve it from there.
const { chromium } = createRequire(join(REPO, "engine-web/package.json"))("playwright") as typeof import("playwright");
const CHROMIUM_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

interface Shot {
  name: string;
  seconds: number;
  /** UI taps in reference px at a game time. */
  taps?: { t: number; at: [number, number] }[];
  /** Keys held from 0 to the shot. */
  hold?: string[];
  /** Taps Space every N seconds. */
  jumpEvery?: number;
}
interface GameConfig { shots?: Shot[]; skip?: string }

function defaultShots(ref: [number, number]): Shot[] {
  return [
    { name: "title", seconds: 1.5 },
    { name: "play", seconds: 4.5, taps: [{ t: 1.6, at: [ref[0] / 2, ref[1] / 2] }], hold: ["ArrowRight"], jumpEvery: 1 },
  ];
}

// ---------------------------------------------------------------- options

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const outDir = resolve(flag("--out") ?? "/tmp/dreamsy-parity");
const only = flag("--only") as "cpp" | "web" | undefined;
const gamesFilter = flag("--games")?.split(",");
const baselineFile = flag("--baseline");
const dirsArg = args.filter((a) => !a.startsWith("--"));

const config: Record<string, GameConfig> = existsSync(join(ENGINE, "tools/parity_games.json"))
  ? JSON.parse(readFileSync(join(ENGINE, "tools/parity_games.json"), "utf8")) : {};

// "examples/coin-dash" (games/mine has copies of some examples).
const gameId = (dir: string) => `${basename(dirname(dir))}/${basename(dir)}`;

function gameDirs(): string[] {
  if (dirsArg.length) return dirsArg.map((d) => resolve(d));
  const out: string[] = [];
  for (const group of ["games/examples", "games/showcase", "games/mine"]) {
    const root = join(REPO, group);
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root).sort()) if (existsSync(join(root, d, "dreamsy.toml"))) out.push(join(root, d));
  }
  return out;
}

// ---------------------------------------------------------------- serving (no server)

async function routeFiles(page: Page, zip: Uint8Array) {
  await page.route(`${HOST}/**`, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === "/pkg.zip") return route.fulfill({ status: 200, body: Buffer.from(zip), contentType: "application/zip" });
    const [root, rest] = path.startsWith("/cpp/") ? [CPP_BUILD, path.slice(5)] : path.startsWith("/ew/") ? [WEB_DIST, path.slice(4)] : ["", ""];
    const file = root && resolve(root, rest || "index.html");
    if (!file || !file.startsWith(root) || !existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, body: readFileSync(file), contentType: MIME[extname(file)] ?? "application/octet-stream" });
  });
}

// ---------------------------------------------------------------- one shot in one engine

interface ShotResult { file: string; errors: string[] }

type Engine = "web" | "cpp";

async function shoot(browser: Browser, engine: Engine, zip: Uint8Array, ref: [number, number], shot: Shot, file: string): Promise<ShotResult> {
  const [w, h] = ref;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("console", (m) => {
    // The C++ log goes to stderr (console.error) with a [level] prefix; only errors count.
    const text = m.text();
    if (m.type() === "error" && !/^\[(info|warn)\]/.test(text)) errors.push(text.slice(0, 300));
  });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  await routeFiles(page, zip);
  let ticks = 0;
  // Advance to `seconds` of game time.
  const stepCpp = async (seconds: number) => {
    const target = Math.round(seconds * 60);
    while (ticks < target) {
      const ran = await page.evaluate((n) => (window as any).__dreamsy.step(n), Math.min(30, target - ticks));
      if (ran === 0) break;  // paused
      ticks += ran;
    }
  };
  const step = engine === "web" ? (s: number) => stepTo(page, s) : stepCpp;
  try {
    let loadError: string | undefined;
    if (engine === "web") {
      loadError = await bootPage(page, `${HOST}/ew`, { clock: PLAYTEST_EPOCH, seed: 1 }, "touch=0&embed=1")  // embed: the shipping app page (no dev HUD);
    } else {
      await page.goto(`${HOST}/cpp/dreamsy-player.html?pkg=/pkg.zip&kits=/cpp/kits/&manual=1&seed=1&clock=${PLAYTEST_EPOCH}`);
      await page.waitForFunction(() => (window as any).__dreamsy?.ready || (window as any).__dreamsy?.error, null, { timeout: 60000 });
      loadError = await page.evaluate(() => (window as any).__dreamsy?.error as string | undefined);
    }
    if (loadError) errors.push(`load: ${loadError}`);
    else {
      const events: { t: number; run: () => Promise<unknown> }[] = [];
      for (const k of shot.hold ?? []) events.push({ t: 0, run: () => page.keyboard.down(k) });
      if (shot.jumpEvery) {
        for (let t = 0; t < shot.seconds; t += shot.jumpEvery) {
          events.push({ t, run: () => page.keyboard.down("Space") });
          events.push({ t: t + 0.12, run: () => page.keyboard.up("Space") });
        }
      }
      for (const tap of shot.taps ?? []) {
        const [x, y] = refToViewport(ref, w, h, tap.at[0], tap.at[1]);
        events.push({ t: tap.t, run: () => page.mouse.click(x, y) });
      }
      events.sort((a, b) => a.t - b.t);
      for (const e of events) {
        if (e.t > shot.seconds) break;
        await step(e.t);
        await e.run();
      }
      await step(shot.seconds);
      if (engine === "cpp") {
        // The real-time loop keeps drawing; wait for two frames so the last step is on screen.
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const n = await page.evaluate(() => (window as any).__dreamsy.errors());
        if (n) errors.push(`${n} script error(s)`);
      } else {
        const n = await page.evaluate(() => (window as any).__dreamsy?.game?.errors?.length ?? 0);
        if (n) errors.push(`${n} script error(s)`);
      }
    }
    await page.screenshot({ path: file });
  } catch (e) {
    errors.push(String(e).slice(0, 300));
  } finally {
    await page.close();
  }
  return { file, errors };
}

// ---------------------------------------------------------------- diff + pair image (in the browser)

async function compare(browser: Browser, webPng: string, cppPng: string, pairPng: string): Promise<number> {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  const a = `data:image/png;base64,${readFileSync(webPng).toString("base64")}`;
  const b = `data:image/png;base64,${readFileSync(cppPng).toString("base64")}`;
  // Plain JavaScript (a string): tsx would add helpers to a TS function that don't exist in the page.
  const r = await page.evaluate(`(async (a, b) => {
    const load = (src) => new Promise((ok, err) => { const i = new Image(); i.onload = () => ok(i); i.onerror = err; i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = ia.width, h = ia.height;
    // score on 4x downscaled copies
    const sw = Math.max(1, Math.round(w / 4)), sh = Math.max(1, Math.round(h / 4));
    const small = (img) => {
      const c = document.createElement("canvas"); c.width = sw; c.height = sh;
      const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(img, 0, 0, sw, sh);
      return x.getImageData(0, 0, sw, sh).data;
    };
    const da = small(ia), db = small(ib);
    let sum = 0;
    for (let i = 0; i < da.length; i += 4) sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
    const score = (sum / (sw * sh * 3 * 255)) * 100;
    // pair image: web | cpp | |diff| x3, at half size
    const hw = Math.round(w / 2), hh = Math.round(h / 2), gap = 8;
    const c = document.createElement("canvas"); c.width = hw * 3 + gap * 2; c.height = hh;
    const x = c.getContext("2d");
    x.fillStyle = "#888"; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(ia, 0, 0, hw, hh);
    x.drawImage(ib, hw + gap, 0, hw, hh);
    const fa = document.createElement("canvas"); fa.width = hw; fa.height = hh;
    const xa = fa.getContext("2d"); xa.drawImage(ia, 0, 0, hw, hh);
    const pa = xa.getImageData(0, 0, hw, hh);
    xa.drawImage(ib, 0, 0, hw, hh);
    const pb = xa.getImageData(0, 0, hw, hh);
    for (let i = 0; i < pa.data.length; i += 4) {
      for (let k = 0; k < 3; k++) pa.data[i + k] = Math.min(255, Math.abs(pa.data[i + k] - pb.data[i + k]) * 3);
      pa.data[i + 3] = 255;
    }
    xa.putImageData(pa, 0, 0);
    x.drawImage(fa, (hw + gap) * 2, 0);
    return { score, png: c.toDataURL("image/png") };
  })(${JSON.stringify(a)}, ${JSON.stringify(b)})`) as { score: number; png: string };
  writeFileSync(pairPng, Buffer.from(r.png.split(",")[1]!, "base64"));
  await page.close();
  return r.score;
}

// ---------------------------------------------------------------- main

interface Row { game: string; shot: string; score: number | null; web: string; cpp: string; pair: string; errors: { web: string[]; cpp: string[] } }

const dirs = gameDirs().filter((d) => !gamesFilter || gamesFilter.includes(basename(d)) || gamesFilter.includes(gameId(d)));
ensureBuilt();
if (!existsSync(join(CPP_BUILD, "dreamsy-player.html"))) throw new Error(`no web player in ${CPP_BUILD}: cmake --build --preset web --target dreamsy-player`);
mkdirSync(join(outDir, "shots"), { recursive: true });
const baseline: Row[] = baselineFile ? JSON.parse(readFileSync(baselineFile, "utf8")) : [];
const previous: Row[] = existsSync(join(outDir, "results.json")) ? JSON.parse(readFileSync(join(outDir, "results.json"), "utf8")) : [];
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const rows: Row[] = [];
for (const dir of dirs) {
  const game = gameId(dir);
  const cfg = config[game] ?? config[basename(dir)] ?? {};
  if (cfg.skip) { console.log(`${game}: skipped (${cfg.skip})`); continue; }
  let pkg: Package;
  try { pkg = await Package.fromDir(dir); } catch (e) { console.log(`${game}: can't read (${e})`); continue; }
  const ref = defaultViewport(pkg) as [number, number];
  const zip = pkg.toZip();
  for (const shot of cfg.shots ?? defaultShots(ref)) {
    const stem = join(outDir, "shots", `${game.replace("/", "-")}-${shot.name}`);
    const prev = previous.find((r) => r.game === game && r.shot === shot.name);
    const web = only === "cpp" && existsSync(`${stem}-web.png`) ? { file: `${stem}-web.png`, errors: prev?.errors.web ?? [] }
      : await shoot(browser, "web", zip, ref, shot, `${stem}-web.png`);
    const cpp = only === "web" && existsSync(`${stem}-cpp.png`) ? { file: `${stem}-cpp.png`, errors: prev?.errors.cpp ?? [] }
      : await shoot(browser, "cpp", zip, ref, shot, `${stem}-cpp.png`);
    let score: number | null = null;
    try { score = await compare(browser, web.file, cpp.file, `${stem}-pair.png`); } catch (e) { cpp.errors.push(`compare: ${String(e).slice(0, 200)}`); }
    const row: Row = { game, shot: shot.name, score, web: web.file, cpp: cpp.file, pair: `${stem}-pair.png`, errors: { web: web.errors, cpp: cpp.errors } };
    rows.push(row);
    const before = baseline.find((r) => r.game === game && r.shot === shot.name)?.score;
    const errs = [...web.errors.map((e) => `web: ${e}`), ...cpp.errors.map((e) => `cpp: ${e}`)];
    console.log(`${game.padEnd(30)} ${shot.name.padEnd(8)} ${before !== undefined && before !== null ? `${before.toFixed(2).padStart(6)} -> ` : ""}${score === null ? "  fail" : score.toFixed(2).padStart(6)}${errs.length ? "  " + errs.join(" | ") : ""}`);
  }
}

// results.json: merge with the previous run (a --games run updates only those games)
const merged = [...previous.filter((p) => !rows.some((r) => r.game === p.game && r.shot === p.shot)), ...rows]
  .sort((a, b) => a.game.localeCompare(b.game) || a.shot.localeCompare(b.shot));
writeFileSync(join(outDir, "results.json"), JSON.stringify(merged, null, 2));

// contact sheet: worst first
const sorted = [...merged].sort((a, b) => (b.score ?? 1e9) - (a.score ?? 1e9));
const rel = (p: string) => p.replace(outDir + "/", "");
const html = `<!doctype html><meta charset="utf-8"><title>Dreamsy parity</title>
<style>body{font:14px system-ui;background:#1b1b22;color:#ddd;margin:16px}figure{display:inline-block;margin:8px;vertical-align:top}
figcaption{margin-bottom:4px}img{max-width:720px;max-height:420px;border:1px solid #444}b{color:#ffcd75}</style>
<h1>engine-web | C++ | difference x3</h1>
${sorted.map((r) => `<figure><figcaption><b>${r.score === null ? "fail" : r.score.toFixed(2)}</b> ${r.game} / ${r.shot}${r.errors.cpp.length || r.errors.web.length ? ` <span style="color:#f88">${[...r.errors.web.map((e) => "web: " + e), ...r.errors.cpp.map((e) => "cpp: " + e)].join(" | ").replace(/</g, "&lt;")}</span>` : ""}</figcaption><img src="${rel(r.pair)}"></figure>`).join("\n")}`;
writeFileSync(join(outDir, "index.html"), html);
// contact.png: the same, as thumbnails on one canvas (a full-page screenshot is too tall)
const sheet = await browser.newPage({ viewport: { width: 800, height: 600 } });
const thumbs = sorted.map((r) => ({ label: `${r.score === null ? "fail" : r.score.toFixed(2)}  ${r.game} / ${r.shot}`, src: existsSync(r.pair) ? `data:image/png;base64,${readFileSync(r.pair).toString("base64")}` : "" }));
const contact = await sheet.evaluate(`(async (thumbs) => {
  const cols = 3, tw = 600, th = 190, lh = 22;
  const c = document.createElement("canvas"); c.width = cols * tw; c.height = Math.ceil(thumbs.length / cols) * (th + lh);
  const x = c.getContext("2d"); x.fillStyle = "#1b1b22"; x.fillRect(0, 0, c.width, c.height);
  x.font = "15px sans-serif"; x.fillStyle = "#ffcd75";
  for (let i = 0; i < thumbs.length; i++) {
    const px = (i % cols) * tw, py = Math.floor(i / cols) * (th + lh);
    x.fillText(thumbs[i].label, px + 6, py + 16);
    if (!thumbs[i].src) continue;
    const img = await new Promise((ok) => { const m = new Image(); m.onload = () => ok(m); m.onerror = () => ok(null); m.src = thumbs[i].src; });
    if (!img) continue;
    const k = Math.min((tw - 8) / img.width, th / img.height);
    x.drawImage(img, px + 4, py + lh, img.width * k, img.height * k);
  }
  return c.toDataURL("image/png");
})(${JSON.stringify(thumbs)})`) as string;
writeFileSync(join(outDir, "contact.png"), Buffer.from(contact.split(",")[1]!, "base64"));
await sheet.close();
await browser.close();
const scores = merged.map((r) => r.score).filter((s): s is number => s !== null);
console.log(`\n${merged.length} shots, mean score ${(scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length)).toFixed(2)} -> ${join(outDir, "index.html")}, ${join(outDir, "contact.png")}`);
