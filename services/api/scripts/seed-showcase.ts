/**
 * Publish every package in games/showcase/ (and games/examples/) as a game owned by a
 * "dreamsy" guest account, using only public + worker endpoints. Re-running creates new games.
 *
 *   API_URL=http://localhost:8787 WORKER_TOKEN=... pnpm tsx scripts/seed-showcase.ts
 */

import "../src/env.js";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Package, validatePackage } from "@dreamsy/format";

const API = process.env.API_URL ?? "http://localhost:8787";
const WORKER_TOKEN = process.env.WORKER_TOKEN;
if (!WORKER_TOKEN) throw new Error("WORKER_TOKEN is required");

async function call(method: string, path: string, token: string, body?: unknown | FormData) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const root = fileURLToPath(new URL("../../../games/", import.meta.url));
const dirs: string[] = [];
for (const group of ["showcase", "examples"]) {
  for (const d of await readdir(join(root, group), { withFileTypes: true }).catch(() => [])) {
    if (d.isDirectory()) dirs.push(join(root, group, d.name));
  }
}

// Covers for the feed: screenshot each game ~2.5s in with the real engine (best-effort).
let shoot: ((pkg: Package) => Promise<Uint8Array | undefined>) | null = null;
try {
  // Untyped dynamic import keeps the engine out of the API's TypeScript program.
  const enginePlaytest = new URL("../../../engine-web/tools/playtest.ts", import.meta.url).href;
  const pt = (await import(enginePlaytest)) as {
    playtestBrowser(p: Package, tl: unknown[], shots: number[]): Promise<{ shots: { jpeg: Uint8Array }[] }>;
    closeBrowser(): Promise<void>;
  };
  shoot = async (pkg) => (await pt.playtestBrowser(pkg, [], [2.5])).shots[0]?.jpeg;
  process.on("exit", () => void pt.closeBrowser());
} catch (e) {
  console.log(`(no thumbnails: ${(e as Error).message})`);
}

const { token } = await call("POST", "/v1/auth/guest", "");
for (const dir of dirs) {
  const pkg = await Package.fromDir(dir);
  const v = validatePackage(pkg);
  if (!v.ok || !v.manifest) { console.log(`skip ${dir}: invalid`); continue; }
  if (v.manifest.dimension !== "2d") { console.log(`skip ${dir}: 3D isn't supported by the engine yet`); continue; }

  const { game } = await call("POST", "/v1/games", token, { name: v.manifest.name, description: v.manifest.description ?? "" });
  const { generation } = await call("POST", `/v1/games/${game.id}/generations`, token, { prompt: `Seeded from ${dir.split("/games/")[1]}` });
  const workerId = "seed-script";
  const claim = await call("POST", "/v1/worker/claim", WORKER_TOKEN, { workerId });
  if (!claim || claim.generation.id !== generation.id) throw new Error("another job was claimed first; stop workers while seeding");

  const form = new FormData();
  form.set("workerId", workerId);
  form.set("summary", "Showcase game");
  form.set("package", new File([pkg.toZip() as Uint8Array<ArrayBuffer>], "game.zip", { type: "application/zip" }));
  const thumb = shoot ? await shoot(pkg).catch(() => undefined) : undefined;
  if (thumb) form.set("thumbnail", new File([thumb as Uint8Array<ArrayBuffer>], "thumb.jpg", { type: "image/jpeg" }));
  await call("POST", `/v1/worker/generations/${generation.id}/complete`, WORKER_TOKEN, form);
  await call("POST", `/v1/games/${game.id}/publish`, token, {});
  console.log(`published ${v.manifest.name} → ${game.id}${thumb ? " (with cover)" : ""}`);
}
process.exit(0);
