// "Live now" (GET /v1/live): how many people are online, who is in a game right now (Join / Spectate /
// Play), and 6 trending games. Used by Home and the Welcome sheet. Older APIs have no /v1/live: the
// first 404 marks it unavailable and every Live now surface hides.

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { ActivityIndicator, Animated, Easing, FlatList, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { api, ApiError, type Live, type LivePlayer } from './api';
import { Avatar } from './components/Avatar';
import { openGame } from './components/GameCard';
import { compact } from './social';
import { hairline, ink, radius } from './theme';
import { Pressy, Txt, useReducedMotion } from './ui';

export const LIVE_POLL_MS = 20_000;

type State = { available: boolean | null; data: Live | null };
let state: State = { available: null, data: null };
const listeners = new Set<() => void>();
function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

let inflight: Promise<Live | null> | null = null;

/**
 * GET /v1/live into the store; resolves the data (null on failure). A 404 hides Live now app-wide
 * (rejects with the error so the first-run check can tell). Deduped while in flight.
 */
export function refreshLive(): Promise<Live | null> {
  if (state.available === false) return Promise.resolve(null);
  return (inflight ??= (async () => {
    try {
      const r = await api.live();
      const data: Live = { online: r.online ?? 0, playing: r.playing ?? [], featured: r.featured ?? [] };
      set({ available: true, data });
      return data;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        set({ available: false, data: null });
        throw e;
      }
      // Unreachable for now: an empty snapshot so screens show "quiet" instead of loading forever.
      if (!state.data) set({ data: { online: 0, playing: [], featured: [] } });
      return null;
    } finally {
      inflight = null;
    }
  })());
}

/** Signed out: the next account starts fresh. */
export function resetLive() {
  inflight = null;
  set({ available: null, data: null });
}

/** The live store; polls every 20 s while the screen is focused and `enabled`. */
export function useLive(enabled = true): State {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      const tick = () => void refreshLive().catch(() => {});
      tick();
      const t = setInterval(tick, LIVE_POLL_MS);
      return () => clearInterval(t);
    }, [enabled]),
  );
  return s;
}

// ---------- what a person row says and offers ----------

/** "1v1 · 2/2", "lobby · 1/4", "match · 3/8". */
export function liveModeLine(p: LivePlayer): string {
  const count = p.max > 0 ? `${p.players}/${p.max}` : `${p.players}`;
  if (p.status === 'in_room') return `lobby · ${count}`;
  return `${p.mode === 'duel' || p.max === 2 ? '1v1' : 'match'} · ${count}`;
}

/** Join a lobby with space, Spectate a running match, else open the game's page. */
export function liveAction(p: LivePlayer): 'join' | 'spectate' | 'play' {
  if (p.joinable) return 'join';
  if (p.status === 'in_match' && p.spectatable) return 'spectate';
  return 'play';
}

export const onlineLabel = (n: number) => `${compact(n)} ${n === 1 ? 'person' : 'people'} online`;

// ---------- UI ----------

/** Soft pulsing green dot: "this is happening now". Still under reduced motion. */
export function LiveDot({ size = 8 }: { size?: number }) {
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);
  const ring = size * 2.4;
  return (
    <View style={{ width: ring, height: ring, alignItems: 'center', justifyContent: 'center' }}>
      {!reduced && (
        <Animated.View
          style={{
            position: 'absolute',
            width: ring,
            height: ring,
            borderRadius: ring / 2,
            backgroundColor: ink.ok,
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
          }}
        />
      )}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: ink.ok }} />
    </View>
  );
}

/** Section head: "● Live now" + "N online". */
export function LiveHeader({ online, style, compactCount }: { online: number; style?: StyleProp<ViewStyle>; compactCount?: boolean }) {
  return (
    <View style={[styles.head, style]}>
      <View style={styles.headLeft}>
        <LiveDot />
        <Txt variant="pixel" style={styles.headTitle}>
          Live now
        </Txt>
      </View>
      <View style={styles.onlinePill} accessibilityLabel={onlineLabel(online)}>
        <Txt variant="label" color={ink.ok}>
          {compactCount ? `${compact(online)} online` : onlineLabel(online)}
        </Txt>
      </View>
    </View>
  );
}

const CARD_W = 148;

/** One person in a game: avatar, @handle, game, "lobby · 1/4", and the action pill. */
export const LivePersonCard = memo(function LivePersonCard({ p, busy, onJoin, onSpectate }: {
  p: LivePlayer;
  busy: boolean;
  onJoin: (p: LivePlayer) => void;
  onSpectate: (p: LivePlayer) => void;
}) {
  const action = liveAction(p);
  const label = action === 'join' ? 'Join' : action === 'spectate' ? 'Spectate' : 'Play';
  const icon = action === 'join' ? 'enter-outline' : action === 'spectate' ? 'eye-outline' : 'play';
  const run = () => (action === 'join' ? onJoin(p) : action === 'spectate' ? onSpectate(p) : openGame(p.gameId));
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View>
          <Avatar user={p.user} size={44} />
          <View style={[styles.statusDot, { backgroundColor: p.status === 'in_match' ? ink.accent : ink.ok }]} />
        </View>
        <View style={styles.modeChip}>
          <Ionicons name={p.status === 'in_match' ? 'flash' : 'people'} size={10} color={ink.navy} />
          <Txt variant="badge" color={ink.navy} numberOfLines={1}>
            {liveModeLine(p)}
          </Txt>
        </View>
      </View>
      <View style={styles.cardText}>
        <Txt variant="heading" numberOfLines={1}>
          @{p.user.handle}
        </Txt>
        <Txt variant="meta" muted numberOfLines={1}>
          {p.gameName}
        </Txt>
      </View>
      <Pressy
        accessibilityRole="button"
        accessibilityLabel={`${label} ${p.gameName} with @${p.user.handle}`}
        onPress={run}
        disabled={busy}
        style={[styles.action, action === 'join' ? styles.actionJoin : action === 'spectate' ? styles.actionWatch : styles.actionPlay]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={action === 'join' ? ink.accentFg : ink.navy} />
        ) : (
          <>
            <Ionicons name={icon} size={14} color={action === 'join' ? ink.accentFg : ink.navy} />
            <Txt variant="label" color={action === 'join' ? ink.accentFg : ink.navy}>
              {label}
            </Txt>
          </>
        )}
      </Pressy>
    </View>
  );
});

/** Horizontal list of people playing. `busy` = room code being opened. */
export function LivePeopleList({ playing, busy, onJoin, onSpectate, padding = 16 }: {
  playing: LivePlayer[];
  busy: string | null;
  onJoin: (p: LivePlayer) => void;
  onSpectate: (p: LivePlayer) => void;
  padding?: number;
}) {
  return (
    <FlatList
      horizontal
      data={playing}
      keyExtractor={(p) => `${p.roomCode}:${p.user.id}`}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.row, { paddingHorizontal: padding }]}
      renderItem={({ item }) => <LivePersonCard p={item} busy={busy === item.roomCode} onJoin={onJoin} onSpectate={onSpectate} />}
    />
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  headLeft: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: -6 },
  headTitle: { fontSize: 18 },
  onlinePill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: 'rgba(46,157,106,0.12)' },
  row: { gap: 10 },
  card: { width: CARD_W, padding: 12, gap: 10, borderRadius: radius.lg, backgroundColor: ink.card, borderWidth: hairline, borderColor: ink.border },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 },
  statusDot: { position: 'absolute', right: -1, bottom: -1, width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: ink.card },
  modeChip: { flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 1, paddingHorizontal: 6, paddingVertical: 4, borderRadius: 6, backgroundColor: ink.wash },
  cardText: { gap: 1 },
  action: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, height: 34, borderRadius: radius.pill },
  actionJoin: { backgroundColor: ink.accent },
  actionWatch: { backgroundColor: ink.wash },
  actionPlay: { backgroundColor: ink.card, borderWidth: hairline, borderColor: ink.border },
});
