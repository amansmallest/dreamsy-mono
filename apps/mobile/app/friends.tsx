import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, AppState, KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { api, ApiError, type Creator, type Friend, type FriendRequest, type FriendStatus, type Presence, type UserHit } from '@/api';
import { Avatar } from '@/components/Avatar';
import {
  FRIENDS_POLL_MS,
  isOnline,
  presenceAction,
  presenceLine,
  refreshFriends,
  sortFriends,
  useFriendsState,
  useRoomJoin,
} from '@/friends';
import { errorMessage, ink, radius } from '@/theme';
import { Badge, Button, Empty, Field, Loading, Pressy, Txt } from '@/ui';

const SEARCH_DEBOUNCE_MS = 300;

/** Friends: find people by handle, requests in and out, friends with live presence (Join / Spectate). */
export default function FriendsScreen() {
  const { available, data, error } = useFriendsState();
  const room = useRoomJoin();
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const q = query.trim().replace(/^@+/, '');
  const { hits, searching, searchError, patchHit } = useUserSearch(q);

  // Fresh on focus, then every 15 s while this screen is focused and the app is in the foreground.
  useFocusEffect(
    useCallback(() => {
      void refreshFriends();
      const t = setInterval(() => {
        if (AppState.currentState === 'active') void refreshFriends();
      }, FRIENDS_POLL_MS);
      return () => clearInterval(t);
    }, []),
  );

  const pull = async () => {
    setRefreshing(true);
    await refreshFriends();
    setRefreshing(false);
  };

  /** One action at a time per person; refreshes the list after. */
  const act = async (userId: string, fn: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(userId);
    try {
      await fn();
      after?.();
      await refreshFriends();
    } catch (e) {
      Alert.alert('Something went wrong', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const add = (u: UserHit) => {
    if (busy) return;
    setBusy(u.id);
    api
      .requestFriend(u.handle)
      .then(
        (r) => patchHit(u.id, r.friend ? 'friends' : 'outgoing'),
        (e) => {
          if (e instanceof ApiError && e.status === 409) return patchHit(u.id, 'friends');
          Alert.alert("Couldn't add", addError(e));
        },
      )
      .finally(() => {
        setBusy(null);
        void refreshFriends();
      });
  };

  const accept = (u: Creator) => act(u.id, () => api.acceptFriend(u.id), () => patchHit(u.id, 'friends'));
  const decline = (u: Creator) => act(u.id, () => api.declineFriend(u.id), () => patchHit(u.id, 'none'));
  const cancel = (u: Creator) => act(u.id, () => api.removeFriend(u.id), () => patchHit(u.id, 'none'));
  const unfriend = (u: Creator) => act(u.id, () => api.removeFriend(u.id), () => patchHit(u.id, 'none'));

  const friendMenu = (f: Friend) => {
    const handle = `@${f.user.handle}`;
    const profile = () => router.push({ pathname: '/user/[id]', params: { id: f.user.id } });
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: handle, options: ['View profile', 'Unfriend', 'Cancel'], destructiveButtonIndex: 1, cancelButtonIndex: 2 },
        (i) => (i === 0 ? profile() : i === 1 ? void unfriend(f.user) : undefined),
      );
    } else {
      Alert.alert(handle, undefined, [
        { text: 'View profile', onPress: profile },
        { text: 'Unfriend', style: 'destructive', onPress: () => void unfriend(f.user) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  const friends = data ? sortFriends(data.friends) : [];
  const online = friends.filter((f) => isOnline(f.presence)).length;

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}>
      <Stack.Screen options={{ title: 'Friends' }} />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={ink.accent} />}
      >
        {available !== false && (
          <Field
            value={query}
            onChangeText={setQuery}
            prefix="@"
            placeholder="Search by handle"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            maxLength={40}
          />
        )}

        {available === false ? (
          <Empty title="Friends are coming soon" body="Add friends, see who's online, and jump into their games." />
        ) : q ? (
          <>
            <Txt variant="pixel" style={styles.section}>
              People
            </Txt>
            {hits === null || (searching && hits.length === 0) ? (
              searchError ? (
                <Txt variant="meta" color={ink.danger}>
                  {searchError}
                </Txt>
              ) : (
                <Loading style={styles.loading} />
              )
            ) : hits.length === 0 ? (
              <Txt variant="body" muted>
                No one with a handle starting “{q}”.
              </Txt>
            ) : (
              hits.map((u) => (
                <PersonRow key={u.id} user={u} onPress={() => router.push({ pathname: '/user/[id]', params: { id: u.id } })}>
                  <HitAction u={u} busy={busy === u.id} disabled={!!busy && busy !== u.id} onAdd={() => add(u)} onAccept={() => void accept(u)} />
                </PersonRow>
              ))
            )}
          </>
        ) : data === null ? (
          error ? (
            <Empty title="Couldn't load friends" body={error} action={<Button label="Try again" size="sm" variant="outline" onPress={() => void refreshFriends()} />} />
          ) : (
            <Loading />
          )
        ) : (
          <>
            {data.incoming.length > 0 && (
              <>
                <Txt variant="pixel" style={styles.section}>
                  Requests · {data.incoming.length}
                </Txt>
                {data.incoming.map((r) => (
                  <RequestRow key={r.user.id} r={r} line="Wants to be friends">
                    <Button label="Accept" size="sm" busy={busy === r.user.id} disabled={!!busy && busy !== r.user.id} onPress={() => void accept(r.user)} />
                    <Button label="Decline" size="sm" variant="outline" disabled={!!busy} onPress={() => void decline(r.user)} />
                  </RequestRow>
                ))}
              </>
            )}

            <Txt variant="pixel" style={styles.section}>
              {friends.length ? `Friends · ${online ? `${online} online` : friends.length}` : 'Friends'}
            </Txt>
            {friends.length === 0 ? (
              <View style={styles.intro}>
                <View style={styles.introIcon}>
                  <Ionicons name="people" size={20} color={ink.accentFg} />
                </View>
                <View style={styles.flex}>
                  <Txt variant="heading" color={ink.navy}>
                    Play with friends
                  </Txt>
                  <Txt variant="meta" color={ink.navy}>
                    Search for a handle above to add someone. You'll see when they're online and can jump into their games.
                  </Txt>
                </View>
              </View>
            ) : (
              friends.map((f) => (
                <FriendRow
                  key={f.user.id}
                  f={f}
                  busy={!!f.presence?.roomCode && room.busy === f.presence.roomCode}
                  disabled={!!room.busy}
                  onJoin={(p) => void room.join(p.gameId!, p.roomCode!)}
                  onSpectate={(p) => void room.spectate(p.gameId!, p.roomCode!)}
                  onMenu={() => friendMenu(f)}
                />
              ))
            )}

            {data.outgoing.length > 0 && (
              <>
                <Txt variant="pixel" style={styles.section}>
                  Sent
                </Txt>
                {data.outgoing.map((r) => (
                  <RequestRow key={r.user.id} r={r} line="Request sent">
                    <Button label="Cancel" size="sm" variant="outline" busy={busy === r.user.id} disabled={!!busy && busy !== r.user.id} onPress={() => void cancel(r.user)} />
                  </RequestRow>
                ))}
              </>
            )}
          </>
        )}
      </ScrollView>
      {room.sheet}
    </KeyboardAvoidingView>
  );
}

/** GET /v1/users/search, debounced; stale answers dropped. `patchHit` updates a row after an action. */
function useUserSearch(q: string) {
  const [hits, setHits] = useState<UserHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    if (!q) {
      setHits(null);
      setSearching(false);
      setSearchError(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      api.searchUsers(q).then(
        (r) => {
          if (mine !== seq.current) return;
          setHits(r.users ?? []);
          setSearchError(null);
          setSearching(false);
        },
        (e) => {
          if (mine !== seq.current) return;
          setHits(null);
          setSearchError(errorMessage(e));
          setSearching(false);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  const patchHit = useCallback((id: string, friendStatus: FriendStatus) => {
    setHits((cur) => cur?.map((u) => (u.id === id ? { ...u, friendStatus } : u)) ?? cur);
  }, []);

  return { hits, searching, searchError, patchHit };
}

function addError(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) return 'No one has that handle.';
  if (e instanceof ApiError && e.status === 400) return "That's you.";
  return errorMessage(e);
}

/** Search result action: Add / Requested / Accept / Friends. */
function HitAction({ u, busy, disabled, onAdd, onAccept }: { u: UserHit; busy: boolean; disabled: boolean; onAdd: () => void; onAccept: () => void }) {
  switch (u.friendStatus) {
    case 'friends':
      return <Badge label="Friends" />;
    case 'outgoing':
      return <Badge label="Requested" tone="white" />;
    case 'incoming':
      return <Button label="Accept" size="sm" busy={busy} disabled={disabled} onPress={onAccept} />;
    default:
      return <Button label="Add" icon="person-add" size="sm" busy={busy} disabled={disabled} onPress={onAdd} accessibilityLabel={`Add @${u.handle}`} />;
  }
}

/** Avatar (+ presence dot), @handle, a line under it, actions on the right. */
function PersonRow({
  user,
  line,
  lineColor,
  presence,
  onPress,
  onLongPress,
  children,
}: {
  user: Creator;
  line?: string;
  lineColor?: string;
  presence?: Presence;
  onPress?: () => void;
  onLongPress?: () => void;
  children?: ReactNode;
}) {
  const dot = presence && isOnline(presence) ? (presence.status === 'online' ? ink.ok : ink.accent) : null;
  return (
    <Pressy
      accessibilityRole="button"
      accessibilityLabel={[`@${user.handle}`, line].filter(Boolean).join(', ')}
      accessibilityHint={onLongPress ? 'Long press for more' : undefined}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      haptic={false}
      style={styles.row}
    >
      <View>
        <Avatar user={user} size={44} />
        {dot && <View style={[styles.dot, { backgroundColor: dot }]} />}
      </View>
      <View style={styles.flex}>
        <Txt variant="heading" numberOfLines={1}>
          @{user.handle}
        </Txt>
        {!!line && (
          <Txt variant="meta" color={lineColor ?? ink.muted} numberOfLines={1}>
            {line}
          </Txt>
        )}
      </View>
      {children && <View style={styles.actions}>{children}</View>}
    </Pressy>
  );
}

function RequestRow({ r, line, children }: { r: FriendRequest; line: string; children: ReactNode }) {
  return (
    <PersonRow user={r.user} line={line} onPress={() => router.push({ pathname: '/user/[id]', params: { id: r.user.id } })}>
      {children}
    </PersonRow>
  );
}

function FriendRow({
  f,
  busy,
  disabled,
  onJoin,
  onSpectate,
  onMenu,
}: {
  f: Friend;
  busy: boolean;
  disabled: boolean;
  onJoin: (p: Presence) => void;
  onSpectate: (p: Presence) => void;
  onMenu: () => void;
}) {
  const p = f.presence;
  const action = presenceAction(p);
  const color = p?.status === 'online' ? ink.ok : p?.status === 'in_room' || p?.status === 'in_match' ? ink.accent : ink.muted;
  return (
    <PersonRow
      user={f.user}
      presence={p}
      line={presenceLine(p)}
      lineColor={color}
      onPress={() => router.push({ pathname: '/user/[id]', params: { id: f.user.id } })}
      onLongPress={onMenu}
    >
      {action === 'join' ? (
        <Button label="Join" size="sm" busy={busy} disabled={disabled && !busy} onPress={() => onJoin(p)} accessibilityLabel={`Join @${f.user.handle}`} />
      ) : action === 'spectate' ? (
        <Button
          label="Spectate"
          icon="eye-outline"
          size="sm"
          variant="outline"
          busy={busy}
          disabled={disabled && !busy}
          onPress={() => onSpectate(p)}
          accessibilityLabel={`Spectate @${f.user.handle}`}
        />
      ) : null}
    </PersonRow>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.bg },
  content: { padding: 16, paddingBottom: 48, gap: 10 },
  section: { marginTop: 16 },
  loading: { marginTop: 8 },
  intro: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: radius.lg, backgroundColor: ink.wash },
  introIcon: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: radius.lg, backgroundColor: ink.card },
  dot: { position: 'absolute', right: -1, bottom: -1, width: 14, height: 14, borderRadius: 7, borderWidth: 2.5, borderColor: ink.card },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  flex: { flex: 1 },
});
