const v = (s: string | undefined) => (s ?? '').trim();
const noSlash = (s: string) => s.replace(/\/+$/, '');

export const env = {
  apiUrl: noSlash(v(import.meta.env.VITE_API_URL) || 'http://localhost:8787'),
  supabaseUrl: noSlash(v(import.meta.env.VITE_SUPABASE_URL)),
  supabaseKey: v(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY),
  appDeeplink: v(import.meta.env.VITE_APP_DEEPLINK) || 'dreamsy://',
  convexUrl: v(import.meta.env.VITE_CONVEX_URL),
  shareUrl: noSlash(v(import.meta.env.VITE_SHARE_URL) || 'https://dreamsy.app'),
};

export const supabaseEnabled = !!(env.supabaseUrl && env.supabaseKey);

/** `${VITE_APP_DEEPLINK}/game/<id>`; tolerates a base of "dreamsy://" or "https://x/". */
export function deepLink(gameId: string): string {
  const base = env.appDeeplink.endsWith('://') ? env.appDeeplink : `${noSlash(env.appDeeplink)}/`;
  return `${base}game/${encodeURIComponent(gameId)}`;
}

/** Public share page (DREAMSY.MD §11.5). */
export const shareLink = (gameId: string) => `${env.shareUrl}/g/${encodeURIComponent(gameId)}`;
