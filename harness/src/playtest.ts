/**
 * Playtests on the C++ engine (DREAMSY.MD §5.1, §14.8):
 *  - simulate(): headless, `dreamsy-tool playtest` (engine/apps/tool/playtest.cpp). Fast; catches load and
 *    runtime script errors, traces the avatar, logs dialogs, sounds, save data and scene changes.
 *  - browser (./browser.ts): the C++ web player in headless Chromium, stepped tick by tick; screenshots.
 * Both take the same timeline in GAME time, so "hold right, jump at 1s, tap the Raid button at 3s" is reproducible.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Package } from "@dreamsy/format";

export type Control = "left" | "right" | "up" | "down" | "jump" | "action" | "action2";

export interface TimelineStep {
  /** Seconds since start (game time). */
  t: number;
  hold?: Control[];
  release?: Control[];
  /** Press and release (~0.1s). */
  press?: Control[];
  /** Tap at reference (UI) coordinates: 720×1280 portrait / 1280×720 landscape. Headless: advances dialogs,
   *  presses UIButtons/UIPanels or taps the world (Host::tap_screen); the browser clicks the real page. */
  tap?: [number, number];
  /** Drag/flick from → to (reference px) over `seconds` (default 0.15): input.pointerDown, pointerUp and input.swipe. */
  swipe?: { from: [number, number]; to: [number, number]; seconds?: number };
}

export interface AudioSummary { sfx: Record<string, number>; music: string[] }

/** `dreamsy-tool playtest` output, what the builder model reads back. */
export interface PlaytestReport {
  loadError?: string;
  errors: { script: string; line?: number; message: string; count: number }[];
  /** Last 30 log lines, "[level] text". */
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
  /** Scene at the end, and every scene the run was in with the game time it was entered. */
  scene?: string;
  scenes?: { t: number; scene: string }[];
  /** Controls the scripts read during the run (move_x, jump, ...), and what a scan of the scripts finds. */
  controls?: { read: string[]; scripts: { move: boolean; look: boolean; buttons: string[] } };
  time?: number;
}

/** Real renderer (the C++ web player) + screenshots. */
export interface BrowserPlaytest {
  loadError?: string;
  shots: { t: number; jpeg: Uint8Array }[];
  /** Engine errors on the page console (not game script errors; those are in the headless report). */
  consoleErrors: string[];
  /** Distinct script errors the player saw. */
  scriptErrors: number;
}

/** Start mid-game: a scene other than the entry scene, its params, and preloaded save data. */
export interface StartAt { scene?: string; sceneParams?: Record<string, unknown>; save?: Record<string, unknown> }

/** Seam over the engine's playtest tools (tests may inject a fake browser; no Chromium in unit tests). */
export interface Playtester {
  simulate(pkg: Package, timeline: TimelineStep[], seconds: number, start?: StartAt): Promise<PlaytestReport>;
  /** Real renderer + screenshots. Absent when no browser is available. */
  browser?(pkg: Package, timeline: TimelineStep[], shotTimes: number[], start?: StartAt): Promise<BrowserPlaytest>;
  close?(): Promise<void>;
}

/** Generic "play it a bit" input used by the final gate: run right, jump, use action. */
export const SMOKE_TIMELINE: TimelineStep[] = [
  { t: 0.5, hold: ["right"] },
  { t: 1, press: ["jump"] },
  { t: 2, press: ["action"] },
  { t: 2.5, press: ["jump"] },
  { t: 3.5, release: ["right"], hold: ["left"] },
  { t: 4.5, press: ["jump"] },
  { t: 5.5, release: ["left"], hold: ["up"] },
  { t: 6.5, release: ["up"], hold: ["down"] },
  { t: 7.5, release: ["down"] },
];

/** clock.now() at game time 0 in tool runs (2026-01-01 UTC); the engine's tools use the same. */
export const PLAYTEST_EPOCH = 1767225600;

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The headless engine: $DREAMSY_TOOL, else engine/build/{release,headless,debug}/dreamsy-tool. */
export function dreamsyTool(): string {
  const env = process.env.DREAMSY_TOOL;
  if (env) return env;
  for (const preset of ["release", "headless", "debug"]) {
    const p = join(REPO_ROOT, "engine/build", preset, "dreamsy-tool");
    if (existsSync(p)) return p;
  }
  throw new Error("dreamsy-tool not found: build it (cd engine && cmake --preset release && cmake --build --preset release --target dreamsy-tool) or set DREAMSY_TOOL");
}

/** Runs dreamsy-tool with `args`, `stdin` piped in; resolves with stdout (any exit code), rejects on a crash or timeout. */
export function runTool(args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(dreamsyTool(), args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    const ms = opts.timeoutMs ?? 120_000;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`dreamsy-tool ${args[0]} timed out after ${ms} ms`)); }, ms);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8"), stderr = Buffer.concat(err).toString("utf8");
      if (signal) reject(new Error(`dreamsy-tool ${args[0]} crashed (${signal}): ${stderr.slice(-500)}`));
      else resolve({ stdout, stderr, code });
    });
    child.stdin.on("error", () => { /* the tool may exit before reading stdin */ });
    child.stdin.end(opts.stdin ?? "");
  });
}

/** Writes `pkg` as a Dreamsy pack in a fresh temp dir; call cleanup() when done. */
export function tempPack(pkg: Package): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dreamsy-pt-"));
  const path = join(dir, "game.dpk");
  writeFileSync(path, pkg.toPack());
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface SimulateOptions extends StartAt {
  /** clock.now() base in unix seconds (default PLAYTEST_EPOCH); game time is added. */
  clock?: number;
  /** Auto-advance ui.dialog lines and answer ui.choice: "first" | "last" | 1-based option index. */
  autoDialog?: "first" | "last" | number;
  /** Per-call Luau CPU budget in ms (default 250). */
  budgetMs?: number;
  seed?: number;
}

const emptyReport = (loadError: string): PlaytestReport => ({ loadError, errors: [], logs: [], toasts: [], entities: 0, avatarTrace: [], audio: { sfx: {}, music: [] } });

/** Headless playtest on the C++ engine (`dreamsy-tool playtest`). */
export async function simulate(pkg: Package, timeline: TimelineStep[], seconds: number, opts: SimulateOptions = {}): Promise<PlaytestReport> {
  let pack: { path: string; cleanup: () => void };
  try {
    pack = tempPack(pkg);
  } catch (e) {
    return emptyReport(`cannot pack the game: ${(e as Error).message}`);
  }
  try {
    const secs = Math.max(0, Math.min(3600, seconds));
    const args = ["playtest", pack.path, "--timeline", "-", "--seconds", String(secs)];
    if (opts.scene) args.push("--scene", opts.scene);
    if (opts.sceneParams) args.push("--params", JSON.stringify(opts.sceneParams));
    if (opts.save) args.push("--save", JSON.stringify(opts.save));
    if (opts.clock !== undefined) args.push("--clock", String(opts.clock));
    if (opts.autoDialog !== undefined) args.push("--auto-dialog", String(opts.autoDialog));
    if (opts.budgetMs !== undefined) args.push("--budget", String(opts.budgetMs));
    if (opts.seed !== undefined) args.push("--seed", String(opts.seed));
    const { stdout, stderr } = await runTool(args, { stdin: JSON.stringify(timeline), timeoutMs: 60_000 + secs * 5_000 });
    try {
      return JSON.parse(stdout) as PlaytestReport;
    } catch {
      throw new Error(`dreamsy-tool playtest: ${(stderr || stdout).trim().slice(0, 500)}`);
    }
  } finally {
    pack.cleanup();
  }
}

export async function enginePlaytester(opts: { browser: boolean }): Promise<Playtester> {
  dreamsyTool(); // fail at startup, not at the first playtest
  const browser = opts.browser ? await import("./browser.js") : null;
  return {
    simulate: (p, tl, secs, start) => simulate(p, tl, secs, { autoDialog: "first", ...start }),
    ...(browser ? { browser: (p: Package, tl: TimelineStep[], shots: number[], start?: StartAt) => browser.playtestBrowser(p, tl, shots, start) } : {}),
    close: async () => { await browser?.closeBrowser(); },
  };
}

/** Text summary of a headless run for the model. */
export function describeRun(r: PlaytestReport): string {
  const lines: string[] = [];
  if (r.loadError) lines.push(`LOAD FAILED: ${r.loadError}`);
  if (r.errors.length) {
    lines.push(`${r.errors.length} script error(s):`);
    for (const e of r.errors.slice(0, 15)) lines.push(`- ${e.script}${e.line ? `:${e.line}` : ""} ${e.message}${e.count > 1 ? ` (×${e.count})` : ""}`);
  } else if (!r.loadError) lines.push("No script errors.");
  if (r.scenes && r.scenes.length > 1) lines.push(`Scenes: ${r.scenes.map((s) => `${s.scene} (${Math.round(s.t * 10) / 10}s)`).join(" → ")}`);
  lines.push(`Entities alive at end: ${r.entities}`);
  if (r.avatarTrace.length) lines.push(`Player position per second: ${r.avatarTrace.map((p) => `${p.t}s(${p.x},${p.y})`).join(" ")}`);
  if (r.controls) lines.push(`Controls the game read: ${r.controls.read.join(", ") || "none"}`);
  const sfx = Object.entries(r.audio.sfx).map(([id, n]) => `${id}×${n}`).join(", ");
  lines.push(`Sound: ${sfx || "no sfx played"}; music: ${r.audio.music.join(" → ") || "none"}`);
  if (r.dialogLog?.length) lines.push(`Dialog shown:\n${r.dialogLog.slice(-10).join("\n")}`);
  if (r.dialog) lines.push(`Dialog open at the end: ${r.dialog.speaker ? `${r.dialog.speaker}: ` : ""}${r.dialog.text}${r.dialog.options ? ` [${r.dialog.options.join(" | ")}]` : ""}`);
  if (r.toasts.length) lines.push(`Toasts on screen: ${r.toasts.join(" | ")}`);
  if (r.save && Object.keys(r.save).length) lines.push(`Save data at the end: ${JSON.stringify(r.save).slice(0, 600)}`);
  if (r.logs.length) lines.push(`Last logs:\n${r.logs.slice(-15).join("\n")}`);
  return lines.join("\n");
}
