// Guided first experience: a brand-new account (user.onboardedAt === null) lands straight in the
// onboarding game (GET /v1/onboarding, free first play) with a banner; when the first run ends (runEnd),
// they quit, or after 120 s, the Play screen swaps to the "Welcome to Dreamsy world" sheet
// (app/welcome.tsx), which marks onboarding done (POST /v1/me/onboarding).
//
// Older APIs: onboardedAt is missing (undefined) -> never runs. /v1/onboarding or /v1/live 404 -> skipped.

import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { api, ApiError, type User } from './api';
import { refreshLive, resetLive } from './live';
import { ink } from './theme';
import { EASE_OUT, PixelSky, PixelSparkle, Txt, useReducedMotion } from './ui';

/** Seconds of play before the welcome sheet shows anyway. */
export const ONBOARDING_FALLBACK_MS = 120_000;
export const ONBOARDING_BANNER = 'Your first Dreamsy game — made by AI. Swim as far as you can!';

/** Users whose first run was started (or skipped) this session: never twice. */
const handled = new Set<string>();
/** Users whose welcome sheet already marked onboarding done this session (even if the POST failed). */
const finished = new Set<string>();

const is404 = (e: unknown) => e instanceof ApiError && e.status === 404;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Fetches the onboarding game and warms Live now (so the welcome sheet opens with data), then opens
 * the player. Resolves false when skipped: either route 404s (older API), the game isn't published,
 * or the API is unreachable (tried again next launch).
 */
async function startFirstRun(): Promise<boolean> {
  const [game, live] = await Promise.allSettled([withTimeout(api.onboarding(), 8000), withTimeout(refreshLive(), 8000)]);
  if (game.status === 'rejected') {
    if (!is404(game.reason)) console.warn('[onboarding] skipped', game.reason);
    return false;
  }
  if (live.status === 'rejected' && is404(live.reason)) return false;
  const g = game.value;
  if (!g?.gameId || !(Number(g.version) > 0)) return false;
  router.push({ pathname: '/play/[id]', params: { id: g.gameId, version: String(g.version), onboarding: '1' } });
  return true;
}

/**
 * Root layout: starts the first run once for a new, fully set-up account. Returns true while it's
 * deciding (the layout shows <FirstRunCover /> so Home doesn't flash before the game opens).
 */
export function useFirstRun(user: User | null, enabled: boolean, skip: () => boolean): boolean {
  const [covering, setCovering] = useState(false);
  const userId = user?.id ?? null;
  const fresh = user?.onboardedAt === null;

  useEffect(() => {
    if (!userId) resetLive();
  }, [userId]);

  useEffect(() => {
    if (!enabled || !userId || !fresh || handled.has(userId) || finished.has(userId)) return;
    handled.add(userId);
    if (skip()) return;
    setCovering(true);
    let t: ReturnType<typeof setTimeout> | undefined;
    void startFirstRun()
      .catch(() => false)
      // Keep the cover until the player's fade-in has covered Home.
      .then((opened) => {
        t = setTimeout(() => setCovering(false), opened ? 700 : 0);
      });
    return () => {
      if (t) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userId, fresh]);

  return covering;
}

/** POST /v1/me/onboarding once per account; the returned user (onboardedAt set) goes to auth. */
export async function finishOnboarding(user: User | null, updateUser: (u: User) => void) {
  if (!user || finished.has(user.id)) return;
  finished.add(user.id);
  try {
    const r = await api.finishOnboarding();
    if (r?.user) updateUser(r.user);
  } catch (e) {
    // The server flag stays null; the next launch offers the game again. Fine for a rare failure.
    console.warn('[onboarding] could not mark done', e);
  }
}

/** Full-screen sky while the first game loads: "Getting your first game ready". */
export function FirstRunCover() {
  const reduced = useReducedMotion();
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.timing(enter, { toValue: 1, duration: reduced ? 0 : 320, easing: EASE_OUT, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [enter, reduced]);
  return (
    <View style={[StyleSheet.absoluteFill, styles.cover]} accessibilityLabel="Getting your first game ready">
      <PixelSky dense style={StyleSheet.absoluteFill} />
      <Animated.View
        style={[
          styles.coverInner,
          { opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [reduced ? 0 : 10, 0] }) }] },
        ]}
      >
        <PixelSparkle size={28} />
        <Txt variant="title" color={ink.navy} center>
          Getting your first game ready
        </Txt>
        <Txt variant="body" muted center>
          Someone typed an idea. AI built it.
        </Txt>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { backgroundColor: ink.wash, alignItems: 'center', justifyContent: 'center', zIndex: 900, elevation: 900 },
  coverInner: { alignItems: 'center', gap: 10, paddingHorizontal: 40 },
});
