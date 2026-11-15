// Coins wallet for the signed-in user. Any screen showing it uses useWallet(); anything that
// changes it (an in-game purchase, a paid play) calls walletChanged() and every mounted useWallet refetches.

import { useCallback, useEffect, useState } from 'react';
import { api, type LedgerEntry, type Wallet } from './api';
import { errorMessage } from './theme';

const listeners = new Set<() => void>();

export function walletChanged() {
  for (const l of listeners) l();
}

export function useWallet() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [recent, setRecent] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.wallet();
      setWallet(r.wallet);
      setRecent(r.recent);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    const l = () => void refresh();
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [refresh]);

  /** Coins API deployed (older APIs report "stars"). */
  const live = wallet?.currency === 'coins';
  return { wallet, recent, error, refresh, live };
}
