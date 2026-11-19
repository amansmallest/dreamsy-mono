import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dataDir, gameDir, HARNESS_DIR, PLAYER_DIR } from "./paths";

const g = globalThis as unknown as { __dreamsyBanners?: { queue: string[]; busy: boolean; failed: Set<string> } };
const state = (g.__dreamsyBanners ??= { queue: [], busy: false, failed: new Set() });

export const bannerPath = (id: string) => join(dataDir(id), "thumb.jpg");

function shoot(id: string): Promise<void> {
  return new Promise((resolve) => {
    void mkdir(dataDir(id), { recursive: true }).then(() => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli/shot.ts", gameDir(id), bannerPath(id)], {
        cwd: HARNESS_DIR,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production" } as NodeJS.ProcessEnv,
        stdio: "ignore",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) state.failed.add(id);
        resolve();
      });
    });
  });
}

async function pump() {
  if (state.busy) return;
  state.busy = true;
  try {
    while (state.queue.length) {
      const id = state.queue.shift()!;
      if (!existsSync(bannerPath(id))) await shoot(id);
    }
  } finally {
    state.busy = false;
  }
}

export function requestBanner(id: string) {
  if (!existsSync(join(PLAYER_DIR, "dreamsy-player.wasm"))) return false;
  if (existsSync(bannerPath(id)) || state.failed.has(id) || state.queue.includes(id)) return false;
  state.queue.push(id);
  void pump();
  return true;
}

export const bannersPending = () => state.queue.length > 0 || state.busy;

export function refreshBanner(id: string) {
  state.failed.delete(id);
  return requestBanner(id);
}
