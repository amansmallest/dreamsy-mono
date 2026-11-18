import type { StyleProp, ViewStyle } from 'react-native';
import { apiBaseUrl } from '../api';

// Shared by EngineView.tsx (react-native-webview, iOS/Android) and EngineView.web.tsx (iframe, PWA).

export const ENGINE_BG = '#141220'; // the web player's page background (engine/apps/player/shell.html), so loading doesn't flash white

export type RunEnd = {
  reason: 'finish' | 'submit' | 'gameover' | 'quit' | string;
  board?: string;
  value?: number;
  rank?: number;
};

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
  /** A run ended (game over, round finished, score submitted, match over). */
  onRunEnd?: (run: RunEnd) => void;
  /** Multiplayer room code to join straight away (skips the lobby menu). Ignored until the C++ engine has a
   * room client (DREAMSY.MD §14.10 E8); multiplayer games run solo meanwhile. */
  room?: string;
  /** With `room`: watch as a spectator (no avatar, no controls). Ignored until E8, like `room`. */
  spectate?: boolean;
};

export type RoomOpts = { room?: string; spectate?: boolean };

/** Engine page URL, or null if EXPO_PUBLIC_ENGINE_URL / EXPO_PUBLIC_API_URL isn't set. */
export function engineUrl(gameId: string, version: number, token: string | null, insets?: Insets, roomOpts: RoomOpts = {}): string | null {
  const base = (process.env.EXPO_PUBLIC_ENGINE_URL ?? '').trim();
  if (!base || !apiBaseUrl) return null;
  const params: Record<string, string> = { api: apiBaseUrl, game: gameId, version: String(version), token: token ?? '', embed: '1' };
  if (insets) params.insets = [insets.top, insets.right, insets.bottom, insets.left].map((n) => Math.round(n)).join(',');
  if (roomOpts.room) {
    params.room = roomOpts.room;
    if (roomOpts.spectate) params.spectate = '1';
  }
  const q = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}${base.includes('?') ? '&' : '?'}${q}`;
}
