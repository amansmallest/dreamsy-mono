import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { api, type Group } from '@/api';
import { joinError, normalizeCode, shareInvite, useMyGroups } from '@/groups';
import { errorMessage, ink, radius } from '@/theme';
import { Badge, Button, Card, Field, Loading, PixelSparkle, Txt } from '@/ui';

/** Family & friends: my groups, start one, join one by code (DREAMSY.MD §13). */
export default function GroupsScreen() {
  const { groups, error, refresh } = useMyGroups();
  const [refreshing, setRefreshing] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const pull = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  const create = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy('create');
    setFormError(null);
    try {
      const { group, inviteCode } = await api.createGroup(n);
      setName('');
      router.push({ pathname: '/groups/[id]', params: { id: group.id } });
      void shareInvite(group, inviteCode);
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const join = async () => {
    const c = normalizeCode(code);
    if (c.length !== 8 || busy) return;
    setBusy('join');
    setFormError(null);
    try {
      const { group } = await api.joinGroup(c);
      setCode('');
      router.push({ pathname: '/groups/[id]', params: { id: group.id } });
    } catch (e) {
      setFormError(joinError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}>
      <Stack.Screen options={{ title: 'Family & friends' }} />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={ink.accent} />}
      >
        <View style={styles.intro}>
          <View style={styles.introIcon}>
            <Ionicons name="people" size={20} color={ink.accentFg} />
          </View>
          <View style={styles.flex}>
            <Txt variant="heading" color={ink.navy}>
              Play together
            </Txt>
            <Txt variant="meta" color={ink.navy}>
              Share games with your group (even unfinished ones) and race each other on your own leaderboards.
            </Txt>
          </View>
        </View>

        <Txt variant="pixel" style={styles.section}>
          Your groups
        </Txt>
        {groups === null ? (
          error ? (
            <Txt variant="meta" color={ink.danger}>
              {error}
            </Txt>
          ) : (
            <Loading style={{ marginTop: 8 }} />
          )
        ) : groups.length === 0 ? (
          <Txt variant="body" muted>
            No groups yet. Start one for your family, or join with a code.
          </Txt>
        ) : (
          groups.map((g) => <GroupRow key={g.id} group={g} />)
        )}

        <Txt variant="pixel" style={styles.section}>
          Start a group
        </Txt>
        <Field value={name} onChangeText={setName} placeholder="Our family" maxLength={60} returnKeyType="done" onSubmitEditing={() => void create()} />
        <Button label="Create and invite" icon="add" size="md" busy={busy === 'create'} disabled={!name.trim() || (!!busy && busy !== 'create')} onPress={() => void create()} />

        <Txt variant="pixel" style={styles.section}>
          Have a code?
        </Txt>
        <Field
          value={code}
          onChangeText={(t) => setCode(t.toUpperCase())}
          placeholder="ABCD2345"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={12}
          returnKeyType="go"
          onSubmitEditing={() => void join()}
        />
        <Button label="Join" icon="enter-outline" size="md" variant="outline" busy={busy === 'join'} disabled={normalizeCode(code).length !== 8 || (!!busy && busy !== 'join')} onPress={() => void join()} />

        {formError && (
          <Txt variant="meta" color={ink.danger} center>
            {formError}
          </Txt>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function GroupRow({ group }: { group: Group }) {
  return (
    <Card onPress={() => router.push({ pathname: '/groups/[id]', params: { id: group.id } })} style={styles.row} accessibilityLabel={group.name}>
      <View style={styles.rowIcon}>
        <PixelSparkle size={14} color={ink.navy} />
      </View>
      <View style={styles.flex}>
        <Txt variant="heading" numberOfLines={1}>
          {group.name}
        </Txt>
        <Txt variant="meta" muted>
          {group.memberCount === 1 ? 'Just you' : `${group.memberCount} people`}
        </Txt>
      </View>
      {group.role === 'owner' && <Badge label="Owner" />}
      <Ionicons name="chevron-forward" size={16} color={ink.faint} />
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.bg },
  content: { padding: 16, paddingBottom: 48, gap: 10 },
  intro: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: radius.lg, backgroundColor: ink.wash },
  introIcon: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
  section: { marginTop: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  rowIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: ink.wash, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
});
