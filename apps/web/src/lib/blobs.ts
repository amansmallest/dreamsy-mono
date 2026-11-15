// Images behind auth (draft thumbnails, sprite files): fetch with the bearer → object URL, cached.
import { useEffect, useState } from 'react';
import { authedFetch } from './api';

const cache = new Map<string, Promise<string>>();

export function clearBlobCache() {
  for (const p of cache.values()) p.then((u) => URL.revokeObjectURL(u), () => {});
  cache.clear();
}

export function loadBlobUrl(url: string): Promise<string> {
  let p = cache.get(url);
  if (!p) {
    p = authedFetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return URL.createObjectURL(await r.blob());
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

export function useAuthedImage(url: string | null | undefined): { src: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; src: string | null; failed: boolean }>({ url: null, src: null, failed: false });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    loadBlobUrl(url).then(
      (src) => alive && setState({ url, src, failed: false }),
      () => alive && setState({ url, src: null, failed: true }),
    );
    return () => { alive = false; };
  }, [url]);
  if (!url || state.url !== url) return { src: null, failed: false };
  return state;
}
