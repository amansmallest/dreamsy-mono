import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '@/api';
import { useAuth } from '@/auth';
import { normalizeAvatar, type AvatarConfig } from '@/avatar';
import { AvatarMaker } from '@/components/AvatarMaker';
import { errorMessage, ink } from '@/theme';
import { Button as InkButton, Header, SquareButton, Txt } from '@/ui';

/** Edit avatar (modal from the profile). */
export default function AvatarScreen() {
  const { user, updateUser } = useAuth();
  const [avatar, setAvatar] = useState<AvatarConfig>(() => normalizeAvatar(user?.avatar, user?.id ?? 'me'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!user) return null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      updateUser((await api.updateMe({ avatar })).user);
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Header title="Avatar" subtitle={`@${user.handle}`} left={<SquareButton icon="close" label="Close" onPress={() => router.back()} />} style={styles.header} />
      <ScrollView contentContainerStyle={styles.body}>
        <AvatarMaker value={avatar} onChange={setAvatar} seed={user.id} />
        {error && (
          <Txt variant="meta" color={ink.danger} center>
            {error}
          </Txt>
        )}
      </ScrollView>
      <View style={styles.footer}>
        <InkButton label="Save" sparkles busy={busy} onPress={save} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.card },
  header: { paddingTop: 16 },
  body: { padding: 24 },
  footer: { paddingHorizontal: 24, paddingBottom: 8 },
});
