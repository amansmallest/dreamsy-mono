import type { BuildRecord, GameDetail, GameSummary, KeyStatus, Provider } from "@/lib/editor-types";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  games: () => call<{ games: GameSummary[] }>("/api/games"),
  create: (name: string) => call<{ id: string }>("/api/games", { method: "POST", body: JSON.stringify({ name }) }),
  game: (id: string) => call<{ game: GameDetail; running: boolean }>(`/api/games/${id}`),
  rename: (id: string, name: string) => call(`/api/games/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  build: (id: string, prompt: string, images: { mediaType: string; base64: string }[]) =>
    call<{ build: BuildRecord }>(`/api/games/${id}/build`, { method: "POST", body: JSON.stringify({ prompt, images }) }),
  cancel: (id: string) => call(`/api/games/${id}/build`, { method: "DELETE" }),
  restore: (id: string, v: number) => call(`/api/games/${id}/versions/${v}`, { method: "POST" }),
  keys: () => call<KeyStatus>("/api/keys"),
  saveKey: (provider: Provider, key: string) => call<KeyStatus>("/api/keys", { method: "POST", body: JSON.stringify({ provider, key }) }),
  removeKey: (provider: Provider) => call<KeyStatus>(`/api/keys?provider=${provider}`, { method: "DELETE" }),
};

export const hasBuildKey = (k: KeyStatus | null) => !!(k?.anthropic || k?.openai);

export function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export async function fileToImage(f: File) {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mediaType: f.type, base64: btoa(bin) };
}
