import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { isAppleSignInAvailable, isSupabaseConfigured, SignInCancelled, useAuth } from '@/auth';
import { AvatarHero } from '@/components/AvatarMaker';
import { hairline, ink } from '@/theme';
import { Button as InkButton, Field, PixelSky, Sparkle, Txt } from '@/ui';

type Busy = 'send' | 'verify' | 'google' | 'apple' | 'guest';

const KNIGHT = { hat: 1, head: 0, eyes: 0, mouth: 0, extra: 3, body: 0 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_SECONDS = 60;

/** Default: email + one-time code (Supabase). Google / Apple / guest below. */
export default function SignInScreen() {
  const { sendEmailCode, signInWithEmailCode, signInWithGoogle, signInWithApple, continueAsGuest } = useAuth();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'ios') isAppleSignInAvailable().then(setAppleAvailable);
  }, []);
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const run = async (what: Busy, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof SignInCancelled)) setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const address = email.trim().toLowerCase();
  const send = () =>
    run('send', async () => {
      await sendEmailCode(address);
      setSentTo(address);
      setCode('');
      setResendIn(RESEND_SECONDS);
    });
  const verify = (value = code) =>
    run('verify', async () => {
      if (sentTo) await signInWithEmailCode(sentTo, value.trim());
    });
  const onCode = (t: string) => {
    const digits = t.replace(/\D/g, '').slice(0, 10);
    setCode(digits);
    // Supabase sends 6 digits by default (configurable up to 10); submit when a full 6-digit code lands.
    if (digits.length === 6 && !busy) void verify(digits);
  };

  return (
    <SafeAreaView style={styles.screen}>
      <PixelSky dense style={styles.sky} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.top}>
            <Sparkle size={14} color={ink.navy} />
            <Txt variant="title" color={ink.navy} style={styles.logo}>
              dreamsy
            </Txt>
          </View>

          <View style={styles.hero}>
            <AvatarHero avatar={KNIGHT} seed="dreamsy" size={sentTo ? 150 : 200} />
            <Txt variant="display" center style={styles.title}>
              {sentTo ? 'Check your email' : 'Dream it.\nPlay it.'}
            </Txt>
            <Txt variant="body" muted center style={styles.subtitle}>
              {sentTo
                ? `Code sent to ${sentTo}.`
                : 'Describe a game. Dreamsy builds it.'}
            </Txt>
          </View>

          {!isSupabaseConfigured ? null : sentTo ? (
            <View style={styles.form}>
              <Field
                value={code}
                onChangeText={onCode}
                placeholder="123456"
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                autoFocus
                maxLength={10}
                style={styles.code}
              />
              <InkButton label="Sign in" sparkles busy={busy === 'verify'} disabled={code.length < 6 || (!!busy && busy !== 'verify')} onPress={() => void verify()} />
              <View style={styles.row}>
                <Pressable hitSlop={8} onPress={() => setSentTo(null)} disabled={!!busy}>
                  <Txt variant="label" muted>
                    Different email
                  </Txt>
                </Pressable>
                <Pressable hitSlop={8} onPress={() => void send()} disabled={!!busy || resendIn > 0}>
                  <Txt variant="label" color={resendIn > 0 ? ink.muted : ink.accent}>
                    {busy === 'send' ? 'Sending…' : resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                  </Txt>
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={styles.form}>
              <Field
                value={email}
                onChangeText={setEmail}
                placeholder="you@email.com"
                keyboardType="email-address"
                textContentType="emailAddress"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="send"
                onSubmitEditing={() => EMAIL_RE.test(address) && void send()}
              />
              <InkButton
                label="Email me a code"
                icon="mail-outline"
                sparkles
                busy={busy === 'send'}
                disabled={!EMAIL_RE.test(address) || (!!busy && busy !== 'send')}
                onPress={() => void send()}
              />
              <View style={styles.or}>
                <View style={styles.orLine} />
                <Txt variant="label" muted>
                  or
                </Txt>
                <View style={styles.orLine} />
              </View>
              <InkButton
                label="Continue with Google"
                icon="logo-google"
                variant="outline"
                size="md"
                busy={busy === 'google'}
                disabled={!!busy && busy !== 'google'}
                onPress={() => void run('google', signInWithGoogle)}
              />
              {appleAvailable && (
                <InkButton
                  label="Continue with Apple"
                  icon="logo-apple"
                  variant="outline"
                  size="md"
                  busy={busy === 'apple'}
                  disabled={!!busy && busy !== 'apple'}
                  onPress={() => void run('apple', signInWithApple)}
                />
              )}
            </View>
          )}

          {error && (
            <Txt variant="meta" color={ink.danger} center style={styles.error}>
              {error}
            </Txt>
          )}

          {!sentTo && (
            <Pressable
              accessibilityRole="button"
              onPress={() => void run('guest', continueAsGuest)}
              disabled={!!busy}
              hitSlop={8}
              style={({ pressed }) => [styles.guest, { opacity: pressed || busy ? 0.5 : 1 }]}
            >
              <Txt variant="label" muted>
                {busy === 'guest' ? 'One sec…' : 'Look around first'}
              </Txt>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.card },
  sky: { position: 'absolute', top: 0, left: 0, right: 0, height: '52%' },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 12 },
  top: { paddingTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  logo: { fontSize: 22 },
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 16 },
  title: { fontSize: 38, lineHeight: 42, marginTop: 4, color: ink.navy },
  subtitle: { maxWidth: 320 },
  form: { gap: 12 },
  code: { minHeight: 58 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4, paddingTop: 2 },
  or: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 2 },
  orLine: { flex: 1, height: hairline, backgroundColor: ink.border },
  error: { marginTop: 12 },
  guest: { height: 44, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
});
