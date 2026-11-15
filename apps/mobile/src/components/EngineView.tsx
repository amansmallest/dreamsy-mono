import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { apiBaseUrl } from '../api';
import { useAuth } from '../auth';
import { walletChanged } from '../wallet';

// The game player: a WebView running the engine-web page in embed mode, which loads the package
// for (gameId, version) from services/api and posts JSON messages back (see engine-web/dev/main.ts):
//   {type:"ready"} | {type:"error", message} | {type:"quit"} | {type:"purchase", itemId, balance}

// react-native-webview's types default P = undefined, and `WebViewProps & undefined` is never under
// current TS; instantiate with {} instead.
const Web = WebView<{}>;
type Web = WebView<{}>;

const ENGINE_BG = '#0d1117'; // engine-web page background, so loading doesn't flash white

export type Insets = { top: number; right: number; bottom: number; left: number };

export type EngineViewProps = {
  gameId: string;
  /** Safe-area insets (CSS px) for the engine's UI anchors / touch controls (§11.1). Full-screen only. */
  insets?: Insets;
  /** Version to play; must be >= 1. */
  version: number;
  style?: StyleProp<ViewStyle>;
  onReady?: () => void;
  onError?: (message: string) => void;
  /** Pause menu "Quit". */
  onQuit?: () => void;
  onPurchase?: (itemId: string, balance: number | null) => void;
};

/** Engine page URL, or null if EXPO_PUBLIC_ENGINE_URL / EXPO_PUBLIC_API_URL isn't set. */
export function engineUrl(gameId: string, version: number, token: string | null, insets?: Insets): string | null {
  const base = (process.env.EXPO_PUBLIC_ENGINE_URL ?? '').trim();
  if (!base || !apiBaseUrl) return null;
  const params: Record<string, string> = { api: apiBaseUrl, game: gameId, version: String(version), token: token ?? '', embed: '1' };
  if (insets) params.insets = [insets.top, insets.right, insets.bottom, insets.left].map((n) => Math.round(n)).join(',');
  const q = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}${base.includes('?') ? '&' : '?'}${q}`;
}

export function EngineView({ gameId, version, insets, style, onReady, onError, onQuit, onPurchase }: EngineViewProps) {
  const { getAccessToken } = useAuth();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const webview = useRef<Web>(null);

  // Latest callbacks without re-creating the message handler.
  const cb = useRef({ onReady, onError, onQuit, onPurchase });
  cb.current = { onReady, onError, onQuit, onPurchase };

  useEffect(() => {
    let cancelled = false;
    getAccessToken().then(
      (t) => !cancelled && setToken(t),
      () => !cancelled && setToken(null),
    );
    return () => {
      cancelled = true;
    };
  }, [getAccessToken]);

  const src = token === undefined ? null : engineUrl(gameId, version, token, insets);

  useEffect(() => {
    setReady(false);
    setFailed(false);
  }, [src]);

  const fail = (message: string) => {
    setFailed(true);
    cb.current.onError?.(message);
  };

  const onMessage = (e: WebViewMessageEvent) => {
    let msg: { type?: unknown; message?: unknown; itemId?: unknown; balance?: unknown };
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'ready':
        setReady(true);
        cb.current.onReady?.();
        break;
      case 'error':
        // Script errors arrive after "ready" and don't stop the game; load errors do.
        if (!ready) setFailed(true);
        cb.current.onError?.(typeof msg.message === 'string' ? msg.message : 'Game error');
        break;
      case 'quit':
        cb.current.onQuit?.();
        break;
      case 'purchase':
        walletChanged();
        cb.current.onPurchase?.(
          typeof msg.itemId === 'string' ? msg.itemId : '',
          typeof msg.balance === 'number' ? msg.balance : null,
        );
        break;
    }
  };

  if (token !== undefined && !src) {
    return (
      <View style={[styles.box, styles.center, style]}>
        <Text style={styles.note}>Set EXPO_PUBLIC_ENGINE_URL and EXPO_PUBLIC_API_URL to play games.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.box, style]}>
      {src && (
        <Web
          ref={webview}
          key={src}
          source={{ uri: src }}
          style={styles.webview}
          containerStyle={styles.webview}
          originWhitelist={['*']}
          onMessage={onMessage}
          onError={(e) => fail(`Couldn't open the engine: ${e.nativeEvent.description}`)}
          onHttpError={(e) => fail(`Engine page returned ${e.nativeEvent.statusCode}`)}
          // iOS kills the web content process under memory pressure; come back instead of a blank view.
          onContentProcessDidTerminate={() => webview.current?.reload()}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          allowsBackForwardNavigationGestures={false}
          allowsLinkPreview={false}
          setSupportMultipleWindows={false}
          // Don't set textInteractionEnabled={false}: on iOS it also blocks typing into the lobby code / name fields.
          // The engine page's CSS already prevents text selection in games.
          webviewDebuggingEnabled={__DEV__}
        />
      )}
      {!ready && !failed && (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <ActivityIndicator color="#8b949e" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: ENGINE_BG, overflow: 'hidden' },
  webview: { flex: 1, backgroundColor: ENGINE_BG },
  center: { alignItems: 'center', justifyContent: 'center', padding: 16 },
  note: { color: '#8b949e', fontSize: 13, textAlign: 'center' },
});
