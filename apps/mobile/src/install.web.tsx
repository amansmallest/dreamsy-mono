import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { floating, ink, radius } from './theme';
import { Button, IconButton, PixelSparkle, Txt } from './ui';

// Install the web app (PWA) on this device:
// - Chrome / Edge / Android: the browser's install prompt (`beforeinstallprompt`, captured early by
//   public/index.html into window.__dreamsyInstall and here), offered by a dismissible banner on Home
//   and an "Install Dreamsy" row on Profile.
// - iOS Safari: no prompt API, so a one-time sheet "tap Share → Add to Home Screen" the first time Home
//   is opened (and again from Profile).
// - Already installed (display-mode standalone / navigator.standalone): nothing.
// Home passes ready = first run done (user.onboardedAt set), so new players get their first game and
// the Welcome sheet before any install ask.

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type InstallWindow = Window & { __dreamsyInstall?: InstallPromptEvent | null };

const DISMISSED_KEY = 'dreamsy.install.dismissed';
const IOS_SHOWN_KEY = 'dreamsy.install.iosShown';

const read = (k: string) => {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    window.localStorage.setItem(k, v);
  } catch {}
};

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.matchMedia?.('(display-mode: fullscreen)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Safari on iPhone / iPad (iPadOS reports a Mac with touch). Other iOS browsers are left alone. */
const isIosSafari = () => {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);
};

type State = { prompt: InstallPromptEvent | null; installed: boolean; iosSheet: boolean; dismissed: boolean };
let state: State = {
  prompt: (window as InstallWindow).__dreamsyInstall ?? null,
  installed: isStandalone(),
  iosSheet: false,
  dismissed: read(DISMISSED_KEY) === '1',
};
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  set({ prompt: e as InstallPromptEvent });
});
window.addEventListener('appinstalled', () => set({ prompt: null, installed: true }));

function useInstallStore(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

async function install() {
  const p = state.prompt;
  if (p) {
    try {
      await p.prompt();
      const { outcome } = await p.userChoice;
      // A prompt event works once; Chrome fires a fresh one later if it's still installable.
      set({ prompt: null, installed: outcome === 'accepted' || state.installed });
    } catch {
      set({ prompt: null });
    }
    return;
  }
  if (isIosSafari()) set({ iosSheet: true });
}

export type InstallState = { canInstall: boolean; install: () => void };

export function useInstall(): InstallState {
  const s = useInstallStore();
  return { canInstall: !s.installed && (!!s.prompt || isIosSafari()), install: () => void install() };
}

export function InstallBanner({ ready }: { ready: boolean }) {
  const s = useInstallStore();
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  // iOS Safari: the sheet once per browser, a moment after Home appears.
  useEffect(() => {
    if (!ready || !focused || s.installed || !isIosSafari() || read(IOS_SHOWN_KEY)) return;
    const t = setTimeout(() => {
      write(IOS_SHOWN_KEY, '1');
      set({ iosSheet: true });
    }, 1200);
    return () => clearTimeout(t);
  }, [ready, focused, s.installed]);

  if (!ready || s.installed || !s.prompt || s.dismissed) return null;
  const dismiss = () => {
    write(DISMISSED_KEY, '1');
    set({ dismissed: true });
  };
  return (
    <View style={styles.banner} accessibilityRole="summary">
      <View style={styles.bannerIcon}>
        <PixelSparkle size={18} color={ink.accentFg} />
      </View>
      <View style={styles.flex}>
        <Txt variant="heading" color={ink.navy}>
          Install Dreamsy
        </Txt>
        <Txt variant="meta" muted numberOfLines={2}>
          Open it like an app, full screen.
        </Txt>
      </View>
      <Button label="Install" size="sm" onPress={() => void install()} />
      <Pressable accessibilityRole="button" accessibilityLabel="Not now" onPress={dismiss} hitSlop={10} style={styles.bannerClose}>
        <Ionicons name="close" size={18} color={ink.muted} />
      </Pressable>
    </View>
  );
}

/** The iOS "Add to Home Screen" sheet; mounted once in app/_layout.tsx. */
export function InstallHost() {
  const s = useInstallStore();
  const insets = useSafeAreaInsets();
  const close = () => set({ iosSheet: false });
  return (
    <Modal visible={s.iosSheet && !s.installed} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} accessibilityLabel="Close" onPress={close} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]} accessibilityViewIsModal>
        <View style={styles.sheetTop}>
          <Txt variant="title" color={ink.navy} style={styles.flex}>
            Add Dreamsy to your Home Screen
          </Txt>
          <IconButton icon="close" label="Close" size={36} onPress={close} />
        </View>
        <Txt variant="body" muted>
          It opens full screen like an app. No App Store needed.
        </Txt>
        <View style={styles.steps}>
          <Step n={1} icon="share-outline" text="Tap Share in Safari's toolbar" />
          <Step n={2} icon="add-circle-outline" text="Choose Add to Home Screen" />
        </View>
        {/* A tiny Safari toolbar with the Share button lit up. */}
        <View style={styles.toolbar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Ionicons name="chevron-back" size={20} color={ink.faint} />
          <Ionicons name="chevron-forward" size={20} color={ink.faint} />
          <View style={styles.toolbarShare}>
            <Ionicons name="share-outline" size={22} color={ink.accentFg} />
          </View>
          <Ionicons name="book-outline" size={20} color={ink.faint} />
          <Ionicons name="copy-outline" size={20} color={ink.faint} />
        </View>
        <Button label="Got it" size="md" variant="outline" onPress={close} />
      </View>
    </Modal>
  );
}

function Step({ n, icon, text }: { n: number; icon: 'share-outline' | 'add-circle-outline'; text: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepIcon}>
        <Ionicons name={icon} size={20} color={ink.accent} />
      </View>
      <Txt variant="heading" style={styles.flex}>
        {n}. {text}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 12,
    paddingRight: 8,
    borderRadius: radius.lg,
    backgroundColor: ink.wash,
  },
  bannerIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
  bannerClose: { padding: 4 },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(13,42,102,0.28)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxWidth: 480,
    alignSelf: 'center',
    width: '100%',
    gap: 12,
    padding: 20,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: ink.card,
    ...floating,
  },
  sheetTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  steps: { gap: 10, marginTop: 4 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepIcon: { width: 38, height: 38, borderRadius: 10, backgroundColor: ink.wash, alignItems: 'center', justifyContent: 'center' },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    height: 50,
    marginVertical: 4,
    borderRadius: radius.md,
    backgroundColor: ink.bg,
  },
  toolbarShare: { width: 44, height: 36, borderRadius: 10, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
});
