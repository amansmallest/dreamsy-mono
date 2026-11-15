import type { ConfigContext, ExpoConfig } from 'expo/config';

// Native config is generated from this file (CNG). ios/ and android/ are not committed;
// run `npx expo prebuild --clean` (or `expo run:ios`) after changing anything here.

const bundleId = process.env.DREAMSY_IOS_BUNDLE_ID ?? 'com.dreamsy.app';
const androidPackage = process.env.DREAMSY_ANDROID_PACKAGE ?? bundleId;
// Expo push tokens need the EAS project id (`eas init` prints it). Without it src/push.ts skips push.
// EAS project (push tokens): created with `eas init` under the apxrvs-team account.
const easProjectId = process.env.EAS_PROJECT_ID ?? "4da22b8e-13c3-4cff-9880-6b9275245537";

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
    // Remote push (src/push.ts). Adds the iOS push entitlement; needs a fresh dev-client build.
    'expo-notifications',
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
  extra: {
    ...config.extra,
    ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
  },
  experiments: {
    typedRoutes: true,
  },
});
