// Cursor pagination for FlatLists: first page, pull to refresh, load more. Changing `key` (tab,
// search query, sort) resets the list; responses for an old key are dropped.

import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './theme';

export type PageResult<T> = { items: T[]; next: string | null };

export function usePaged<T>(
  key: string,
  fetchPage: (cursor: string | null) => Promise<PageResult<T>>,
  idOf: (item: T) => string,
  enabled = true,
) {
  const [items, setItems] = useState<T[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const gen = useRef(0); // bumps on every reset
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const loadingMoreRef = useRef(false);

  const loadFirst = useCallback(async () => {
    const g = ++gen.current;
    try {
      const r = await fetchRef.current(null);
      if (g !== gen.current) return;
      setItems(r.items);
      setNext(r.next);
      setError(null);
    } catch (e) {
      if (g !== gen.current) return;
      setError(errorMessage(e));
      setItems((cur) => cur ?? []);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setItems(null);
    setNext(null);
    setError(null);
    void loadFirst();
  }, [key, enabled, loadFirst]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await loadFirst();
    setRefreshing(false);
  }, [loadFirst]);

  const loadMore = useCallback(async () => {
    if (!next || loadingMoreRef.current) return;
    const g = gen.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const r = await fetchRef.current(next);
      if (g !== gen.current) return;
      setItems((cur) => {
        const seen = new Set((cur ?? []).map(idOf));
        return [...(cur ?? []), ...r.items.filter((i) => !seen.has(idOf(i)))];
      });
      setNext(r.next);
    } catch (e) {
      if (g === gen.current) setError(errorMessage(e));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [next, idOf]);

  return { items, setItems, error, refreshing, loadingMore, refresh, loadMore, hasMore: !!next };
}
