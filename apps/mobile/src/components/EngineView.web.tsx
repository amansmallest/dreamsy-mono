import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth';
import { walletChanged } from '../wallet';
import { ENGINE_BG, engineUrl, type EngineViewProps } from './engineShared';

// Web (PWA) player: the same engine page and URL as the native WebView, in an <iframe>. The C++ web
// player posts its messages (ready / error / quit / runEnd) to window.parent as plain objects when it
// runs in an iframe (engine/apps/player/embed.js); only messages from this iframe's window and the
// engine's origin are handled.

export { engineUrl, type EngineViewProps, type Insets, type RoomOpts, type RunEnd } from './engineShared';

type EngineMsg = { type?: unknown; message?: unknown; itemId?: unknown; balance?: unknown; reason?: unknown; board?: unknown; value?: unknown; rank?: unknown };

const originOf = (url: string) => {
  try {
    return new URL(url, window.location.href).origin;
  } catch {
    return null;
  }
};

export function EngineView({ gameId, version, insets, style, onReady, onError, onQuit, onPurchase, onRunEnd, room, spectate }: EngineViewProps) {
  const { getAccessToken } = useAuth();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  // The engine reads the keyboard inside the iframe, so the iframe needs focus: on load and on a
  // click anywhere in the player (letterbox included). Full-screen player only (`insets`), so the
  // workspace preview doesn't pull focus out of the chat box when it reloads.
  const grabFocus = !!insets;
  const focusFrame = () => {
    const f = frame.current;
    if (!f) return;
    f.focus({ preventScroll: true });
    try {
      f.contentWindow?.focus();
    } catch {}
  };
  useEffect(() => {
    // Full-screen player: a click anywhere on the screen (letterbox too) gives the game the keys back,
    // unless it's on a text field. Inline preview: clicks in its own box only.
    const target: HTMLElement | Window | null | undefined = grabFocus ? window : frame.current?.parentElement;
    if (!target) return;
    const onDown = (e: Event) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable="true"]')) return;
      setTimeout(focusFrame, 0);
    };
    target.addEventListener('pointerdown', onDown);
    return () => target.removeEventListener('pointerdown', onDown);
  });

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
    readyRef.current = false;
    if (!src) return;
    const origin = originOf(src);
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || (origin && e.origin !== origin)) return;
      let msg: EngineMsg;
      if (typeof e.data === 'string') {
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
      } else if (e.data && typeof e.data === 'object') msg = e.data as EngineMsg;
      else return;
      switch (msg.type) {
        case 'ready':
          readyRef.current = true;
          setReady(true);
          if (grabFocus) focusFrame();
          cb.current.onReady?.();
          break;
        case 'error':
          // Script errors arrive after "ready" and don't stop the game; load errors do.
          if (!readyRef.current) setFailed(true);
          cb.current.onError?.(typeof msg.message === 'string' ? msg.message : 'Game error');
          break;
        case 'quit':
          cb.current.onQuit?.();
          break;
        case 'purchase':
          walletChanged();
          cb.current.onPurchase?.(typeof msg.itemId === 'string' ? msg.itemId : '', typeof msg.balance === 'number' ? msg.balance : null);
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
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [src, grabFocus]);

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
        <iframe
          ref={frame}
          key={src}
          src={src}
          title="Game"
          allow="autoplay; fullscreen; gamepad; clipboard-write"
          allowFullScreen
          tabIndex={0}
          onLoad={() => grabFocus && focusFrame()}
          onError={() => {
            setFailed(true);
            cb.current.onError?.("Couldn't open the engine");
          }}
          style={{ flex: 1, width: '100%', height: '100%', border: 0, display: 'block', backgroundColor: ENGINE_BG }}
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
  center: { alignItems: 'center', justifyContent: 'center', padding: 16 },
  note: { color: '#8b949e', fontSize: 13, textAlign: 'center' },
});
