// App-wide toasts at the top of the screen, above every route: "You got paid" (from the
// notifications poller), coin deductions after a paid create / remix, game invites from friends
// ("@x invited you to Orb Duel · Join"), and short notes ("Invite expired"). One at a time; a new one
// replaces the current one. <ToastHost /> is mounted once in app/_layout.tsx.

import { Ionicons } from '@expo/vector-icons';
import { success as hapticSuccess } from './haptics';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { floating, ink, radius } from './theme';
import { EASE_OUT, PixelCoin, Txt, useReducedMotion, type IconName } from './ui';

export type Toast = {
  /**
   * paid = incoming coins (coin drops in and flips); charge = coins spent; invite = a friend's game
   * invite with an action pill ("Join"); info = a short note with an optional icon.
   */
  kind: 'paid' | 'charge' | 'invite' | 'info';
  title: string;
  /** Second line (paid) or text after the title (charge). */
  detail?: string;
  /** invite: the pill label (default "Join"). */
  action?: string;
  /** info: leading icon. */
  icon?: IconName;
  onPress?: () => void;
  /** ms on screen; default 4000 (paid) / 8000 (invite) / 2600 (charge, info). */
  duration?: number;
};

let current: (Toast & { key: number }) | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function showToast(t: Toast) {
  current = { ...t, key: ++seq };
  emit();
}

function hide(key: number) {
  if (current?.key !== key) return;
  current = null;
  emit();
}

export function ToastHost() {
  const t = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  if (!t) return null;
  return <ToastView key={t.key} toast={t} onDone={() => hide(t.key)} />;
}

function ToastView({ toast, onDone }: { toast: Toast & { key: number }; onDone: () => void }) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const enter = useRef(new Animated.Value(0)).current;
  const coinY = useRef(new Animated.Value(reduced ? 0 : -18)).current;
  const flip = useRef(new Animated.Value(0)).current;
  const paid = toast.kind === 'paid';
  const invite = toast.kind === 'invite';

  useEffect(() => {
    if (paid || invite) hapticSuccess();
    const duration = toast.duration ?? (paid ? 4000 : invite ? 8000 : 2600);
    const show = Animated.timing(enter, { toValue: 1, duration: reduced ? 0 : 260, easing: EASE_OUT, useNativeDriver: true });
    const out = Animated.timing(enter, { toValue: 0, duration: reduced ? 0 : 220, easing: Easing.in(Easing.quad), useNativeDriver: true });
    const coin =
      paid && !reduced
        ? Animated.parallel([
            Animated.spring(coinY, { toValue: 0, friction: 4, tension: 120, useNativeDriver: true }),
            Animated.timing(flip, { toValue: 2, duration: 900, easing: EASE_OUT, useNativeDriver: true }),
          ])
        : null;
    show.start();
    coin?.start();
    const timer = setTimeout(() => out.start(({ finished }) => finished && onDone()), duration);
    return () => {
      clearTimeout(timer);
      show.stop();
      out.stop();
      coin?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const translateY = enter.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] });
  // Two full turns around Y: the pixel coin "spins" as it lands.
  const rotateY = flip.interpolate({ inputRange: [0, 2], outputRange: ['0deg', '720deg'] });

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + 6 }]}>
      <Animated.View style={{ opacity: enter, transform: [{ translateY }] }}>
        <Pressable
          accessibilityRole={toast.onPress ? 'button' : undefined}
          accessibilityLiveRegion="polite"
          accessibilityLabel={[toast.title, toast.detail].filter(Boolean).join(', ')}
          disabled={!toast.onPress}
          onPress={() => {
            onDone();
            toast.onPress?.();
          }}
          style={[styles.toast, paid ? styles.paid : invite ? styles.invite : styles.charge]}
        >
          {invite ? (
            <>
              <View style={styles.coin}>
                <Ionicons name="game-controller" size={18} color={ink.accentFg} />
              </View>
              <Txt variant="heading" color={ink.accentFg} numberOfLines={2} style={styles.shrink}>
                {toast.title}
              </Txt>
              <View style={styles.action}>
                <Txt variant="label" color={ink.accentFg}>
                  {toast.action ?? 'Join'}
                </Txt>
              </View>
            </>
          ) : paid ? (
            <>
              <Animated.View style={[styles.coin, { transform: [{ translateY: coinY }, { perspective: 400 }, { rotateY }] }]}>
                <PixelCoin size={16} color={ink.accentFg} />
              </Animated.View>
              <View style={styles.text}>
                <Txt variant="heading" color={ink.accentFg} numberOfLines={1}>
                  {toast.title}
                </Txt>
                {!!toast.detail && (
                  <Txt variant="meta" color={ink.sky} numberOfLines={1}>
                    {toast.detail}
                  </Txt>
                )}
              </View>
            </>
          ) : (
            <>
              {toast.kind === 'info' ? (
                toast.icon ? <Ionicons name={toast.icon} size={15} color={ink.accentFg} /> : null
              ) : (
                <PixelCoin size={13} color={ink.accentFg} />
              )}
              <Txt variant="label" color={ink.accentFg} numberOfLines={1} style={styles.shrink}>
                {toast.title}
                {toast.detail ? ` · ${toast.detail}` : ''}
              </Txt>
            </>
          )}
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center', zIndex: 1000, elevation: 1000 },
  toast: { flexDirection: 'row', alignItems: 'center', backgroundColor: ink.navy, borderRadius: radius.pill, ...floating },
  paid: { gap: 10, paddingLeft: 8, paddingRight: 18, paddingVertical: 8, minWidth: 220 },
  charge: { gap: 7, paddingHorizontal: 14, paddingVertical: 9 },
  invite: { gap: 10, paddingLeft: 8, paddingRight: 8, paddingVertical: 8, minWidth: 240 },
  action: { paddingHorizontal: 14, height: 32, borderRadius: radius.pill, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
  coin: { width: 34, height: 34, borderRadius: 17, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
  text: { flexShrink: 1 },
  shrink: { flexShrink: 1 },
});
