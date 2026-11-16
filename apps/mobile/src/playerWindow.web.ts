import { useCallback, useEffect, useRef, useState } from 'react';
import type { Orientation } from './api';
import type { PlayerWindow } from './playerWindow';

// Web (PWA) player window.
// Laptop / desktop (mouse, wide window): every game leaves the phone column and gets the whole
// window (body.dreamsy-wide, public/index.html CSS); app/play/[id].tsx centers a player box at the
// game's aspect ratio and shows the keyboard hint.
// Landscape games:
// - on touch devices, go full screen and lock to landscape where the browser allows it (Android
//   Chrome). The Play tap's user activation usually still holds when this mounts; if not, the
//   Play screen shows a full-screen button. iPhone Safari has no Fullscreen API for pages, so it
//   gets a "turn your phone" hint while upright.
// Leaving the player exits full screen and unlocks.

type OrientationLockable = ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void };

const touch = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
const fullscreenEnabled = () => typeof document !== 'undefined' && !!document.fullscreenEnabled && !!document.documentElement.requestFullscreen;
const upright = () => window.innerHeight > window.innerWidth;
const isDesktop = () => typeof window !== 'undefined' && !touch() && window.innerWidth >= 700;

export function usePlayerWindow(orientation: Orientation | null): PlayerWindow {
  const landscape = orientation === 'landscape';
  const [isFullscreen, setIsFullscreen] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement);
  const [portraitView, setPortraitView] = useState(() => typeof window !== 'undefined' && upright());
  const entered = useRef(false);
  const [desktop, setDesktop] = useState(isDesktop);

  const enterFullscreen = useCallback(() => {
    if (!fullscreenEnabled() || document.fullscreenElement) return;
    document.documentElement
      .requestFullscreen({ navigationUI: 'hide' })
      .then(() => {
        entered.current = true;
        return (screen.orientation as OrientationLockable | undefined)?.lock?.('landscape');
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    const onResize = () => {
      setPortraitView(upright());
      setDesktop(isDesktop());
    };
    document.addEventListener('fullscreenchange', onFs);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const wide = landscape || desktop;
  useEffect(() => {
    if (!wide) return;
    document.body.classList.add('dreamsy-wide');
    return () => document.body.classList.remove('dreamsy-wide');
  }, [wide]);

  useEffect(() => {
    if (!landscape) return;
    if (touch()) enterFullscreen();
    return () => {
      try {
        (screen.orientation as OrientationLockable | undefined)?.unlock?.();
      } catch {}
      if (entered.current && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      entered.current = false;
    };
  }, [landscape, enterFullscreen]);

  return {
    canFullscreen: landscape && fullscreenEnabled() && !isFullscreen,
    enterFullscreen,
    rotateHint: landscape && touch() && !fullscreenEnabled() && portraitView,
    desktop,
  };
}
