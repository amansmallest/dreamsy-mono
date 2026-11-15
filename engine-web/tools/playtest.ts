/**
 * Playtesting for the harness: run a package with a scripted input timeline.
 *  - simulate(): Node, core only (no renderer). Fast; catches load + runtime script errors.
 *  - playtestBrowser(): headless Chromium with the real renderer; returns screenshots at chosen times.
 * Both take the same timeline so Claude can describe "hold right, jump at 1s, tap the Raid button at 3s".
 * Timeline times are GAME time in both (the browser page is stepped tick by tick), so taps and shots are reproducible.
 * Both can start mid-game: `scene` + `sceneParams`, preloaded `save` data and a `clock` base.
 */
import type { Package } from "@dreamsy/format";
import { chromium, type Browser } from "playwright";
import { parseManifest } from "@dreamsy/format";
import { Game, GameLoadError, PLAYTEST_EPOCH, MemorySaveHost, MemoryStoreHost, type AudioEvent, type SaveHost } from "../core/index.js";
import { bootPage, defaultViewport, ensureBuilt, refToViewport, serve, stepTo, type BootOptions } from "./screenshot.js";

export type Control = "left" | "right" | "up" | "down" | "jump" | "action" | "action2";

export interface TimelineStep {
  /** Seconds since start. */
  t: number;
  hold?: Control[];
  release?: Control[];
  /** Press and release (~0.1s). */
  press?: Control[];
  /** Tap at reference (UI) coordinates: 720×1280 portrait / 1280×720 landscape. simulate() advances dialogs,
   *  presses UIButtons/UIPanels or taps the world; the browser clicks the real page. */
  tap?: [number, number];
  /** Drag/flick from → to (reference px) over `seconds` (default 0.15): fires input.pointerDown, pointerUp and input.swipe. */
  swipe?: { from: [number, number]; to: [number, number]; seconds?: number };
}

export interface PlaytestReport {
  loadError?: string;
  errors: { script: string; line?: number; message: string; count: number }[];
  logs: string[];
  toasts: string[];
  entities: number;
  /** Sounds the game played: sfx id → count, and music ids in play order. */
  audio: AudioSummary;
  /** Avatar (first `player`-tagged entity) position samples, once per second. */
  avatarTrace: { t: number; x: number; y: number }[];
  /** Dialog open at the end (ui.dialog / ui.choice): current line, speaker, options. */
  dialog?: { text: string; speaker?: string; options?: string[] };
  /** Lines shown by ui.dialog / ui.choice during the run, in order (speaker: text). */
  dialogLog?: string[];
  /** Save data at the end (save.set). */
  save?: Record<string, unknown>;
}

export interface AudioSummary { sfx: Record<string, number>; music: string[] }

export function summarizeAudio(log: readonly AudioEvent[]): AudioSummary {
  const out: AudioSummary = { sfx: {}, music: [] };
  for (const e of log) {
    if (e.kind === "sfx") out.sfx[e.id] = (out.sfx[e.id] ?? 0) + 1;
    else if (e.kind === "music") out.music.push(e.id);
  }
  return out;
}

const AXIS: Record<string, [string, number]> = { left: ["move_x", -1], right: ["move_x", 1], up: ["move_y", -1], down: ["move_y", 1] };
const KEY: Record<Control, string> = { left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", jump: "Space", action: "KeyE", action2: "KeyQ" };

export interface SimulateOptions {
  /** A SaveHost (shared across runs = relaunch), or plain preloaded save data. */
  save?: SaveHost | Record<string, unknown>;
  /** Start mid-game: scene path (instead of entry_scene) and its sceneParams(). */
  scene?: string;
  sceneParams?: Record<string, unknown>;
  /** clock.now() base in unix seconds (default PLAYTEST_EPOCH); game time is added. */
  clock?: number;
  /** Auto-advance ui.dialog lines and answer ui.choice: "first" | "last" | 1-based option index. */
  autoDialog?: "first" | "last" | number;
  /** Per-call Luau CPU budget in ms (default 250). Raise it for long kit simulations (battle balance, economy curves). */
  budgetMs?: number;
  seed?: number;
}

export async function simulate(pkg: Package, timeline: TimelineStep[], seconds: number, opts: SimulateOptions = {}): Promise<PlaytestReport> {
  let game: Game;
  try {
    // in-memory store: every item is purchasable for free, deterministic purchase ids
    const save = opts.save && typeof (opts.save as SaveHost).load === "function" ? opts.save as SaveHost : new MemorySaveHost((opts.save as Record<string, unknown> | undefined) ?? {});
    game = await Game.load(pkg, { seed: opts.seed ?? 1, budgetMs: opts.budgetMs, scene: opts.scene, sceneParams: opts.sceneParams, clock: () => (opts.clock ?? PLAYTEST_EPOCH) + ((game as Game | undefined)?.time ?? 0), save, store: new MemoryStoreHost(parseManifest(pkg.text("dreamsy.toml") ?? "").manifest?.store ?? []) });
  } catch (e) {
    return { loadError: e instanceof GameLoadError ? e.message : String(e), errors: [], logs: [], toasts: [], entities: 0, avatarTrace: [], audio: { sfx: {}, music: [] } };
  }
  const held = new Set<Control>();
  const pendingRelease: { at: number; c: Control }[] = [];
  const pendingSwipes: { at: number; from: [number, number]; to: [number, number]; t0: number }[] = [];
  const steps = [...timeline].sort((a, b) => a.t - b.t);
  const applyHeld = () => {
    let mx = 0, my = 0;
    for (const c of held) {
      const ax = AXIS[c];
      if (ax) { if (ax[0] === "move_x") mx += ax[1]; else my += ax[1]; }
      else game.input.setButton(c, true);
    }
    game.input.setAxis("move_x", mx);
    game.input.setAxis("move_y", my);
    for (const b of ["jump", "action", "action2"] as const) if (!held.has(b)) game.input.setButton(b, false);
  };

  const trace: PlaytestReport["avatarTrace"] = [];
  const dialogLog: string[] = [];
  let lastDialog = "";
  const ticks = Math.round(seconds * 60);
  let si = 0;
  for (let i = 0; i <= ticks; i++) {
    const t = i / 60;
    while (si < steps.length && steps[si]!.t <= t) {
      const s = steps[si++]!;
      for (const c of s.hold ?? []) held.add(c);
      for (const c of s.release ?? []) held.delete(c);
      for (const c of s.press ?? []) { held.add(c); pendingRelease.push({ at: t + 0.1, c }); }
      applyHeld();
      if (s.tap) game.tapScreen(s.tap[0], s.tap[1]);
      if (s.swipe) {
        game.pointerDown(s.swipe.from[0], s.swipe.from[1]);
        pendingSwipes.push({ at: t + Math.max(0, s.swipe.seconds ?? 0.15), from: s.swipe.from, to: s.swipe.to, t0: t });
      }
    }
    for (let k = pendingSwipes.length - 1; k >= 0; k--) {
      const sw = pendingSwipes[k]!;
      const f = sw.at > sw.t0 ? Math.min(1, (t - sw.t0) / (sw.at - sw.t0)) : 1;
      if (sw.at <= t) { game.pointerUp(sw.to[0], sw.to[1]); pendingSwipes.splice(k, 1); }
      else game.pointerMove(sw.from[0] + (sw.to[0] - sw.from[0]) * f, sw.from[1] + (sw.to[1] - sw.from[1]) * f);
    }
    for (let k = pendingRelease.length - 1; k >= 0; k--) {
      if (pendingRelease[k]!.at <= t) { held.delete(pendingRelease[k]!.c); pendingRelease.splice(k, 1); applyHeld(); }
    }
    if (i % 60 === 0) {
      const a = game.avatar();
      const p = a?.get("position") as number[] | undefined;
      if (p) trace.push({ t: Math.round(t), x: Math.round(p[0]!), y: Math.round(p[1]!) });
    }
    while (game.storeBusy || game.leaderboardBusy) await new Promise((r) => setTimeout(r, 0)); // let store.prompt() / leaderboard submits resolve
    const d = game.dialogs.current;
    if (d) {
      const key = `${d.id}:${d.index}`;
      if (key !== lastDialog) { lastDialog = key; const l = d.lines[d.index]!; dialogLog.push(`${l.speaker ? `${l.speaker}: ` : ""}${l.text}${d.kind === "choice" && d.index === d.lines.length - 1 ? ` [${d.options.join(" | ")}]` : ""}`); }
      if (opts.autoDialog !== undefined && i % 6 === 3) {
        const lineDone = d.shown >= d.lines[d.index]!.text.length;
        if (d.kind === "choice" && d.index === d.lines.length - 1 && lineDone) {
          const a = opts.autoDialog;
          const idx = a === "first" ? 0 : a === "last" ? d.options.length - 1 : Math.max(0, Math.min(d.options.length - 1, Math.floor(a) - 1));
          game.dialogTap(idx);
        } else game.dialogTap(-1);
      }
    }
    if (i < ticks) game.step();
  }
  const dlg = game.dialogs.current;
  return {
    errors: game.errors.map((e) => ({ script: e.script, line: e.line, message: e.message, count: e.count })),
    logs: game.logs.slice(-30).map((l) => `[${l.level}] ${l.text}`),
    toasts: game.toasts.map((t) => t.text),
    entities: game.world.count,
    audio: { sfx: { ...game.audioStats.sfx }, music: [...game.audioStats.music] },
    avatarTrace: trace,
    dialog: dlg ? { text: dlg.lines[dlg.index]!.text, speaker: dlg.lines[dlg.index]!.speaker, options: dlg.kind === "choice" ? dlg.options : undefined } : undefined,
    dialogLog: dialogLog.slice(-50),
    save: structuredClone(game.save) as Record<string, unknown>,
  };
}

export interface BrowserPlaytest extends Omit<PlaytestReport, "avatarTrace"> {
  shots: { t: number; jpeg: Uint8Array }[];
  consoleErrors: string[];
}

let sharedBrowser: Promise<Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let inUse = 0;
/** Idle seconds before the shared browser closes itself (so scripts exit without calling closeBrowser). */
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

/** Real renderer in headless Chromium; screenshots (JPEG) at the requested times. */
export async function playtestBrowser(pkg: Package, timeline: TimelineStep[], shotTimes: number[], opts: { width?: number; height?: number } & BootOptions = {}): Promise<BrowserPlaytest> {
  ensureBuilt();
  const { server, url } = await serve(pkg.toZip());
  const ref = defaultViewport(pkg);
  const width = opts.width ?? ref[0], height = opts.height ?? ref[1];
  inUse++;
  let page;
  try { page = await (await browser()).newPage({ viewport: { width, height } }); } catch (e) { release(); throw e; }
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  try {
    const loadError = await bootPage(page, url, opts, "touch=0");
    const shots: BrowserPlaytest["shots"] = [];
    if (!loadError) {
      type Ev = { t: number; run: () => Promise<unknown> };
      const events: Ev[] = [];
      for (const s of timeline) {
        for (const c of s.hold ?? []) events.push({ t: s.t, run: () => page.keyboard.down(KEY[c]) });
        for (const c of s.release ?? []) events.push({ t: s.t, run: () => page.keyboard.up(KEY[c]) });
        for (const c of s.press ?? []) {
          events.push({ t: s.t, run: () => page.keyboard.down(KEY[c]) });
          events.push({ t: s.t + 0.1, run: () => page.keyboard.up(KEY[c]) });
        }
        if (s.tap) { const [x, y] = refToViewport(ref, width, height, s.tap[0], s.tap[1]); events.push({ t: s.t, run: () => page.mouse.click(x, y) }); }
        if (s.swipe) {
          const sw = s.swipe, dur = Math.max(0, sw.seconds ?? 0.15);
          const [fx, fy] = refToViewport(ref, width, height, sw.from[0], sw.from[1]), [tx, ty] = refToViewport(ref, width, height, sw.to[0], sw.to[1]);
          events.push({ t: s.t, run: async () => { await page.mouse.move(fx, fy); await page.mouse.down(); } });
          for (let k = 1; k <= 3; k++) events.push({ t: s.t + (dur * k) / 4, run: () => page.mouse.move(fx + ((tx - fx) * k) / 4, fy + ((ty - fy) * k) / 4) });
          events.push({ t: s.t + dur, run: async () => { await page.mouse.move(tx, ty); await page.mouse.up(); } });
        }
      }
      for (const t of shotTimes) events.push({ t, run: async () => shots.push({ t, jpeg: new Uint8Array(await page.screenshot({ type: "jpeg", quality: 70 })) }) });
      events.sort((a, b) => a.t - b.t); // stable: same-time events keep timeline order
      for (const e of events) {
        await stepTo(page, e.t); // game time, deterministic
        await e.run();
      }
    }
    const info = await page.evaluate(() => {
      const g = (window as any).__dreamsy?.game;
      return {
        errors: g ? g.errors.map((e: any) => ({ script: e.script, line: e.line, message: e.message, count: e.count })) : [],
        logs: g ? g.logs.slice(-30).map((l: any) => `[${l.level}] ${l.text}`) : [],
        toasts: g ? g.toasts.map((t: any) => t.text) : [],
        entities: g?.world.count ?? 0,
        audio: g ? { sfx: { ...g.audioStats.sfx }, music: [...g.audioStats.music] } : { sfx: {}, music: [] },
      };
    });
    return { loadError, consoleErrors, shots, ...info };
  } finally {
    await page.close();
    server.close();
    release();
  }
}
