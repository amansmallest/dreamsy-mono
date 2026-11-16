import { Platform, useWindowDimensions } from 'react-native';

/** Running as the web app (PWA) rather than iOS / Android. */
export const isWeb = Platform.OS === 'web';
/** QR scanning needs the camera module; the web app hides the scan entry points. */
export const canScan = !isWeb;

/** Web on a wide screen shows the app in a phone column; keep in sync with public/index.html CSS. */
const COLUMN_BREAKPOINT = 560;
const COLUMN_WIDTH = 480;

/**
 * Window size as the app's screens see it: on iOS / Android the window; on a wide web window the
 * phone column (so cards and shelves size to the column, not the browser). The Play screen uses
 * useWindowDimensions directly: it takes the whole window.
 */
export function useAppDimensions() {
  const d = useWindowDimensions();
  if (!isWeb || d.width < COLUMN_BREAKPOINT) return d;
  return { ...d, width: Math.min(d.width, COLUMN_WIDTH) };
}
