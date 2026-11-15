import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { api, ApiError, playableVersion, type Group, type GroupMember, type SharedGame } from '@/api';
import { useAuth } from '@/auth';
import { Avatar } from '@/components/Avatar';
import { Thumbnail } from '@/components/Thumbnail';
import { shareInvite } from '@/groups';
import { timeAgo } from '@/social';
import { errorMessage, font, hairline, ink, radius } from '@/theme';
import { Badge, Button, Empty, Loading, Txt } from '@/ui';

/** One group: invite code, members, games shared with it; leave / delete / new code. */
export default function GroupScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [games, setGames] = useState<SharedGame[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [g, s] = await Promise.all([api.group(id), api.groupGames(id)]);
      setGroup(g.group);
      setMembers(g.members);
      setGames(s.games);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'You’re not in this group (any more).' : errorMessage(e));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const pull = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (!group) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: '' }} />
        {error ? <Empty title="Can't open this group" body={error} action={<Button label="Try again" size="sm" variant="outline" onPress={load} />} /> : <Loading />}
      </View>
    );
  }

  const isOwner = group.ownerId === user?.id;

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      after?.();
    } catch (e) {
      Alert.alert('Something went wrong', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const newCode = () =>
    Alert.alert('Make a new invite code?', 'The old link and code stop working. People already in the group stay.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'New code',
        onPress: () =>
          void act(async () => {
            const { inviteCode } = await api.newInviteCode(group.id);
            setGroup((g) => g && { ...g, inviteCode });
          }),
      },
    ]);

  const leave = () =>
    Alert.alert(
      `Leave ${group.name}?`,
      isOwner && group.memberCount > 1 ? 'The person who’s been here longest becomes the owner.' : group.memberCount <= 1 ? 'You’re the last one here, so the group goes away.' : undefined,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: () => void act(() => api.leaveGroup(group.id), () => router.back()) },
      ],
    );

  const remove = () =>
    Alert.alert(`Delete ${group.name}?`, 'Everyone is removed and shared games are unshared. Games themselves aren’t deleted.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void act(() => api.deleteGroup(group.id), () => router.back()) },
    ]);

  const play = (g: SharedGame) => {
    const version = playableVersion(g);
    if (!version) return;
    router.push({ pathname: '/play/[id]', params: { id: g.id, version: String(version), ...(g.orientation ? { orientation: g.orientation } : {}) } });
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={ink.accent} />}>
      <Stack.Screen options={{ title: group.name }} />

      <View style={styles.invite}>
        <Txt variant="badge" color={ink.navy}>
          Invite code
        </Txt>
        <Txt selectable style={styles.code}>
          {group.inviteCode}
        </Txt>
        <Txt variant="meta" color={ink.navy} center>
          Anyone with the link or code can join.
        </Txt>
        <View style={styles.inviteActions}>
          <Button label="Invite" icon="share-outline" size="sm" onPress={() => void shareInvite(group, group.inviteCode)} />
          {isOwner && <Button label="New code" icon="refresh" size="sm" variant="outline" disabled={busy} onPress={newCode} />}
        </View>
      </View>

      <Txt variant="pixel" style={styles.section}>
        Games
      </Txt>
      {games === null ? (
        <Loading style={{ marginTop: 8 }} />
      ) : games.length === 0 ? (
        <Txt variant="body" muted>
          Nothing shared yet. Open a game and tap “Family” to share it here.
        </Txt>
      ) : (
        <View style={styles.list}>
          {games.map((g, i) => (
            <SharedRow key={g.id} game={g} last={i === games.length - 1} onPlay={() => play(g)} />
          ))}
        </View>
      )}

      <Txt variant="pixel" style={styles.section}>
        People · {members.length}
      </Txt>
      <View style={styles.list}>
        {members.map((m, i) => (
          <Pressable
            key={m.user.id}
            onPress={() => router.push({ pathname: '/user/[id]', params: { id: m.user.id } })}
            style={[styles.member, i < members.length - 1 && styles.line]}
          >
            <Avatar user={m.user} size={34} />
            <Txt variant="heading" numberOfLines={1} style={styles.flex}>
              @{m.user.handle}
              {m.user.id === user?.id ? (
                <Txt variant="meta" muted>
                  {'  '}you
                </Txt>
              ) : null}
            </Txt>
            {m.role === 'owner' && <Badge label="Owner" />}
          </Pressable>
        ))}
      </View>

      <View style={styles.danger}>
        <Button label="Leave group" icon="exit-outline" size="md" variant="outline" disabled={busy} onPress={leave} />
        {isOwner && <Button label="Delete group" icon="trash-outline" size="md" variant="ghost" disabled={busy} onPress={remove} />}
      </View>
    </ScrollView>
  );
}

function SharedRow({ game, last, onPlay }: { game: SharedGame; last: boolean; onPlay: () => void }) {
  const draft = !game.publishedVersion;
  const canPlay = !!playableVersion(game);
  return (
    <Pressable onPress={() => router.push({ pathname: '/discover/[id]', params: { id: game.id } })} style={[styles.game, !last && styles.line]}>
      <Thumbnail url={game.thumbnailUrl} seed={game.id} name={game.name} style={styles.thumb} />
      <View style={styles.flex}>
        <Txt variant="heading" numberOfLines={1}>
          {game.name}
        </Txt>
        <View style={styles.meta}>
          {draft && <Badge label="Draft" />}
          <Txt variant="meta" muted numberOfLines={1} style={styles.flexShrink}>
            @{game.sharedBy.handle} · {timeAgo(game.sharedAt)}
          </Txt>
        </View>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`Play ${game.name}`} disabled={!canPlay} onPress={onPlay} hitSlop={6} style={[styles.play, !canPlay && { opacity: 0.4 }]}>
        <Ionicons name="play" size={16} color={ink.accentFg} />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: ink.bg },
  screen: { backgroundColor: ink.bg },
  content: { padding: 16, paddingBottom: 48, gap: 10 },
  invite: { alignItems: 'center', gap: 6, padding: 18, borderRadius: radius.lg, backgroundColor: ink.wash },
  code: { fontFamily: font.display, fontSize: 32, letterSpacing: 4, color: ink.navy },
  inviteActions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  section: { marginTop: 16 },
  list: { backgroundColor: ink.card, borderRadius: radius.lg, borderWidth: hairline, borderColor: ink.border, overflow: 'hidden' },
  line: { borderBottomWidth: hairline, borderBottomColor: ink.border },
  member: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, height: 56 },
  game: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  thumb: { width: 52, height: 52, borderRadius: radius.sm },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  play: { width: 38, height: 38, borderRadius: 19, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
  danger: { marginTop: 24, gap: 8 },
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
});
