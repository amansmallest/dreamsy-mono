import type { Orientation } from './api';

// The Play screen's hooks into the window. Native apps rotate with expo-screen-orientation and
// need nothing here; the web app (playerWindow.web.ts) goes full screen for landscape games.

export type PlayerWindow = {
  /** The browser can go full screen and the player isn't. */
  canFullscreen: boolean;
  enterFullscreen: () => void;
  /** Landscape game on a phone held upright, where the page can't rotate itself. */
  rotateHint: boolean;
  /** Laptop / desktop browser (mouse, wide window): big centered player + keyboard hint. */
  desktop: boolean;
};

export function usePlayerWindow(_orientation: Orientation | null): PlayerWindow {
  return { canFullscreen: false, enterFullscreen: () => {}, rotateHint: false, desktop: false };
}
