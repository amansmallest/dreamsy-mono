import { Silkscreen_400Regular, Silkscreen_700Bold } from '@expo-google-fonts/silkscreen';
import {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';
import { useFonts } from 'expo-font';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from '@/auth';
import { font, ink } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});
// The app is portrait; only the Play screen rotates (to the game's orientation) (app.config allows all orientations).
ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});

const pushed = {
  headerShown: true,
  title: '',
  headerBackTitle: 'Back',
  headerBackButtonDisplayMode: 'minimal' as const,
  headerTintColor: ink.fg,
  headerShadowVisible: false,
  headerStyle: { backgroundColor: ink.bg },
  headerTitleStyle: { fontFamily: font.pixelBold, fontSize: 14, color: ink.fg },
};

function RootNavigator() {
  const { status, user } = useAuth();
  const [fontsLoaded, fontError] = useFonts({
    Silkscreen_400Regular,
    Silkscreen_700Bold,
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
  });
  const ready = status !== 'loading' && (fontsLoaded || !!fontError);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  if (!ready) return null;

  // Signed in without an avatar = onboarding not finished (handle + avatar).
  const onboarded = status === 'signedIn' && user.avatar != null;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: ink.bg } }}>
      <Stack.Protected guard={onboarded}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="game/[id]" options={pushed} />
        <Stack.Screen name="discover/[id]" options={pushed} />
        <Stack.Screen name="user/[id]" options={pushed} />
        <Stack.Screen name="avatar" options={{ presentation: 'modal' }} />
        <Stack.Screen
          name="play/[id]"
          options={{ presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }}
        />
      </Stack.Protected>
      <Stack.Protected guard={status === 'signedIn' && !onboarded}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'signedOut'}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Screen name="auth-callback" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <RootNavigator />
    </AuthProvider>
  );
}
