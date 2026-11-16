import { useSyncExternalStore } from 'react';
import { Alert, Pressable, Share, StyleSheet, View, type AlertButton } from 'react-native';
import { floating, ink, radius } from './theme';
import { showToast } from './toast';
import { Button, Txt } from './ui';

// Web (PWA) stand-ins for native dialogs, installed when this module loads (app/_layout.tsx):
// - Alert.alert: react-native-web's is a no-op, so confirmations ("Sign out?") and menus would
//   silently do nothing. Here they show an in-app dialog (<DialogHost />), same buttons and order.
// - Share.share: the browser share sheet when there is one, else copy the link + "Link copied".

type Dialog = { key: number; title: string; message?: string; buttons: AlertButton[] };

let current: Dialog | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

function close(button?: AlertButton) {
  current = null;
  emit();
  button?.onPress?.();
}

Alert.alert = (title: string, message?: string, buttons?: AlertButton[]) => {
  current = { key: ++seq, title, message: message ?? undefined, buttons: buttons?.length ? buttons : [{ text: 'OK' }] };
  emit();
};

type ShareContent = { message?: string; url?: string; title?: string };

Share.share = (async (content: ShareContent) => {
  const url = content.url;
  const text = content.message;
  const nav = window.navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title: content.title, text, url });
      return { action: Share.sharedAction };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return { action: Share.dismissedAction };
      // Not allowed here (no user gesture, unsupported data): fall through to copying.
    }
  }
  try {
    await nav.clipboard.writeText(url ?? text ?? '');
    showToast({ kind: 'info', title: 'Link copied', icon: 'link-outline' });
    return { action: Share.sharedAction };
  } catch {
    showToast({ kind: 'info', title: url ?? text ?? 'Couldn’t share', icon: 'link-outline', duration: 6000 });
    return { action: Share.dismissedAction };
  }
}) as typeof Share.share;

export function DialogHost() {
  const d = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  if (!d) return null;
  const cancel = d.buttons.find((b) => b.style === 'cancel');
  const row = d.buttons.length <= 2;
  return (
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close" onPress={() => close(cancel)} />
      <View style={styles.card} accessibilityRole="alert">
        <Txt variant="heading" center>
          {d.title}
        </Txt>
        {!!d.message && (
          <Txt variant="body" muted center>
            {d.message}
          </Txt>
        )}
        <View style={[styles.actions, row ? styles.row : styles.column]}>
          {d.buttons.map((b, i) => (
            <Button
              key={`${d.key}-${i}`}
              label={b.text ?? 'OK'}
              size="md"
              variant={b.style === 'cancel' ? 'outline' : b.style === 'destructive' ? 'dark' : d.buttons.length > 2 ? 'outline' : 'solid'}
              style={[row && styles.flex, b.style === 'destructive' && styles.danger]}
              onPress={() => close(b)}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 1000, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: 'rgba(13,42,102,0.28)' },
  card: { width: '100%', maxWidth: 360, gap: 10, padding: 20, borderRadius: radius.xl, backgroundColor: ink.card, ...floating },
  actions: { gap: 8, marginTop: 8 },
  row: { flexDirection: 'row' },
  column: { flexDirection: 'column' },
  flex: { flex: 1 },
  danger: { backgroundColor: ink.danger },
});
