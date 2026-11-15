import { Redirect, router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { joinError, normalizeCode, setPendingJoin } from '@/groups';
import { ink } from '@/theme';
import { Button, Empty, Loading, Txt } from '@/ui';

/**
 * Group invite link: dreamsy://join/<code> or https://dreamsy.dev/join/<code>. Signed in (and
 * onboarded): join, then open the group. Otherwise the code waits until the user lands in the app
 * (app/_layout.tsx picks it up with takePendingJoin()).
 */
export default function JoinScreen() {
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = normalizeCode(raw ?? '');
  const { status, user } = useAuth();
  const ready = status === 'signedIn' && user.avatar != null;
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!ready || started.current || !code) return;
    started.current = true;
    api.joinGroup(code).then(
      ({ group }) => {
        const open = { pathname: '/groups/[id]', params: { id: group.id } } as const;
        if (router.canGoBack()) return router.replace(open);
        // Opened cold from the link: put Home underneath so Back has somewhere to go.
        router.replace('/');
        setTimeout(() => router.push(open), 0);
      },
      (e) => setError(joinError(e)),
    );
  }, [ready, code]);

  if (status === 'loading') return null;
  if (!ready) {
    if (code) setPendingJoin(code);
    return <Redirect href={status === 'signedOut' ? '/sign-in' : '/onboarding'} />;
  }

  const home = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <SafeAreaView style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.center}>
        {error || !code ? (
          <Empty
            title="Couldn’t join"
            body={error ?? 'This invite link is missing its code.'}
            action={<Button label="Go home" size="sm" variant="outline" onPress={home} />}
          />
        ) : (
          <>
            <Loading />
            <Txt variant="meta" muted center style={styles.note}>
              Joining…
            </Txt>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  note: { marginTop: 10 },
});
