import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, ApiError } from '@/api';
import { useAuth } from '@/auth';
import { avatarFromSeed, type AvatarConfig } from '@/avatar';
import { AvatarHero, AvatarMaker } from '@/components/AvatarMaker';
import { errorMessage, ink } from '@/theme';
import { Button as InkButton, Field, Header, ProgressBar, Txt } from '@/ui';

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

/** First run after sign-in: pick a handle, then make an avatar. Saving the avatar finishes it. */
export default function OnboardingScreen() {
  const { user, updateUser, signOut } = useAuth();
  const [step, setStep] = useState<0 | 1>(0);
  const [handle, setHandle] = useState(() => (user && !user.handle.startsWith('dreamer_') ? user.handle : ''));
  const [avatar, setAvatar] = useState<AvatarConfig>(() => avatarFromSeed(user?.id ?? 'me'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;
  const h = handle.trim().toLowerCase();
  const valid = HANDLE_RE.test(h);

  const saveHandle = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (h !== user.handle) updateUser((await api.updateMe({ handle: h })).user);
      setStep(1);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? 'That handle is taken.' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveAvatar = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Root layout sees user.avatar and moves on to the app.
      updateUser((await api.updateMe({ avatar })).user);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <Header
        title={step === 0 ? 'Your name' : 'Your avatar'}
        subtitle={`step ${step + 1} of 2`}
        left={
          <Pressable accessibilityRole="button" hitSlop={10} onPress={() => (step === 1 ? setStep(0) : void signOut())}>
            <Txt variant="label" muted>
              {step === 1 ? 'Back' : 'Exit'}
            </Txt>
          </Pressable>
        }
      />
      <ProgressBar value={step === 0 ? 0.5 : 1} height={6} style={styles.progress} />

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {step === 0 ? (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <AvatarHero avatar={avatar} seed={user.id} size={170} />
            <Txt variant="title" center>
              What should players call you?
            </Txt>
            <Txt variant="body" muted center>
              Shown on every game you make.
            </Txt>
            <Field
              prefix="@"
              value={handle}
              onChangeText={(t) => setHandle(t.toLowerCase().replace(/\s+/g, '_'))}
              placeholder="dreamer"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              maxLength={20}
              returnKeyType="next"
              onSubmitEditing={saveHandle}
              style={styles.field}
            />
            <Txt variant="meta" color={error ? ink.danger : ink.muted} center>
              {error ?? (h && !valid ? '3–20 characters: a–z, 0–9 and _' : ' ')}
            </Txt>
          </ScrollView>
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            <AvatarMaker value={avatar} onChange={setAvatar} seed={user.id} />
            {error && (
              <Txt variant="meta" color={ink.danger} center>
                {error}
              </Txt>
            )}
          </ScrollView>
        )}

        <View style={styles.footer}>
          {step === 0 ? (
            <InkButton label="Next" sparkles disabled={!valid} busy={busy} onPress={saveHandle} />
          ) : (
            <InkButton label="That's me" sparkles busy={busy} onPress={saveAvatar} />
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.card },
  flex: { flex: 1 },
  progress: { marginHorizontal: 24 },
  body: { padding: 24, gap: 12, alignItems: 'center' },
  field: { alignSelf: 'stretch', marginTop: 8 },
  footer: { paddingHorizontal: 24, paddingBottom: 8 },
});
