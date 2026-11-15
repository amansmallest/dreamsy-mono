import type { Package } from "@dreamsy/format";
import type { BrowserPlaytest, PlaytestReport, TimelineStep } from "@dreamsy/engine/playtest";

export type { BrowserPlaytest, PlaytestReport, TimelineStep };

/** Seam over engine-web's playtest tools (tests inject a fake; no Chromium in unit tests). */
/** Start mid-game: a scene other than the entry scene, its params, and preloaded save data. */
export interface StartAt { scene?: string; sceneParams?: Record<string, unknown>; save?: Record<string, unknown> }

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

export async function enginePlaytester(opts: { browser: boolean }): Promise<Playtester> {
  const mod = await import("@dreamsy/engine/playtest");
  return {
    simulate: (p, tl, secs, start) => mod.simulate(p, tl, secs, { autoDialog: "first", ...start }),
    ...(opts.browser ? { browser: (p, tl, shots, start) => mod.playtestBrowser(p, tl, shots, { ...start }) } : {}),
    close: mod.closeBrowser,
  };
}

/** Text summary of a run for the model. */
export function describeRun(r: PlaytestReport | BrowserPlaytest): string {
  const lines: string[] = [];
  if (r.loadError) lines.push(`LOAD FAILED: ${r.loadError}`);
  if (r.errors.length) {
    lines.push(`${r.errors.length} script error(s):`);
    for (const e of r.errors.slice(0, 15)) lines.push(`- ${e.script}${e.line ? `:${e.line}` : ""} ${e.message}${e.count > 1 ? ` (×${e.count})` : ""}`);
  } else if (!r.loadError) lines.push("No script errors.");
  if ("consoleErrors" in r && r.consoleErrors.length) lines.push(`Engine console errors: ${r.consoleErrors.slice(0, 5).join(" | ")}`);
  lines.push(`Entities alive at end: ${r.entities}`);
  if ("avatarTrace" in r && r.avatarTrace.length) lines.push(`Player position per second: ${r.avatarTrace.map((p) => `${p.t}s(${p.x},${p.y})`).join(" ")}`);
  const audio = (r as { audio?: { sfx: Record<string, number>; music: string[] } }).audio;
  if (audio) {
    const sfx = Object.entries(audio.sfx).map(([id, n]) => `${id}×${n}`).join(", ");
    lines.push(`Sound: ${sfx || "no sfx played"}; music: ${audio.music.join(" → ") || "none"}`);
  }
  if (r.toasts.length) lines.push(`Toasts on screen: ${r.toasts.join(" | ")}`);
  if (r.logs.length) lines.push(`Last logs:\n${r.logs.slice(-15).join("\n")}`);
  return lines.join("\n");
}
