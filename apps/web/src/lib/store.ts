// Tiny keyed fetch cache: useResource(key, fetcher) with shared results, invalidation and refetch.
import { useCallback, useEffect, useReducer } from 'react';

type Entry = { data?: unknown; error?: unknown; promise?: Promise<unknown>; at: number; stale: boolean };
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

const notify = (key: string) => listeners.get(key)?.forEach((l) => l());

export function clearCache() {
  entries.clear();
  for (const k of listeners.keys()) notify(k);
}

/** Mark keys starting with `prefix` stale and refetch the ones being watched. */
export function invalidate(prefix: string) {
  for (const [k, e] of entries) if (k.startsWith(prefix)) e.stale = true;
  for (const k of listeners.keys()) if (k.startsWith(prefix)) notify(k);
}

export function setCached<T>(key: string, update: (prev: T | undefined) => T) {
  const e = entries.get(key) ?? { at: Date.now(), stale: false };
  e.data = update(e.data as T | undefined);
  entries.set(key, e);
  notify(key);
}

function load(key: string, fetcher: () => Promise<unknown>) {
  const e = entries.get(key) ?? { at: 0, stale: true };
  if (e.promise) return;
  e.promise = fetcher().then(
    (data) => { e.data = data; e.error = undefined; },
    (error) => { e.error = error; },
  ).finally(() => { e.promise = undefined; e.stale = false; e.at = Date.now(); notify(key); });
  entries.set(key, e);
}

export type Resource<T> = { data: T | undefined; error: unknown; loading: boolean; refetch: () => void };

export function useResource<T>(key: string | null, fetcher: () => Promise<T>): Resource<T> {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!key) return;
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    const l = () => {
      const e = entries.get(key);
      if (!e || (e.stale && !e.promise)) load(key, fetcher);
      force();
    };
    set.add(l);
    const e = entries.get(key);
    if (!e || e.stale) load(key, fetcher);
    force();
    return () => { set!.delete(l); };
    // fetcher is keyed by `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const refetch = useCallback(() => { if (key) invalidate(key); }, [key]);
  const e = key ? entries.get(key) : undefined;
  return { data: e?.data as T | undefined, error: e?.error, loading: !!key && (!e || (!!e.promise && e.data === undefined)), refetch };
}
