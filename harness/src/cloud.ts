import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CLOUD_URL = "https://dreamsy-cloud.tofu-develops.workers.dev";

export interface CloudConfig {
  url: string;
  saveKey: string;
}

export interface CloudSave {
  gameId: string;
  version: number;
}

export interface Publication {
  slug: string;
  version: number;
}

export const dreamsyHome = () => process.env.DREAMSY_HOME ?? join(homedir(), ".dreamsy");

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writePrivate(path: string, value: unknown) {
  mkdirSync(dreamsyHome(), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The save key shared by the editor, the MCP server and the CLI on this computer (~/.dreamsy/config.json). */
export function localSaveKey(): string {
  const path = join(dreamsyHome(), "config.json");
  const cfg = readJson<{ saveKey?: string }>(path, {});
  if (cfg.saveKey && /^[A-Za-z0-9_-]{32,128}$/.test(cfg.saveKey)) return cfg.saveKey;
  const saveKey = randomBytes(32).toString("base64url");
  writePrivate(path, { ...cfg, saveKey });
  return saveKey;
}

/** Cloud settings for this computer; null when DREAMSY_CLOUD=0. */
export function localCloud(env: NodeJS.ProcessEnv = process.env): CloudConfig | null {
  if (env.DREAMSY_CLOUD === "0") return null;
  return { url: (env.DREAMSY_CLOUD_URL?.trim() || DEFAULT_CLOUD_URL).replace(/\/$/, ""), saveKey: env.DREAMSY_SAVE_KEY?.trim() || localSaveKey() };
}

/** For child processes that get the settings passed in explicitly (the editor's builds). */
export function cloudFromEnv(env: NodeJS.ProcessEnv = process.env): CloudConfig | null {
  const url = env.DREAMSY_CLOUD_URL?.trim().replace(/\/$/, "");
  const saveKey = env.DREAMSY_SAVE_KEY?.trim();
  return url && saveKey ? { url, saveKey } : null;
}

const linksPath = () => join(dreamsyHome(), "games.json");
/** Which cloud game a local game folder saves to. */
export function linkedGame(dir: string): string | null {
  return readJson<Record<string, string>>(linksPath(), {})[dir] ?? null;
}
export function linkGame(dir: string, gameId: string) {
  const links = readJson<Record<string, string>>(linksPath(), {});
  if (links[dir] === gameId) return;
  writePrivate(linksPath(), { ...links, [dir]: gameId });
}

async function request(cfg: CloudConfig, path: string, init: RequestInit = {}) {
  const res = await fetch(`${cfg.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${cfg.saveKey}`, ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(body.error ?? `cloud ${res.status}`), { status: res.status });
  }
  return res.json() as Promise<Record<string, unknown>>;
}

const blob = (b: Uint8Array) => new Blob([new Uint8Array(b)]);

export async function saveToCloud(
  cfg: CloudConfig,
  game: { gameId?: string | null; name: string; pack: Uint8Array; label: string; thumbnail?: Uint8Array },
): Promise<CloudSave> {
  let gameId = game.gameId ?? null;
  const upload = (id: string) =>
    request(cfg, `/v1/games/${id}/versions`, {
      method: "POST",
      body: blob(game.pack),
      headers: { "content-type": "application/octet-stream", "x-dreamsy-label": encodeURIComponent(game.label.slice(0, 200)) },
    });

  let saved: Record<string, unknown> | null = null;
  if (gameId) {
    try {
      saved = await upload(gameId);
      await request(cfg, `/v1/games/${gameId}`, { method: "PATCH", body: JSON.stringify({ name: game.name }), headers: { "content-type": "application/json" } }).catch(() => undefined);
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
      gameId = null;
    }
  }
  if (!gameId) {
    gameId = String((await request(cfg, "/v1/games", { method: "POST", body: JSON.stringify({ name: game.name }), headers: { "content-type": "application/json" } })).id);
    saved = await upload(gameId);
  }
  const version = Number(saved!.version);
  if (game.thumbnail?.byteLength) {
    await request(cfg, `/v1/games/${gameId}/versions/${version}/thumb`, { method: "PUT", body: blob(game.thumbnail), headers: { "content-type": "image/jpeg" } }).catch(() => undefined);
  }
  return { gameId, version };
}

export async function publishToCloud(
  cfg: CloudConfig,
  gameId: string,
  info: { author?: string; link?: string; email?: string; remix?: boolean },
): Promise<Publication> {
  const r = await request(cfg, `/v1/games/${gameId}/publish`, { method: "POST", body: JSON.stringify(info), headers: { "content-type": "application/json" } });
  return { slug: String(r.slug), version: Number(r.version) };
}

export const publicPackageUrl = (cfg: CloudConfig, slug: string) => `${cfg.url}/v1/public/games/${slug}/package`;

export const playUrl = (slug: string) => `${(process.env.DREAMSY_SITE_URL ?? "https://dreamsy.dev").replace(/\/$/, "")}/play/${slug}`;
