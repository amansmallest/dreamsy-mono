import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { api, ApiError } from '../api';
import { errorMessage, ink } from '../theme';
import { Button as InkButton, Chip, Field, Header, SquareButton, Txt } from '../ui';

const IDEAS = ['Same game, but in space', 'Make it a boss rush', 'Two times faster', 'Cozy version, no enemies', 'Spooky night edition'];

type Props = {
  visible: boolean;
  source: { id: string; name: string };
  onClose: () => void;
  /** After the copy exists (bump the source's spin-off count). */
  onCreated?: () => void;
};

/**
 * Spin-off = remix: copy the game to your drafts, optionally with a first change for Claude to make.
 * Lands in the workspace with that build already running.
 */
export function SpinOffSheet({ visible, source, onClose, onCreated }: Props) {
  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setIdea('');
    setError(null);
    setBusy(null);
  }, [visible]);

  const go = async (withIdea: boolean) => {
    if (busy) return;
    setError(null);
    try {
      setBusy('Copying…');
      const { game } = await api.remix(source.id);
      onCreated?.();
      const text = idea.trim();
      if (withIdea && text) {
        setBusy('Starting build…');
        await api.generate(game.id, { prompt: text }).catch((e) => {
          // The copy exists either way; a quota hit just means the user types it again later.
          if (!(e instanceof ApiError && e.status === 429)) throw e;
        });
      }
      onClose();
      router.push({ pathname: '/game/[id]', params: { id: game.id } });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.sheet} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Header title="Spin-off" subtitle={source.name} left={<SquareButton icon="close" label="Close" onPress={onClose} />} style={styles.header} />
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Txt variant="title">Make it yours</Txt>
          <Txt variant="body" muted>
            Your own copy. The original creator gets credit.
          </Txt>
          <Field value={idea} onChangeText={setIdea} multiline maxLength={2000} placeholder="What should be different?" />
          <View style={styles.ideas}>
            {IDEAS.map((i) => (
              <Chip key={i} label={i} icon="sparkles-outline" onPress={() => setIdea(i)} />
            ))}
          </View>
          {error && (
            <Txt variant="meta" color={ink.danger}>
              {error}
            </Txt>
          )}
        </ScrollView>
        <View style={styles.footer}>
          <InkButton label={busy ?? 'Spin it off'} icon="git-branch-outline" sparkles busy={!!busy} disabled={!idea.trim()} onPress={() => void go(true)} />
          <InkButton label="Just copy it" variant="outline" size="md" disabled={!!busy} onPress={() => void go(false)} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: ink.card },
  header: { paddingTop: 16 },
  body: { padding: 20, gap: 12 },
  ideas: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  footer: { padding: 20, paddingBottom: 36, gap: 10 },
});
