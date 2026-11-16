import * as ScreenOrientation from 'expo-screen-orientation';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, orientationOf, type Orientation } from '@/api';
import { EngineView, type Insets, type RunEnd } from '@/components/EngineView';
import { formatCoins, gatePlay, OutOfCoins, type Charge } from '@/coins';
import { ONBOARDING_BANNER, ONBOARDING_FALLBACK_MS } from '@/onboarding';
import { usePlayerWindow } from '@/playerWindow';
import { floating, ink, radius } from '@/theme';
import { PixelCoin, PixelSparkle, Txt, useReducedMotion } from '@/ui';
import { Ionicons } from '@expo/vector-icons';

/**
 * Full-screen player. Params: id (game), version, orientation? ("portrait" | "landscape").
 * Locks to the game's orientation (§11.1); without the param it reads the version's manifest
 * (absent = landscape, pre-v1 games). The engine gets the safe-area insets once the rotation settles.
 * Coins (§11.6): callers gate with POST /play first and pass `gated=1` (+ `charged`, `earned` for the
 * toast); opened any other way (workspace, links) this screen gates itself and shows "Out of coins" on 402.
 * Multiplayer: `room` (code) joins that room straight away; with `spectate=1` it watches instead, which
 * is free (no gate).
 * First run (`onboarding=1`, src/onboarding.tsx): a dismissible banner on top; the first runEnd, Quit,
 * the close button, or 120 s of play swap this screen for the Welcome sheet (app/welcome.tsx).
 */
export default function PlayScreen() {
  const params = useLocalSearchParams<{ id: string; version: string; orientation?: string; gated?: string; charged?: string; earned?: string; room?: string; spectate?: string; onboarding?: string }>();
  const { id } = params;
  const v = Number(params.version);
  const room = typeof params.room === 'string' && params.room ? params.room : undefined;
  const spectate = !!room && params.spectate === '1';
  const onboarding = params.onboarding === '1';
  const liveInsets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [error, setError] = useState<string | null>(null);

  const fromParam: Orientation | null =
    params.orientation === 'portrait' || params.orientation === 'landscape' ? params.orientation : null;
  const [orientation, setOrientation] = useState<Orientation | null>(fromParam);
  const [locked, setLocked] = useState(false);
  const [insets, setInsets] = useState<Insets | null>(null);
  // Web: landscape games go full screen (playerWindow.web.ts); a no-op in the native apps.
  const win = usePlayerWindow(orientation);

  const fromCaller: Charge | null =
    Number(params.charged) > 0 ? { price: Number(params.charged), earned: Number(params.earned) || 0 } : null;
  const [gate, setGate] = useState<'ok' | 'checking' | { balance: number; price: number }>(
    params.gated === '1' || spectate ? 'ok' : 'checking',
  );
  const [charge, setCharge] = useState<Charge | null>(fromCaller);

  useEffect(() => {
    if (gate !== 'checking' || !(v > 0)) return;
    let cancelled = false;
    void gatePlay(id).then((r) => {
      if (cancelled) return;
      if (r.kind === 'out') return setGate({ balance: r.balance, price: r.price });
      setCharge(r.charge);
      setGate('ok');
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, v]);

  // Orientation from the manifest when the caller didn't pass it.
  useEffect(() => {
    if (orientation || !(v > 0)) return;
    let cancelled = false;
    api.version(id, v).then(
      (r) => !cancelled && setOrientation(orientationOf(r.version.manifest)),
      () => !cancelled && setOrientation('landscape'),
    );
    return () => {
      cancelled = true;
    };
  }, [id, v, orientation]);

  useEffect(() => {
    if (!orientation) return;
    const lock =
      orientation === 'portrait' ? ScreenOrientation.OrientationLock.PORTRAIT_UP : ScreenOrientation.OrientationLock.LANDSCAPE;
    ScreenOrientation.lockAsync(lock)
      .catch(() => {})
      .finally(() => setLocked(true));
  }, [orientation]);

  useEffect(
    () => () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    },
    [],
  );

  // Snapshot the insets once the window matches the locked orientation (insets update a frame or
  // two after the rotation). Changing them later would reload the WebView, and the lock holds.
  const settled = locked && orientation !== null && (win.desktop || (orientation === 'landscape' ? width > height : height >= width));
  useEffect(() => {
    if (!settled || insets) return;
    const t = setTimeout(() => setInsets({ ...liveInsets }), 150);
    return () => clearTimeout(t);
  }, [settled, insets, liveInsets]);
  // Some devices refuse the lock (or report odd dimensions); don't wait forever.
  useEffect(() => {
    if (!locked || insets) return;
    const t = setTimeout(() => setInsets((cur) => cur ?? { ...liveInsets }), 1200);
    return () => clearTimeout(t);
  }, [locked, insets, liveInsets]);

  // ---------- first run: on to the Welcome sheet ----------
  const [banner, setBanner] = useState(onboarding);
  const welcomed = useRef(false);
  const welcomeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toWelcome = (run?: RunEnd) => {
    if (welcomed.current) return;
    welcomed.current = true;
    if (welcomeTimer.current) clearTimeout(welcomeTimer.current);
    const str = (n: number | undefined) => (typeof n === 'number' ? String(n) : undefined);
    const result = run && run.reason !== 'quit' ? { board: run.board, value: str(run.value), rank: str(run.rank) } : {};
    const clean = Object.fromEntries(Object.entries({ ...result, game: id }).filter(([, x]) => x !== undefined)) as Record<string, string>;
    router.replace({ pathname: '/welcome', params: clean });
  };
  /** Once: at most one pending hop, so a runEnd during the delay doesn't stack. */
  const welcomeIn = (ms: number, run?: RunEnd) => {
    if (welcomed.current || welcomeTimer.current) return;
    welcomeTimer.current = setTimeout(() => {
      welcomeTimer.current = null;
      toWelcome(run);
    }, ms);
  };
  const [engineReady, setEngineReady] = useState(false);
  // 120 s of play (from the first frame) is enough: show the welcome anyway.
  useEffect(() => {
    if (!onboarding || !engineReady) return;
    const t = setTimeout(() => toWelcome(), ONBOARDING_FALLBACK_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarding, engineReady]);
  useEffect(
    () => () => {
      if (welcomeTimer.current) clearTimeout(welcomeTimer.current);
    },
    [],
  );
  const onRunEnd = (run: RunEnd) => {
    if (!onboarding) return;
    // A beat to see the game-over screen; Quit goes straight on.
    if (run.reason === 'quit') toWelcome(run);
    else welcomeIn(1600, run);
  };
  const onEngineError = (message: string) => {
    setError(message);
    // The first game didn't load: don't strand a new player on an error, welcome them instead.
    if (onboarding && !engineReady) welcomeIn(2500);
  };

  const close = () => {
    if (onboarding) return toWelcome();
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  const chrome = insets ?? liveInsets;

  return (
    <View style={styles.screen}>
      <StatusBar hidden />
      {!(v > 0) ? (
        <View style={[styles.fill, styles.center]}>
          <Text style={styles.note}>Nothing to play yet.</Text>
        </View>
      ) : typeof gate === 'object' ? (
        <View style={[styles.fill, styles.center]}>
          <View style={styles.outCard}>
            <OutOfCoins balance={gate.balance} price={gate.price} onClose={close} />
          </View>
        </View>
      ) : insets && gate === 'ok' && win.desktop ? (
        // Desktop browser: the whole window, a centered player at the game's aspect ratio
        // (landscape fills the width), room for the keyboard hint below.
        <View style={[styles.fill, styles.center]}>
          <EngineView
            gameId={id}
            version={v}
            insets={insets}
            room={room}
            spectate={spectate}
            style={desktopStage(orientation, width, height)}
            onQuit={close}
            onError={onEngineError}
            onReady={() => setEngineReady(true)}
            onRunEnd={onRunEnd}
          />
        </View>
      ) : insets && gate === 'ok' ? (
        <EngineView
          gameId={id}
          version={v}
          insets={insets}
          room={room}
          spectate={spectate}
          style={styles.fill}
          onQuit={close}
          onError={onEngineError}
          onReady={() => setEngineReady(true)}
          onRunEnd={onRunEnd}
        />
      ) : (
        <View style={[styles.fill, styles.center]}>
          <ActivityIndicator color={ink.sky} />
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close game"
        onPress={close}
        hitSlop={10}
        style={[styles.close, { top: chrome.top + 10, left: chrome.left + 12 }]}
      >
        <Ionicons name="close" size={20} color={ink.accentFg} />
      </Pressable>
      {win.canFullscreen && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Full screen"
          onPress={win.enterFullscreen}
          hitSlop={10}
          style={[styles.close, { top: chrome.top + 10, left: chrome.left + 58 }]}
        >
          <Ionicons name="expand" size={18} color={ink.accentFg} />
        </Pressable>
      )}
      {win.desktop && gate === 'ok' && !spectate && (
        <View pointerEvents="none" style={styles.keysWrap}>
          <Text style={styles.keys} numberOfLines={1}>
            Arrows/WASD move · Space = A · X = B · C = C · Esc pause
          </Text>
        </View>
      )}
      {win.rotateHint && gate === 'ok' && (
        <View pointerEvents="none" style={[styles.toastWrap, { bottom: chrome.bottom + 16 }]}>
          <View style={styles.toast}>
            <Ionicons name="phone-landscape-outline" size={15} color={ink.accentFg} />
            <Txt variant="label" color={ink.accentFg} numberOfLines={1}>
              Turn your phone sideways
            </Txt>
          </View>
        </View>
      )}
      {banner && gate === 'ok' && (
        <FirstGameBanner top={chrome.top + 10} left={chrome.left + 60} right={chrome.right + 12} onDismiss={() => setBanner(false)} />
      )}
      {charge && gate === 'ok' && <ChargeToast charge={charge} top={chrome.top + 10} onDone={() => setCharge(null)} />}
      {error && (
        <Pressable
          onPress={() => setError(null)}
          style={[styles.banner, { bottom: chrome.bottom + 12, left: chrome.left + 12, right: chrome.right + 12 }]}
        >
          <Text style={styles.bannerText} numberOfLines={2}>
            {error}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const KEYS_ROW = 36;

/** Desktop player box: as large as the window allows at 16:9 / 9:16, keeping a row for the keys hint. */
function desktopStage(orientation: Orientation | null, width: number, height: number) {
  const ar = orientation === 'portrait' ? 9 / 16 : 16 / 9;
  const h = Math.max(200, height - KEYS_ROW * 2);
  const w = Math.min(width, h * ar);
  return { width: Math.floor(w), height: Math.floor(w / ar) };
}

/** First run: "Your first Dreamsy game — made by AI. Swim as far as you can!" Tap to dismiss; leaves on its own after 12 s. */
function FirstGameBanner({ top, left, right, onDismiss }: { top: number; left: number; right: number; onDismiss: () => void }) {
  const reduced = useReducedMotion();
  const enter = useRef(new Animated.Value(0)).current;
  const leaving = useRef(false);
  const dismiss = () => {
    if (leaving.current) return;
    leaving.current = true;
    Animated.timing(enter, { toValue: 0, duration: reduced ? 0 : 200, useNativeDriver: true }).start(() => onDismiss());
  };
  useEffect(() => {
    const show = reduced
      ? Animated.timing(enter, { toValue: 1, duration: 0, useNativeDriver: true })
      : Animated.spring(enter, { toValue: 1, friction: 7, tension: 70, useNativeDriver: true });
    // Let the game's first frame land before sliding in.
    const t1 = setTimeout(() => show.start(), 500);
    const t2 = setTimeout(dismiss, 12_000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      show.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const translateY = enter.interpolate({ inputRange: [0, 1], outputRange: [reduced ? 0 : -30, 0] });
  return (
    <Animated.View pointerEvents="box-none" style={[styles.firstWrap, { top, left, right, opacity: enter, transform: [{ translateY }] }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${ONBOARDING_BANNER} Dismiss`}
        accessibilityLiveRegion="polite"
        onPress={dismiss}
        style={styles.first}
      >
        <View style={styles.firstIcon}>
          <PixelSparkle size={14} color={ink.accentFg} />
        </View>
        <Txt variant="label" color={ink.accentFg} numberOfLines={2} style={styles.firstText}>
          {ONBOARDING_BANNER}
        </Txt>
        <Ionicons name="close" size={16} color={ink.sky} />
      </Pressable>
    </Animated.View>
  );
}

/** "−10K coins · creator earned 9K", fades in at the top, then out. */
function ChargeToast({ charge, top, onDone }: { charge: Charge; top: number; onDone: () => void }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.delay(3000),
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]);
    anim.start(({ finished }) => finished && onDone());
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Animated.View pointerEvents="none" style={[styles.toastWrap, { top, opacity }]}>
      <View style={styles.toast}>
        <PixelCoin size={13} color={ink.accentFg} />
        <Txt variant="label" color={ink.accentFg} numberOfLines={1}>
          {formatCoins(-charge.price, true)} · creator earned {formatCoins(charge.earned)}
        </Txt>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  firstWrap: { position: 'absolute', alignItems: 'center' },
  first: { flexDirection: 'row', alignItems: 'center', gap: 10, maxWidth: 440, paddingLeft: 6, paddingRight: 12, paddingVertical: 6, borderRadius: radius.lg, backgroundColor: 'rgba(13,42,102,0.92)', ...floating },
  firstIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
  firstText: { flexShrink: 1, lineHeight: 17 },
  outCard: { width: '86%', maxWidth: 380, borderRadius: radius.xl, backgroundColor: ink.card, ...floating },
  toastWrap: { position: 'absolute', left: 60, right: 60, alignItems: 'center' },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.pill, backgroundColor: ink.navy, ...floating },
  screen: { flex: 1, backgroundColor: '#0A1630' },
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  note: { color: ink.sky, fontSize: 15 },
  close: {
    position: 'absolute',
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(13,42,102,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keysWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, height: KEYS_ROW, alignItems: 'center', justifyContent: 'center' },
  keys: { color: 'rgba(168,203,245,0.75)', fontSize: 12, letterSpacing: 0.2 },
  banner: { position: 'absolute', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: ink.danger },
  bannerText: { color: '#fff', fontSize: 12 },
});
