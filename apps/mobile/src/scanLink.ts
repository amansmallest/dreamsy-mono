// What a Dreamsy QR code can hold, and the game id inside it:
//   dreamsy://game/<id>            dashboard "Play on phone" (VITE_APP_DEEPLINK/game/<id>)
//   https://<host>/game/<id>       same, with an https deep-link base
//   https://<host>/g/<id>          public share page (DREAMSY.MD §11.5)
//   http://<engine>/?public=<id>   dev share link from the app (src/social.ts shareUrl)
//   g_…                            a bare game id

const ID = /^g_[A-Za-z0-9_-]+$/;

export function gameIdFromScan(raw: string): string | null {
  const text = raw.trim();
  if (ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  for (const key of ['public', 'game']) {
    const q = url.searchParams.get(key);
    if (q) return decodeURIComponent(q);
  }
  // dreamsy://game/<id> parses with host "game"; https URLs carry it in the path.
  const parts = [url.host, ...url.pathname.split('/')].filter(Boolean).map(decodeURIComponent);
  const at = parts.findIndex((p) => p === 'game' || p === 'g');
  const id = at >= 0 ? parts[at + 1] : undefined;
  return id || null;
}

/** Group invite: https://<host>/join/<code> or dreamsy://join/<code> -> the code (DREAMSY.MD §13). */
export function inviteCodeFromScan(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const parts = [url.host, ...url.pathname.split('/')].filter(Boolean).map(decodeURIComponent);
  const at = parts.indexOf('join');
  return (at >= 0 && parts[at + 1]) || null;
}
