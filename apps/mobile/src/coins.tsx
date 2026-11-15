// Pay-per-play coins (DREAMSY.MD §11.6): 10,000 coins = $0.10; playing someone else's published game
// costs PLAY_PRICE (creator 90%, Dreamsy 10%) and buys a 30-minute pass. Free: own games, drafts
// shared to a group, an active pass. The server decides; this file formats, remembers passes, and
// gates the Play screen (POST /v1/games/:id/play before opening the player).
//
// Older APIs (no /play, wallet in "stars") degrade: play isn't gated and prices aren't shown.

import { router } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { api, ApiError, type Orientation } from './api';
import { floating, ink, radius } from './theme';
import { Button, PixelCoin, Txt } from './ui';
import { walletChanged } from './wallet';

export const PLAY_PRICE = 10_000;
/** A game's first build (edits stay free); refunded if that build fails. */
export const CREATE_PRICE = 100_000;
/** Remixing someone else's game; all of it goes to the original owner. */
export const REMIX_PRICE = 25_000;
export const COINS_PER_USD = 100_000;

/** 1_000_000 -> "1.0M", 990_000 -> "990K", 9_000 -> "9K", 500 -> "500". `unit` appends " coins". */
export function formatCoins(n: number, unit = false): string {
  const a = Math.abs(n);
  const s = a >= 1_000_000 ? `${(Math.floor(a / 100_000) / 10).toFixed(1)}M` : a >= 1000 ? `${Math.floor(a / 1000)}K` : String(a);
  return `${n < 0 ? '−' : ''}${s}${unit ? ' coins' : ''}`;
}

/** "$9.90". `usd` from the API when it sent one, else derived from coins. */
export function formatUsd(coins: number, usd?: number | null): string {
  const v = typeof usd === 'number' && Number.isFinite(usd) ? usd : coins / COINS_PER_USD;
  return `$${v.toFixed(2)}`;
}

export const priceOf = (g: { playPrice?: number | null } | null | undefined) => g?.playPrice ?? PLAY_PRICE;

// ---------- is the coins API live? (null = not known yet) ----------

let economy: boolean | null = null;
const economyListeners = new Set<() => void>();
export function setEconomy(live: boolean) {
  if (economy === live) return;
  economy = live;
  for (const l of economyListeners) l();
}
let probing: Promise<void> | null = null;
const probe = () =>
  (probing ??= api.wallet().then(
    (r) => setEconomy(r.wallet.currency === 'coins'),
    () => {
      probing = null; // retry on the next screen that asks
    },
  ));

/** true = coins API deployed; false = older API (no prices, no gate); null = still checking. */
export function useEconomy(): boolean | null {
  const v = useSyncExternalStore(
    (l) => {
      economyListeners.add(l);
      return () => economyListeners.delete(l);
    },
    () => economy,
  );
  useEffect(() => {
    if (v === null) void probe();
  }, [v]);
  return v;
}

/** Unknown route (API not deployed yet) vs. a real 404 like "game not found". */
export const isMissingRoute = (e: unknown) =>
  e instanceof ApiError &&
  e.status === 404 &&
  (typeof e.body?.message === 'string' ? /^Route /.test(e.body.message) : e.body?.error === 'Not Found' || !e.body);

/** 402 `{ error: "insufficient_coins", balance, price }` -> the "Out of coins" sheet state; else null. */
export function insufficientFrom(e: unknown, fallbackPrice: number): { balance: number; price: number } | null {
  if (!(e instanceof ApiError && e.status === 402)) return null;
  const n = (k: string, d: number) => (typeof e.body?.[k] === 'number' ? (e.body[k] as number) : d);
  return { balance: n('balance', 0), price: n('price', fallbackPrice) };
}

// ---------- create price (null = this API doesn't charge for creating) ----------

let createPrice: number | null | undefined;
let createProbe: Promise<void> | null = null;
const createListeners = new Set<() => void>();
const probeCreatePrice = () =>
  (createProbe ??= (async () => {
    const q = await api.quota().then((r) => r.quota.createPrice, () => undefined);
    const w = typeof q === 'number' ? q : await api.wallet().then((r) => r.wallet.createPrice, () => undefined);
    createPrice = typeof w === 'number' ? w : typeof q === 'number' ? q : null;
    for (const l of createListeners) l();
  })().finally(() => {
    if (createPrice === undefined) createProbe = null;
  }));

/** Coins for a first build, from GET /v1/me/quota (or wallet). null while unknown or on older APIs. */
export function useCreatePrice(): number | null {
  const v = useSyncExternalStore(
    (l) => {
      createListeners.add(l);
      return () => createListeners.delete(l);
    },
    () => createPrice,
  );
  useEffect(() => {
    if (v === undefined) void probeCreatePrice();
  }, [v]);
  return v ?? null;
}

// ---------- play passes, per game, in memory ----------

const passes = new Map<string, number>();
const passListeners = new Set<() => void>();
export function setPass(gameId: string, expiresAt: string) {
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return;
  passes.set(gameId, t);
  for (const l of passListeners) l();
}

/** True while a 30-minute pass for this game is active; flips back when it expires. */
export function usePassActive(gameId: string | null | undefined): boolean {
  const until = useSyncExternalStore(
    (l) => {
      passListeners.add(l);
      return () => passListeners.delete(l);
    },
    () => (gameId ? (passes.get(gameId) ?? 0) : 0),
  );
  const [, tick] = useState(0);
  useEffect(() => {
    const left = until - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.min(left + 50, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [until]);
  return until > Date.now();
}

/**
 * GET /v1/games/:id/play (no side effects), refetched on focus: is playing free right now, and the
 * price. Records an active pass. null until it answers, or when the API doesn't have it.
 */
export function usePlayStatus(gameId: string | null | undefined, enabled = true): { free: boolean; price: number } | null {
  const [status, setStatus] = useState<{ free: boolean; price: number } | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!gameId || !enabled) return;
      let cancelled = false;
      api.playStatus(gameId).then(
        (r) => {
          if (cancelled) return;
          setEconomy(true);
          if (r.pass?.expiresAt) setPass(gameId, r.pass.expiresAt);
          setStatus({ free: r.free, price: r.price ?? PLAY_PRICE });
        },
        (e) => {
          if (cancelled) return;
          if (isMissingRoute(e)) setStatus(null);
        },
      );
      return () => {
        cancelled = true;
      };
    }, [gameId, enabled]),
  );
  return status;
}

/** Play button label + price: "Play · 10K" (coin), "Play · Free", or plain "Play" (older API). */
export function playLabel(opts: { own: boolean; draft: boolean; pass: boolean; price: number; economy: boolean | null }): { label: string; price?: string } {
  if (opts.draft) return { label: 'Play draft' };
  if (opts.economy === false) return { label: 'Play' };
  if (opts.own || opts.pass) return { label: 'Play · Free' };
  return { label: 'Play', price: formatCoins(opts.price) };
}

// ---------- the gate ----------

export type Charge = { price: number; earned: number };
export type GateResult =
  | { kind: 'open'; charge: Charge | null; legacy: boolean }
  | { kind: 'out'; balance: number; price: number };

/** POST /play. 402 = out of coins; anything else fails open (the game opens anyway). */
export async function gatePlay(gameId: string): Promise<GateResult> {
  if (economy === false) return { kind: 'open', charge: null, legacy: true };
  try {
    const r = await api.play(gameId);
    setEconomy(true);
    if (r.pass?.expiresAt) setPass(gameId, r.pass.expiresAt);
    walletChanged();
    return { kind: 'open', charge: r.charged ? { price: r.price, earned: r.creatorEarned } : null, legacy: false };
  } catch (e) {
    if (e instanceof ApiError && e.status === 402) {
      const n = (k: string, d: number) => (typeof e.body?.[k] === 'number' ? (e.body[k] as number) : d);
      walletChanged();
      return { kind: 'out', balance: n('balance', 0), price: n('price', PLAY_PRICE) };
    }
    const legacy = isMissingRoute(e);
    if (legacy) setEconomy(false);
    console.warn(`[coins] play gate failed for ${gameId}; opening anyway`, e);
    return { kind: 'open', charge: null, legacy };
  }
}

export type PlayTarget = { id: string; version: number; orientation?: Orientation | null };

/** Route params for an already-gated play (the Play screen shows the charge toast from them). */
export const playParams = (t: PlayTarget, charge: Charge | null) => ({
  id: t.id,
  version: String(t.version),
  ...(t.orientation ? { orientation: t.orientation } : {}),
  gated: '1',
  ...(charge ? { charged: String(charge.price), earned: String(charge.earned) } : {}),
});

/**
 * For screens with a Play button: `play(target)` gates then opens the player; render `sheet`
 * somewhere in the screen (the "Out of coins" sheet). `busy` = id being gated.
 */
export function usePlayGate() {
  const [out, setOut] = useState<{ balance: number; price: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const play = async (t: PlayTarget, opts: { onLegacy?: () => void } = {}) => {
    if (busy) return;
    setBusy(t.id);
    const r = await gatePlay(t.id);
    setBusy(null);
    if (r.kind === 'out') {
      setOut({ balance: r.balance, price: r.price });
      return;
    }
    if (r.legacy) opts.onLegacy?.();
    router.push({ pathname: '/play/[id]', params: playParams(t, r.charge) });
  };

  const sheet = <OutOfCoinsSheet state={out} onClose={() => setOut(null)} />;
  return { play, busy, sheet };
}

/** Bottom sheet: not enough coins. `what` costs it: "This game" (play), "Creating a game", "Remixing this game". */
export function OutOfCoinsSheet({ state, onClose, what }: { state: { balance: number; price: number } | null; onClose: () => void; what?: string }) {
  return (
    <Modal visible={!!state} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={styles.sheet} onPress={() => {}}>
          {state && <OutOfCoins balance={state.balance} price={state.price} onClose={onClose} what={what} />}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** The sheet's body; also shown inline by the Play screen when it gates a deep link itself. */
export function OutOfCoins({ balance, price, onClose, what = 'This game' }: { balance: number; price: number; onClose: () => void; what?: string }) {
  return (
    <View style={styles.body}>
      <View style={styles.coin}>
        <PixelCoin size={22} color={ink.accentFg} />
      </View>
      <Txt variant="title" color={ink.navy} center>
        Out of coins
      </Txt>
      <Txt variant="body" muted center>
        {what} costs {formatCoins(price, true)}. You have {formatCoins(balance, true)} ({formatUsd(balance)}).
      </Txt>
      <View style={styles.note}>
        <Txt variant="label" color={ink.navy} center>
          Coins are free for now — more coming soon
        </Txt>
      </View>
      <Button label="OK" size="md" onPress={onClose} style={styles.ok} />
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(13,42,102,0.35)' },
  sheet: { backgroundColor: ink.card, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingBottom: 34, ...floating },
  body: { alignItems: 'center', gap: 10, padding: 24 },
  coin: { width: 52, height: 52, borderRadius: 26, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  note: { alignSelf: 'stretch', marginTop: 4, padding: 12, borderRadius: radius.md, backgroundColor: ink.wash },
  ok: { alignSelf: 'stretch', marginTop: 6 },
});
