import type { ConfigContext, ExpoConfig } from 'expo/config';

// Native config is generated from this file (CNG). ios/ and android/ are not committed;
// run `npx expo prebuild --clean` (or `expo run:ios`) after changing anything here.

const bundleId = process.env.DREAMSY_IOS_BUNDLE_ID ?? 'com.dreamsy.app';
const androidPackage = process.env.DREAMSY_ANDROID_PACKAGE ?? bundleId;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Dreamsy',
  slug: 'dreamsy',
  scheme: 'dreamsy',
  version: '0.0.1',
  // All orientations at the native level so the Play screen can rotate; the app locks itself to
  // portrait at startup (app/_layout.tsx) and the Play screen unlocks while mounted.
  orientation: 'default',
  // The ink-on-paper design is light only.
  userInterfaceStyle: 'light',
  backgroundColor: '#F3EFE6',
  ios: {
    bundleIdentifier: bundleId,
    supportsTablet: false,
    usesAppleSignIn: true,
    // Group invite links https://dreamsy.dev/join/<code> open the app (app/join/[code].tsx). Needs
    // https://dreamsy.dev/.well-known/apple-app-site-association listing this app for /join/*.
    associatedDomains: ['applinks:dreamsy.dev'],
  },
  android: {
    package: androidPackage,
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: 'dreamsy.dev', pathPrefix: '/join/' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  plugins: [
    'expo-router',
    'expo-splash-screen',
    'expo-status-bar',
    'expo-secure-store',
    'expo-image',
    'expo-apple-authentication',
    // Google sign-in runs through Supabase OAuth in the system auth sheet (src/auth/supabase.ts).
    'expo-web-browser',
    [
      'expo-camera',
      {
        cameraPermission: 'Dreamsy uses the camera to scan QR codes for games from the dashboard and share links.',
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Dreamsy uses your photos as reference images for the games you create.',
        microphonePermission: false,
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
});
