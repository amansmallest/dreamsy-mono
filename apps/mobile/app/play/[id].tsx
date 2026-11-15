import * as ScreenOrientation from 'expo-screen-orientation';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, orientationOf, type Orientation } from '@/api';
import { EngineView, type Insets } from '@/components/EngineView';
import { formatCoins, gatePlay, OutOfCoins, type Charge } from '@/coins';
import { floating, ink, radius } from '@/theme';
import { PixelCoin, Txt } from '@/ui';
import { Ionicons } from '@expo/vector-icons';

/**
 * Full-screen player. Params: id (game), version, orientation? ("portrait" | "landscape").
 * Locks to the game's orientation (§11.1); without the param it reads the version's manifest
 * (absent = landscape, pre-v1 games). The engine gets the safe-area insets once the rotation settles.
 * Coins (§11.6): callers gate with POST /play first and pass `gated=1` (+ `charged`, `earned` for the
 * toast); opened any other way (workspace, links) this screen gates itself and shows "Out of coins" on 402.
 */
export default function PlayScreen() {
  const params = useLocalSearchParams<{ id: string; version: string; orientation?: string; gated?: string; charged?: string; earned?: string }>();
  const { id } = params;
  const v = Number(params.version);
  const liveInsets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [error, setError] = useState<string | null>(null);

  const fromParam: Orientation | null =
    params.orientation === 'portrait' || params.orientation === 'landscape' ? params.orientation : null;
  const [orientation, setOrientation] = useState<Orientation | null>(fromParam);
  const [locked, setLocked] = useState(false);
  const [insets, setInsets] = useState<Insets | null>(null);

  const fromCaller: Charge | null =
    Number(params.charged) > 0 ? { price: Number(params.charged), earned: Number(params.earned) || 0 } : null;
  const [gate, setGate] = useState<'ok' | 'checking' | { balance: number; price: number }>(params.gated === '1' ? 'ok' : 'checking');
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
  const settled = locked && orientation !== null && (orientation === 'landscape' ? width > height : height >= width);
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

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
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
      ) : insets && gate === 'ok' ? (
        <EngineView gameId={id} version={v} insets={insets} style={styles.fill} onQuit={close} onError={setError} />
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
  banner: { position: 'absolute', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: ink.danger },
  bannerText: { color: '#fff', fontSize: 12 },
});
