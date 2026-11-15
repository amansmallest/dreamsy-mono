import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';
import { api, type Group } from '../api';
import { errorMessage, hairline, ink, radius } from '../theme';
import { Button, Empty, Header, Loading, PixelSparkle, SquareButton, Txt } from '../ui';

type Props = {
  visible: boolean;
  game: { id: string; name: string };
  onClose: () => void;
};

/** "Share with family": pick one of my groups, POST /v1/groups/:id/games (drafts too). */
export function ShareWithGroupSheet({ visible, game, onClose }: Props) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [shared, setShared] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!visible) return;
    setError(null);
    setShared(new Set());
    let cancelled = false;
    api.myGroups().then(
      (r) => !cancelled && setGroups(r.groups),
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const share = async (g: Group) => {
    if (busy) return;
    setBusy(g.id);
    setError(null);
    try {
      await api.shareWithGroup(g.id, game.id);
      setShared((s) => new Set(s).add(g.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const manage = () => {
    onClose();
    router.push('/groups');
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <Header title="Share with family" subtitle={game.name} left={<SquareButton icon="close" label="Close" onPress={onClose} />} style={styles.header} />
        <ScrollView contentContainerStyle={styles.body}>
          <Txt variant="body" muted>
            Everyone in the group can play it, even if it isn’t published, and race on the group leaderboard.
          </Txt>
          {groups === null ? (
            error ? null : <Loading />
          ) : groups.length === 0 ? (
            <Empty title="No groups yet" body="Start one for your family or friends, then share games with it." action={<Button label="Start a group" icon="people-outline" size="md" onPress={manage} />} />
          ) : (
            <View style={styles.list}>
              {groups.map((g, i) => {
                const done = shared.has(g.id);
                return (
                  <View key={g.id} style={[styles.row, i < groups.length - 1 && styles.line]}>
                    <View style={styles.icon}>
                      <PixelSparkle size={13} color={ink.navy} />
                    </View>
                    <View style={styles.flex}>
                      <Txt variant="heading" numberOfLines={1}>
                        {g.name}
                      </Txt>
                      <Txt variant="meta" muted>
                        {g.memberCount === 1 ? 'Just you' : `${g.memberCount} people`}
                      </Txt>
                    </View>
                    {done ? (
                      <View style={styles.done}>
                        <Ionicons name="checkmark" size={16} color={ink.ok} />
                        <Txt variant="label" color={ink.ok}>
                          Shared
                        </Txt>
                      </View>
                    ) : (
                      <Button label="Share" size="sm" busy={busy === g.id} disabled={!!busy && busy !== g.id} onPress={() => void share(g)} />
                    )}
                  </View>
                );
              })}
            </View>
          )}
          {error && (
            <Txt variant="meta" color={ink.danger}>
              {error}
            </Txt>
          )}
        </ScrollView>
        {!!groups?.length && (
          <View style={styles.footer}>
            <Button label="Manage groups" variant="outline" size="md" onPress={manage} />
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: ink.card },
  header: { paddingTop: 16 },
  body: { padding: 20, gap: 14 },
  list: { borderRadius: radius.lg, borderWidth: hairline, borderColor: ink.border, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  line: { borderBottomWidth: hairline, borderBottomColor: ink.border },
  icon: { width: 34, height: 34, borderRadius: 17, backgroundColor: ink.wash, alignItems: 'center', justifyContent: 'center' },
  done: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  footer: { padding: 20, paddingBottom: 36 },
  flex: { flex: 1 },
});
