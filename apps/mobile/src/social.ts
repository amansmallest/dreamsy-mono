// Small shared helpers for the social side (feed, game page, profiles, market). DREAMSY.MD §11.

import { Share } from 'react-native';

/**
 * Public share link for a game (§11.5). The one place that builds it: production web serves
 * `${WEB_URL}/g/<id>`; the engine dev server serves `?public=<id>` instead, so if sharing a dev
 * link, change it here.
 */
export function shareUrl(gameId: string): string {
  const base = (process.env.EXPO_PUBLIC_WEB_URL ?? process.env.EXPO_PUBLIC_ENGINE_URL ?? '').trim();
  const withSlash = !base || base.endsWith('/') ? base : `${base}/`;
  // The engine page plays published games without an account at ?public=<id> (it finds the API on
  // the same host, port 8787; pass &api= when the API lives elsewhere).
  const api = (process.env.EXPO_PUBLIC_API_URL ?? '').trim();
  const apiParam = api && !process.env.EXPO_PUBLIC_WEB_URL ? `&api=${encodeURIComponent(api)}` : '';
  return `${withSlash}?public=${encodeURIComponent(gameId)}${apiParam}`;
}

export async function shareGame(game: { id: string; name: string }) {
  const url = shareUrl(game.id);
  // iOS shows `url` as a link preview; Android only reads `message`.
  await Share.share({ message: `Play ${game.name} on Dreamsy ${url}`, url, title: game.name }).catch(() => {});
}

/** 1234 -> "1.2K". */
export function compact(n: number | undefined | null): string {
  const v = n ?? 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${trim(v / 1000)}K`;
  return `${trim(v / 1_000_000)}M`;
}
const trim = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ''));

/** Deterministic two-color gradient for a game without a thumbnail. */
const PALETTE: [string, string][] = [
  ['#6a5af9', '#d66efd'],
  ['#ff7a59', '#ffb347'],
  ['#00b4db', '#0083b0'],
  ['#11998e', '#38ef7d'],
  ['#f857a6', '#ff5858'],
  ['#4568dc', '#b06ab3'],
  ['#ee9ca7', '#ffdde1'],
  ['#3a7bd5', '#00d2ff'],
];
export function gradientFor(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}

export const REPORT_REASONS = ['Inappropriate content', 'Hateful or abusive', 'Spam or scam', 'Broken or misleading', 'Other'];
