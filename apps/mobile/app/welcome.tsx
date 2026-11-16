import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, type FeedGame, type LivePlayer } from '@/api';
import { useAuth } from '@/auth';
import { GameCard, openGame } from '@/components/GameCard';
import { openInvite } from '@/friends';
import { LiveHeader, LivePeopleList, useLive } from '@/live';
import { finishOnboarding } from '@/onboarding';
import { floating, hairline, ink, radius } from '@/theme';
import { Button, IconButton, PixelSky, Skeleton, Txt, useReducedMotion } from '@/ui';

const PAD = 20;
const COLS = 3;
const GAP = 10;

/** "You swam 412 m · #7 today" from the first run's runEnd; null without a value. */
function resultLine(board?: string, value?: string, rank?: string): string | null {
  const v = Number(value);
  if (value === undefined || !Number.isFinite(v)) return null;
  const distance = !board || /dist|meter|metre|depth|swim|far|run/i.test(board);
  const head = distance ? `You swam ${Math.round(v).toLocaleString()} m` : `You scored ${Math.round(v).toLocaleString()}`;
  const r = Number(rank);
  if (rank === undefined || !(r > 0)) return head;
  const daily = !board || /day|daily|today/i.test(board);
  return `${head} · #${Math.round(r)} ${daily ? 'today' : 'overall'}`;
}

/**
 * "Welcome to Dreamsy world": shown once, after the first game's run ends (or Quit / 120 s; see
 * src/onboarding.tsx). Live now (polled every 20 s), 6 games to try, and the way into Create. Showing
 * it marks onboarding done (POST /v1/me/onboarding). Params: game (the onboarding game, left out of
 * "Try these"), board / value / rank (the run's result, if any).
 */
export default function WelcomeScreen() {
  const params = useLocalSearchParams<{ game?: string; board?: string; value?: string; rank?: string }>();
  const { user, updateUser } = useAuth();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const live = useLive();
  const result = resultLine(params.board, params.value, params.rank);

  // Showing the sheet is what finishes onboarding (once per account, both platforms).
  useEffect(() => {
    void finishOnboarding(user, updateUser);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Try these": the 6 trending games from /v1/live; the feed if that didn't answer.
  const [fallback, setFallback] = useState<FeedGame[] | null>(null);
  const fromLive = live.data?.featured ?? [];
  useEffect(() => {
    if (fromLive.length || fallback) return;
    const t = setTimeout(() => {
      api.feed('trending', null, 8).then(
        (r) => setFallback(r.games),
        () => setFallback([]),
      );
    }, live.data ? 0 : 2500);
    return () => clearTimeout(t);
  }, [fromLive.length, fallback, live.data]);
  const featured = (fromLive.length ? fromLive : (fallback ?? [])).filter((g) => g.id !== params.game).slice(0, 6);
  const featuredLoading = !fromLive.length && fallback === null;

  // ---------- motion: scrim fades, the sheet springs up, sections follow ----------
  const scrim = useRef(new Animated.Value(0)).current;
  const sheet = useRef(new Animated.Value(0)).current;
  const parts = useRef([0, 1, 2, 3].map(() => new Animated.Value(0))).current;
  const leaving = useRef(false);

  useEffect(() => {
    const fade = (v: Animated.Value, d = 180) => Animated.timing(v, { toValue: 1, duration: d, useNativeDriver: true });
    const anim = reduced
      ? Animated.parallel([fade(scrim), fade(sheet), ...parts.map((p) => fade(p))])
      : Animated.parallel([
          Animated.timing(scrim, { toValue: 1, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.spring(sheet, { toValue: 1, friction: 9, tension: 55, useNativeDriver: true }),
          Animated.stagger(
            90,
            parts.map((p) => Animated.spring(p, { toValue: 1, friction: 8, tension: 60, useNativeDriver: true })),
          ),
        ]);
    anim.start();
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Close the sheet, then do `next` (navigation lands on the screen below: Home). */
  const leave = (next?: () => void, animate = true) => {
    if (leaving.current) return;
    leaving.current = true;
    const go = () => {
      if (router.canGoBack()) router.back();
      else router.replace('/');
      if (next) setTimeout(next, 0);
    };
    if (!animate) return go();
    Animated.parallel([
      Animated.timing(scrim, { toValue: 0, duration: reduced ? 120 : 220, useNativeDriver: true }),
      Animated.timing(sheet, { toValue: 0, duration: reduced ? 120 : 240, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]).start(go);
  };

  const explore = () => leave(() => router.navigate('/'));
  const create = () => leave(() => router.navigate('/create'));
  const join = (p: LivePlayer) => leave(() => void openInvite({ gameId: p.gameId, roomCode: p.roomCode }), false);
  const spectate = (p: LivePlayer) => leave(() => void openInvite({ gameId: p.gameId, roomCode: p.roomCode, spectate: true }), false);
  const tryGame = (id: string) => leave(() => openGame(id), false);

  const sheetY = sheet.interpolate({ inputRange: [0, 1], outputRange: [reduced ? 0 : height, 0] });
  const part = (i: number) => ({
    opacity: parts[i],
    transform: [{ translateY: parts[i]!.interpolate({ inputRange: [0, 1], outputRange: [reduced ? 0 : 18, 0] }) }],
  });
  const card = Math.floor((width - PAD * 2 - GAP * (COLS - 1)) / COLS);
  const footer = 112 + insets.bottom;

  return (
    <View style={styles.root}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: scrim }]} />
      <Animated.View
        accessibilityViewIsModal
        style={[styles.sheet, { marginTop: insets.top + 10, opacity: reduced ? sheet : 1, transform: [{ translateY: sheetY }] }]}
      >
        <ScrollView contentContainerStyle={{ paddingBottom: footer + 12 }} showsVerticalScrollIndicator={false}>
          {/* hero */}
          <View style={styles.hero}>
            <PixelSky dense style={StyleSheet.absoluteFill} />
            <View style={styles.closeWrap}>
              <IconButton icon="close" label="Close and explore" size={40} onPress={explore} />
            </View>
            <Animated.View style={[styles.heroInner, part(0)]}>
              <View style={styles.badge}>
                <Ionicons name="water" size={26} color={ink.accentFg} />
              </View>
              <Txt variant="display" color={ink.navy} center accessibilityRole="header">
                Welcome to Dreamsy world
              </Txt>
              <Txt variant="body" color={ink.navy} center style={styles.sub}>
                Every game here was made by someone typing an idea. Try a few, then make your own.
              </Txt>
              {result && (
                <View style={styles.result}>
                  <Ionicons name="trophy" size={15} color={ink.accent} />
                  <Txt variant="label" color={ink.navy}>
                    {result}
                  </Txt>
                </View>
              )}
            </Animated.View>
          </View>

          {/* live now */}
          {live.available !== false && (
            <Animated.View style={[styles.section, part(1)]}>
              <LiveHeader online={live.data?.online ?? 0} style={styles.pad} />
              {live.data === null ? (
                <View style={[styles.pad, styles.liveSkeleton]}>
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} style={styles.liveSkel} />
                  ))}
                </View>
              ) : live.data.playing.length ? (
                <LivePeopleList playing={live.data.playing} busy={null} onJoin={join} onSpectate={spectate} padding={PAD} />
              ) : (
                <View style={[styles.pad, styles.quiet]}>
                  <Ionicons name="people-outline" size={18} color={ink.muted} />
                  <Txt variant="meta" muted style={styles.flex}>
                    Nobody's mid-game this second. Start a multiplayer game and others can jump in.
                  </Txt>
                </View>
              )}
            </Animated.View>
          )}

          {/* try these */}
          {(featuredLoading || featured.length > 0) && (
            <Animated.View style={[styles.section, part(2)]}>
              <View style={styles.pad}>
                <Txt variant="pixel" style={styles.sectionTitle}>
                  Try these
                </Txt>
                <Txt variant="meta" muted>
                  Trending right now
                </Txt>
              </View>
              <View style={[styles.grid, styles.pad]}>
                {featuredLoading
                  ? [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} style={{ width: card, height: card + 40, borderRadius: radius.md }} />)
                  : featured.map((g) => <GameCard key={g.id} game={g} width={card} onPress={tryGame} />)}
              </View>
            </Animated.View>
          )}
        </ScrollView>

        {/* actions */}
        <Animated.View style={[styles.footer, { paddingBottom: insets.bottom + 10 }, part(3)]}>
          <Button label="Make your own game" sparkles onPress={create} />
          <Button label="Explore" variant="ghost" size="md" onPress={explore} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrim: { backgroundColor: 'rgba(13,42,102,0.4)' },
  sheet: { flex: 1, backgroundColor: ink.bg, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, overflow: 'hidden', ...floating },
  hero: { paddingTop: 44, paddingBottom: 28, paddingHorizontal: PAD, overflow: 'hidden' },
  closeWrap: { position: 'absolute', top: 8, right: 8, zIndex: 2, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.7)' },
  heroInner: { alignItems: 'center', gap: 10 },
  badge: { width: 60, height: 60, borderRadius: 30, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center', marginBottom: 4, ...floating },
  sub: { maxWidth: 330, opacity: 0.85 },
  result: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.pill, backgroundColor: ink.card, ...floating },
  section: { marginTop: 24, gap: 12 },
  sectionTitle: { fontSize: 18 },
  pad: { paddingHorizontal: PAD },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  quiet: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: PAD, paddingVertical: 14, paddingHorizontal: 14, borderRadius: radius.lg, backgroundColor: ink.card, borderWidth: hairline, borderColor: ink.border },
  liveSkeleton: { flexDirection: 'row', gap: 10 },
  liveSkel: { width: 148, height: 150, borderRadius: radius.lg },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, gap: 4, paddingTop: 12, paddingHorizontal: PAD, backgroundColor: ink.bg, borderTopWidth: hairline, borderTopColor: ink.border },
  flex: { flex: 1 },
});
