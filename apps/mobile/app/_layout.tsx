import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import { InterTight_700Bold, InterTight_800ExtraBold } from '@expo-google-fonts/inter-tight';
import { Silkscreen_400Regular } from '@expo-google-fonts/silkscreen';
import { useFonts } from 'expo-font';
import * as ScreenOrientation from 'expo-screen-orientation';
import { router, Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from '@/auth';
import { DialogHost } from '@/dialogs';
// Web: mouse drag scrolls horizontal shelves (src/mouseScroll.web.ts); nothing on iOS / Android.
import '@/mouseScroll';
import { hasPendingJoin, takePendingJoin } from '@/groups';
import { InstallHost } from '@/install';
import { useNotificationsPoller } from '@/notifications';
import { FirstRunCover, useFirstRun } from '@/onboarding';
import { installPushHandlers, openLaunchPush, registerPush } from '@/push';
import { font, ink } from '@/theme';
import { ToastHost } from '@/toast';

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
  headerTitleStyle: { fontFamily: font.displayBold, fontSize: 17, color: ink.fg },
};

function RootNavigator() {
  const { status, user } = useAuth();
  const [fontsLoaded, fontError] = useFonts({
    Silkscreen_400Regular,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    InterTight_700Bold,
    InterTight_800ExtraBold,
  });
  const ready = status !== 'loading' && (fontsLoaded || !!fontError);

  // Signed in without an avatar = onboarding not finished (handle + avatar).
  const onboarded = status === 'signedIn' && user.avatar != null;

  // A group invite opened while signed out / onboarding (app/join/[code].tsx): join once in the app.
  useEffect(() => {
    if (!ready || !onboarded) return;
    // Let the stack swap to the signed-in screens first.
    const t = setTimeout(() => {
      const code = takePendingJoin();
      if (code) router.push({ pathname: '/join/[code]', params: { code } });
    }, 300);
    return () => clearTimeout(t);
  }, [ready, onboarded]);

  // A brand-new account (onboardedAt null) goes straight into the onboarding game, then the Welcome
  // sheet (src/onboarding.tsx). An invite link waiting to be joined wins over it.
  const firstRunCover = useFirstRun(status === 'signedIn' ? user : null, ready && onboarded, hasPendingJoin);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  // Notifications: poll the unread count; push permission + token, and a push that launched the app.
  const signedInId = ready && onboarded ? user.id : null;
  useNotificationsPoller(!!signedInId);
  useEffect(() => installPushHandlers(), []);
  useEffect(() => {
    if (!signedInId) return;
    void registerPush();
    const t = setTimeout(() => void openLaunchPush(), 400);
    return () => clearTimeout(t);
  }, [signedInId]);

  if (!ready) return null;

  return (
    <>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: ink.bg } }}>
        <Stack.Protected guard={onboarded}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="game/[id]" options={pushed} />
          <Stack.Screen name="discover/[id]" options={pushed} />
          <Stack.Screen name="user/[id]" options={pushed} />
          <Stack.Screen name="groups/index" options={pushed} />
          <Stack.Screen name="groups/[id]" options={pushed} />
          <Stack.Screen name="notifications" options={pushed} />
          <Stack.Screen name="friends" options={pushed} />
          <Stack.Screen name="avatar" options={{ presentation: 'modal' }} />
          <Stack.Screen name="scan" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
          <Stack.Screen
            name="welcome"
            options={{ presentation: 'transparentModal', animation: 'none', gestureEnabled: false, contentStyle: { backgroundColor: 'transparent' } }}
          />
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
        {/* Invite links work in any auth state; the screen defers the join until signed in. */}
        <Stack.Screen name="join/[code]" options={{ animation: 'fade' }} />
      </Stack>
      {firstRunCover && <FirstRunCover />}
      <ToastHost />
      {/* Web only: in-app Alert dialogs (src/dialogs.web.tsx); renders nothing on iOS / Android. */}
      <DialogHost />
      {/* Web only: iOS "Add to Home Screen" sheet (src/install.web.tsx). */}
      <InstallHost />
    </>
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
