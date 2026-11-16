import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useAuth } from '../auth';
import { walletChanged } from '../wallet';
import { ENGINE_BG, engineUrl, type EngineViewProps } from './engineShared';

// The game player: a WebView running the engine-web page in embed mode, which loads the package
// for (gameId, version) from services/api and posts JSON messages back (see engine-web/dev/main.ts):
//   {type:"ready"} | {type:"error", message} | {type:"quit"} | {type:"purchase", itemId, balance}
//   | {type:"runEnd", reason, board?, value?, rank?} (a run finished: leaderboard finish/submit, the
//     script's platform.runEnded(), or a multiplayer match ended; at most one per 3 s)

// react-native-webview's types default P = undefined, and `WebViewProps & undefined` is never under
// current TS; instantiate with {} instead.
const Web = WebView<{}>;
type Web = WebView<{}>;

export { engineUrl, type EngineViewProps, type Insets, type RoomOpts, type RunEnd } from './engineShared';

export function EngineView({ gameId, version, insets, style, onReady, onError, onQuit, onPurchase, onRunEnd, room, spectate }: EngineViewProps) {
  const { getAccessToken } = useAuth();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const webview = useRef<Web>(null);

  // Latest callbacks without re-creating the message handler.
  const cb = useRef({ onReady, onError, onQuit, onPurchase, onRunEnd });
  cb.current = { onReady, onError, onQuit, onPurchase, onRunEnd };

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

  const src = token === undefined ? null : engineUrl(gameId, version, token, insets, { room, spectate });

  useEffect(() => {
    setReady(false);
    setFailed(false);
  }, [src]);

  const fail = (message: string) => {
    setFailed(true);
    cb.current.onError?.(message);
  };

  const onMessage = (e: WebViewMessageEvent) => {
    let msg: { type?: unknown; message?: unknown; itemId?: unknown; balance?: unknown; reason?: unknown; board?: unknown; value?: unknown; rank?: unknown };
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
      case 'runEnd': {
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
        cb.current.onRunEnd?.({
          reason: typeof msg.reason === 'string' ? msg.reason : 'gameover',
          board: typeof msg.board === 'string' ? msg.board : undefined,
          value: num(msg.value),
          rank: num(msg.rank),
        });
        break;
      }
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
