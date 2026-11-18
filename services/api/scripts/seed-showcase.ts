/**
 * Publish every package in games/showcase/ (and games/examples/) as a game owned by a
 * "dreamsy" guest account, using only public + worker endpoints. Re-running creates new games.
 *
 *   API_URL=http://localhost:8787 WORKER_TOKEN=... pnpm tsx scripts/seed-showcase.ts
 */

import "../src/env.js";
import "../src/package.js";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { extname, join } from "node:path";
import { Package, referenceSize, validatePackage } from "@dreamsy/format";

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

// Covers for the feed: a screenshot ~2.5 s in from the C++ web player (engine/build/web, which scripts/dev.sh builds),
// in headless Chromium with no server (Playwright answers the requests). Best-effort: no build or no Playwright = no covers.
type Page = {
  route(url: string, fn: (route: { request(): { url(): string }; fulfill(r: { status: number; body: Buffer | string; contentType?: string }): Promise<void> }) => unknown): Promise<void>;
  goto(url: string): Promise<unknown>;
  waitForFunction(fn: () => unknown, arg?: unknown, opts?: { timeout: number }): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts: { type: "jpeg"; quality: number }): Promise<Buffer>;
  close(): Promise<void>;
};
type Browser = { newPage(opts: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };
let shoot: ((pkg: Package, size: [number, number]) => Promise<Uint8Array | undefined>) | null = null;
let browser: Browser | null = null;
try {
  const player = fileURLToPath(new URL("../../../engine/build/web/", import.meta.url));
  if (!existsSync(join(player, "dreamsy-player.html"))) throw new Error("engine/build/web isn't built (scripts/dev.sh builds it)");
  // Playwright is a harness dependency; resolve it from there (untyped, like a dynamic import).
  const req = createRequire(new URL("../../../harness/package.json", import.meta.url));
  const { chromium } = req("playwright") as { chromium: { launch(o: { args: string[] }): Promise<Browser> } };
  const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  browser = b;
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
  shoot = async (pkg, [w, h]) => {
    const page = await b.newPage({ viewport: { width: w, height: h } });
    try {
      const zip = Buffer.from(pkg.toZip());
      await page.route("http://player.test/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/game.zip") return route.fulfill({ status: 200, body: zip, contentType: "application/zip" });
        const file = join(player, path);
        if (!file.startsWith(player) || !existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
        return route.fulfill({ status: 200, body: readFileSync(file), contentType: types[extname(file)] ?? "application/octet-stream" });
      });
      // manual=1: the page steps game time itself (__dreamsy.step), so the shot doesn't depend on the machine's speed
      await page.goto("http://player.test/dreamsy-player.html?pkg=http://player.test/game.zip&manual=1");
      await page.waitForFunction(() => {
        const d = (window as unknown as { __dreamsy?: { ready?: boolean; error?: string } }).__dreamsy;
        return d?.ready || d?.error;
      }, undefined, { timeout: 30_000 });
      const ok = await page.evaluate(() => {
        const d = (window as unknown as { __dreamsy: { ready?: boolean; step(n: number): number } }).__dreamsy;
        if (!d.ready) return false;
        d.step(150);
        return true;
      });
      if (!ok) return undefined;
      await page.waitForTimeout(200); // the next frames draw the stepped game
      return new Uint8Array(await page.screenshot({ type: "jpeg", quality: 70 }));
    } finally {
      await page.close();
    }
  };
} catch (e) {
  console.log(`(no thumbnails: ${(e as Error).message})`);
}

const { token } = await call("POST", "/v1/auth/guest", "");
for (const dir of dirs) {
  const pkg = await Package.fromDir(dir);
  const v = validatePackage(pkg);
  if (!v.ok || !v.manifest) { console.log(`skip ${dir}: invalid`); continue; }
  if (v.manifest.dimension !== "2d") { console.log(`skip ${dir}: the engine is 2D/2.5D only`); continue; }

  const { game } = await call("POST", "/v1/games", token, { name: v.manifest.name, description: v.manifest.description ?? "" });
  const { generation } = await call("POST", `/v1/games/${game.id}/generations`, token, { prompt: `Seeded from ${dir.split("/games/")[1]}` });
  const workerId = "seed-script";
  const claim = await call("POST", "/v1/worker/claim", WORKER_TOKEN, { workerId });
  if (!claim || claim.generation.id !== generation.id) throw new Error("another job was claimed first; stop workers while seeding");

  const form = new FormData();
  form.set("workerId", workerId);
  form.set("summary", "Showcase game");
  form.set("package", new File([pkg.toZip() as Uint8Array<ArrayBuffer>], "game.zip", { type: "application/zip" }));
  const thumb = shoot ? await shoot(pkg, referenceSize(v.manifest)).catch(() => undefined) : undefined;
  if (thumb) form.set("thumbnail", new File([thumb as Uint8Array<ArrayBuffer>], "thumb.jpg", { type: "image/jpeg" }));
  await call("POST", `/v1/worker/generations/${generation.id}/complete`, WORKER_TOKEN, form);
  await call("POST", `/v1/games/${game.id}/publish`, token, {});
  console.log(`published ${v.manifest.name} → ${game.id}${thumb ? " (with cover)" : ""}`);
}
await browser?.close();
process.exit(0);
