import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, ApiError } from '@/api';
import { useAuth } from '@/auth';
import { gameIdFromScan } from '@/scanLink';
import { errorMessage, floating, ink, radius } from '@/theme';
import { Button as InkButton, Empty, Sparkle, SquareButton, Txt } from '@/ui';

const BOX = 250;

/**
 * Scan the dashboard's "Play on phone" QR (or any Dreamsy share QR) and open the game:
 * your own game opens in the workspace (drafts included), anyone else's on its game page.
 */
export default function ScanScreen() {
  const { user } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handling = useRef(false);
  const lastBad = useRef<string | null>(null);

  const onScan = async ({ data }: BarcodeScanningResult) => {
    if (handling.current || data === lastBad.current) return;
    const id = gameIdFromScan(data);
    if (!id) {
      lastBad.current = data;
      setError("That QR code isn't a Dreamsy game.");
      return;
    }
    handling.current = true;
    setError(null);
    setStatus('Opening game…');
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    try {
      const { game } = await api.game(id);
      const mine = !!user && game.ownerId === user.id;
      router.replace(mine ? { pathname: '/game/[id]', params: { id } } : { pathname: '/discover/[id]', params: { id } });
    } catch (e) {
      lastBad.current = data;
      setError(
        e instanceof ApiError && e.status === 404
          ? "Can't open this game. For a draft, sign in with your dashboard account."
          : errorMessage(e),
      );
      setStatus(null);
      handling.current = false;
    }
  };

  const close = <SquareButton icon="close" label="Close" onPress={() => router.back()} />;

  if (!permission) return <View style={styles.dark} />;

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.paper}>
        <View style={styles.topBar}>{close}</View>
        <Empty
          title="Camera needed"
          body="Only used to read QR codes."
          action={
            permission.canAskAgain ? (
              <InkButton label="Allow camera" icon="camera-outline" sparkles onPress={() => void requestPermission()} />
            ) : (
              <InkButton label="Open Settings" icon="settings-outline" onPress={() => void Linking.openSettings()} />
            )
          }
        />
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.dark}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={status ? undefined : onScan}
      />
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topBar}>{close}</View>
        <View style={styles.middle} pointerEvents="none">
          <View style={styles.box}>
            <Sparkle size={22} color={ink.accentFg} style={styles.sparkA} />
            <Sparkle size={14} color={ink.accentFg} style={styles.sparkB} />
          </View>
        </View>
        <View style={styles.panel}>
          <View style={styles.panelHead}>
            <Ionicons name="qr-code-outline" size={18} color={ink.accent} />
            <Txt variant="pixel">{status ?? 'Scan to play'}</Txt>
          </View>
          <Txt variant="body" muted>
            {error ?? 'Point at a Dreamsy QR code.'}
          </Txt>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  dark: { flex: 1, backgroundColor: '#000' },
  paper: { flex: 1, backgroundColor: ink.bg },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, justifyContent: 'space-between' },
  topBar: { paddingHorizontal: 20, paddingTop: 12, flexDirection: 'row' },
  middle: { alignItems: 'center' },
  box: { width: BOX, height: BOX, borderRadius: 32, borderWidth: 3, borderColor: ink.sky },
  sparkA: { position: 'absolute', top: -14, right: -12 },
  sparkB: { position: 'absolute', bottom: -10, left: -8 },
  panel: {
    margin: 20,
    padding: 16,
    gap: 6,
    backgroundColor: ink.card,
    borderRadius: radius.xl,
    ...floating,
  },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
