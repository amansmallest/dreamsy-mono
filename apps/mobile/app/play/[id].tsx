import * as ScreenOrientation from 'expo-screen-orientation';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, orientationOf, type Orientation } from '@/api';
import { EngineView, type Insets } from '@/components/EngineView';
import { ink } from '@/theme';
import { Ionicons } from '@expo/vector-icons';

/**
 * Full-screen player. Params: id (game), version, orientation? ("portrait" | "landscape").
 * Locks to the game's orientation (§11.1); without the param it reads the version's manifest
 * (absent = landscape, pre-v1 games). The engine gets the safe-area insets once the rotation settles.
 */
export default function PlayScreen() {
  const params = useLocalSearchParams<{ id: string; version: string; orientation?: string }>();
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
      ) : insets ? (
        <EngineView gameId={id} version={v} insets={insets} style={styles.fill} onQuit={close} onError={setError} />
      ) : (
        <View style={[styles.fill, styles.center]}>
          <ActivityIndicator color="#8b949e" />
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close game"
        onPress={close}
        hitSlop={10}
        style={[styles.close, { top: chrome.top + 10, left: chrome.left + 12 }]}
      >
        <Ionicons name="close" size={20} color={ink.fg} />
      </Pressable>
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0d1117' },
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  note: { color: '#8b949e', fontSize: 15 },
  close: {
    position: 'absolute',
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: ink.card,
    borderWidth: 2,
    borderColor: ink.fg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  banner: { position: 'absolute', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: ink.danger, borderWidth: 2, borderColor: ink.fg },
  bannerText: { color: '#fff', fontSize: 12 },
});
