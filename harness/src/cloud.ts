export interface CloudConfig {
  url: string;
  saveKey: string;
}

export interface CloudSave {
  gameId: string;
  version: number;
}

export function cloudFromEnv(env: NodeJS.ProcessEnv = process.env): CloudConfig | null {
  const url = env.DREAMSY_CLOUD_URL?.trim().replace(/\/$/, "");
  const saveKey = env.DREAMSY_SAVE_KEY?.trim();
  return url && saveKey ? { url, saveKey } : null;
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

export async function saveToCloud(
  cfg: CloudConfig,
  game: { gameId?: string | null; name: string; pack: Uint8Array; label: string; thumbnail?: Uint8Array },
): Promise<CloudSave> {
  let gameId = game.gameId ?? null;
  const upload = (id: string) =>
    request(cfg, `/v1/games/${id}/versions`, {
      method: "POST",
      body: new Blob([new Uint8Array(game.pack)]),
      headers: { "content-type": "application/octet-stream", "x-dreamsy-label": encodeURIComponent(game.label.slice(0, 200)) },
    });

  let saved: Record<string, unknown> | null = null;
  if (gameId) {
    try {
      saved = await upload(gameId);
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
    await request(cfg, `/v1/games/${gameId}/versions/${version}/thumb`, { method: "PUT", body: new Blob([new Uint8Array(game.thumbnail)]), headers: { "content-type": "image/jpeg" } }).catch(() => undefined);
  }
  return { gameId, version };
}
