import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { api, ApiError, type FeedGame, type UserProfile } from '../api';
import { useAuth } from '../auth';
import { compact } from '../social';
import { errorMessage, hairline, ink, radius } from '../theme';
import { Button, Empty, Field, Loading, ProgressBar, Txt } from '../ui';
import { Avatar } from './Avatar';
import { GameCard } from './GameCard';

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const GAP = 12;
const PAD = 16;

/**
 * Instagram-style profile: avatar + stats, name/bio, level, actions, 3-column game grid.
 * `header` slots in under the actions (the Me tab's Stars wallet); `footer` goes after the grid.
 */
export function ProfileView({ userId, header, footer, onRefresh }: { userId: string; header?: ReactNode; footer?: ReactNode; onRefresh?: () => Promise<void> }) {
  const { user: me, updateUser } = useAuth();
  const isSelf = me?.id === userId;
  const { width } = useWindowDimensions();
  const tile = (width - PAD * 2 - GAP) / 2;

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [games, setGames] = useState<FeedGame[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const followSeq = useRef(0);

  const load = useCallback(async () => {
    try {
      const [p, g] = await Promise.all([api.user(userId), api.userGames(userId)]);
      setProfile(p);
      setGames(g.games);
      setNext(g.next ?? null);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [userId]);

  // Own profile refetches on focus (a publish elsewhere changes it); others load once.
  useEffect(() => {
    if (!isSelf) void load();
  }, [isSelf, load]);
  useFocusEffect(
    useCallback(() => {
      if (isSelf) void load();
    }, [isSelf, load]),
  );

  const pull = async () => {
    setRefreshing(true);
    await Promise.all([load(), onRefresh?.()]);
    setRefreshing(false);
  };

  const loadMore = async () => {
    if (!next || moreBusy) return;
    setMoreBusy(true);
    try {
      const r = await api.userGames(userId, next);
      setGames((cur) => [...(cur ?? []), ...r.games.filter((n) => !cur?.some((o) => o.id === n.id))]);
      setNext(r.next ?? null);
    } catch (e) {
      Alert.alert("Couldn't load more", errorMessage(e));
    } finally {
      setMoreBusy(false);
    }
  };

  const toggleFollow = async () => {
    if (!profile) return;
    const next = !profile.viewer.following;
    const seq = ++followSeq.current;
    const apply = (on: boolean) =>
      setProfile((p) =>
        p && {
          ...p,
          viewer: { following: on },
          stats: { ...p.stats, followers: Math.max(0, p.stats.followers + (on ? 1 : -1)) },
        },
      );
    apply(next);
    try {
      await (next ? api.follow(userId) : api.unfollow(userId));
    } catch (e) {
      if (seq !== followSeq.current) return;
      apply(!next);
      Alert.alert(next ? "Couldn't follow" : "Couldn't unfollow", errorMessage(e));
    }
  };

  const save = async (handle: string, bio: string) => {
    const body: { handle?: string; bio?: string } = {};
    if (handle !== profile?.user.handle) body.handle = handle;
    if (bio !== (profile?.user.bio ?? '')) body.bio = bio;
    if (!Object.keys(body).length) return setEditing(false);
    const { user } = await api.updateMe(body); // throws to the dialog
    updateUser(user);
    setProfile((p) => p && { ...p, user: { ...p.user, handle: user.handle, bio: user.bio ?? bio } });
    setEditing(false);
  };

  if (!profile) {
    return (
      <View style={styles.center}>
        {error ? <Empty title="Couldn't load" body={error} action={<Button label="Try again" size="sm" variant="outline" onPress={load} />} /> : <Loading />}
      </View>
    );
  }

  const u = profile.user;
  const avatarUser = { id: u.id, avatar: isSelf ? (me?.avatar ?? u.avatar) : u.avatar };
  const lvl = levelOf(profile.stats);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={ink.accent} />}
    >
      <View style={styles.top}>
        <Pressable disabled={!isSelf} onPress={() => router.push('/avatar')} accessibilityLabel="Edit avatar" style={styles.avatarWrap}>
          <Avatar user={avatarUser} size={88} />
          {isSelf && (
            <View style={styles.avatarPlus}>
              <Ionicons name="add" size={14} color={ink.accentFg} />
            </View>
          )}
        </Pressable>
        <View style={styles.stats}>
          <Stat value={profile.stats.games} label="games" />
          <Stat value={profile.stats.plays} label="plays" />
          <Stat value={profile.stats.followers} label="fans" />
          <Stat value={profile.stats.following} label="following" />
        </View>
      </View>

      <View style={styles.about}>
        <Txt variant="heading">@{u.handle}</Txt>
        {!!u.bio && <Txt variant="body">{u.bio}</Txt>}
        <View style={styles.level}>
          <Txt variant="badge" color={ink.navy}>
            lv {lvl.level}
          </Txt>
          <ProgressBar value={lvl.progress} height={6} style={styles.flex} />
          <Txt variant="meta" muted>
            {compact(lvl.exp)} / {compact(lvl.to)} exp
          </Txt>
        </View>
      </View>

      <View style={styles.actions}>
        {isSelf ? (
          <>
            <Button label="Edit profile" variant="outline" size="sm" onPress={() => setEditing(true)} style={styles.flex} />
            <Button label="Edit avatar" variant="outline" size="sm" onPress={() => router.push('/avatar')} style={styles.flex} />
          </>
        ) : (
          <Button
            label={profile.viewer.following ? 'Following' : 'Follow'}
            variant={profile.viewer.following ? 'outline' : 'solid'}
            size="sm"
            onPress={toggleFollow}
            style={styles.flex}
          />
        )}
      </View>

      {header && <View style={styles.slot}>{header}</View>}

      <Txt variant="pixel" style={styles.section}>
        Creations
      </Txt>

      {error && (
        <Txt variant="meta" color={ink.danger} center>
          {error}
        </Txt>
      )}
      {games === null ? (
        <Loading />
      ) : games.length === 0 ? (
        <Empty
          title={isSelf ? 'Share your first game' : 'No games yet'}
          body={isSelf ? 'Published games show up here.' : undefined}
          action={isSelf ? <Button label="Make a game" size="md" onPress={() => router.navigate('/create')} /> : undefined}
        />
      ) : (
        <View style={styles.grid}>
          {games.map((g) => (
            <GameCard key={g.id} game={g} width={tile} />
          ))}
        </View>
      )}
      {next && <Button label="Show more" size="sm" variant="ghost" busy={moreBusy} onPress={loadMore} style={styles.more} />}

      {footer && <View style={styles.slot}>{footer}</View>}

      {isSelf && <EditProfileDialog visible={editing} handle={u.handle} bio={u.bio ?? ''} onCancel={() => setEditing(false)} onSave={save} />}
    </ScrollView>
  );
}

/** Creator level from public stats: exp = plays + 5·likes + 25·games + 10·followers; level n starts at 100·(n-1)². */
function levelOf(stats: UserProfile['stats']) {
  const exp = stats.plays + 5 * stats.likes + 25 * stats.games + 10 * stats.followers;
  const level = Math.floor(Math.sqrt(exp / 100)) + 1;
  const from = 100 * (level - 1) ** 2;
  const to = 100 * level ** 2;
  return { exp, level, to, progress: (exp - from) / (to - from) };
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <View style={styles.stat}>
      <Txt variant="pixel" style={styles.statValue}>
        {compact(value)}
      </Txt>
      <Txt variant="meta">{label}</Txt>
    </View>
  );
}

function EditProfileDialog({
  visible,
  handle: initialHandle,
  bio: initialBio,
  onCancel,
  onSave,
}: {
  visible: boolean;
  handle: string;
  bio: string;
  onCancel: () => void;
  onSave: (handle: string, bio: string) => Promise<void>;
}) {
  const [handle, setHandle] = useState(initialHandle);
  const [bio, setBio] = useState(initialBio);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setHandle(initialHandle);
    setBio(initialBio);
    setError(null);
  }, [visible, initialHandle, initialBio]);

  const h = handle.trim().toLowerCase();
  const valid = HANDLE_RE.test(h);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(h, bio.trim());
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? 'That handle is taken.' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <KeyboardAvoidingView style={styles.sheet} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheetBar}>
          <Pressable onPress={onCancel} hitSlop={10}>
            <Txt variant="body">Cancel</Txt>
          </Pressable>
          <Txt variant="pixel">Edit profile</Txt>
          <Pressable onPress={submit} disabled={!valid || busy} hitSlop={10}>
            <Txt variant="heading" color={valid && !busy ? ink.accent : ink.faint}>
              Done
            </Txt>
          </Pressable>
        </View>
        <View style={styles.sheetBody}>
          <Txt variant="label" muted>
            Handle
          </Txt>
          <Field prefix="@" value={handle} onChangeText={(t) => setHandle(t.toLowerCase())} autoCapitalize="none" autoCorrect={false} maxLength={20} />
          {!!h && !valid && (
            <Txt variant="meta" muted>
              3–20 characters: a–z, 0–9, underscore
            </Txt>
          )}
          <Txt variant="label" muted style={{ marginTop: 8 }}>
            Bio
          </Txt>
          <Field value={bio} onChangeText={setBio} multiline maxLength={160} />
          {error && (
            <Txt variant="meta" color={ink.danger}>
              {error}
            </Txt>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: ink.card },
  scroll: { backgroundColor: ink.card },
  content: { paddingBottom: 40 },
  top: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, gap: 16 },
  avatarWrap: { width: 88, height: 88 },
  avatarPlus: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: ink.accent,
    borderWidth: 3,
    borderColor: ink.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stats: { flex: 1, flexDirection: 'row', justifyContent: 'space-between' },
  stat: { alignItems: 'center', gap: 1 },
  statValue: { fontSize: 18 },
  about: { paddingHorizontal: 16, paddingTop: 12, gap: 4 },
  level: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  flex: { flex: 1 },
  actions: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 14 },
  slot: { paddingHorizontal: 16, paddingTop: 14 },
  section: { fontSize: 18, paddingHorizontal: PAD, marginTop: 24, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP, rowGap: 18, paddingHorizontal: PAD },
  more: { alignSelf: 'center', marginTop: 8 },
  sheet: { flex: 1, backgroundColor: ink.card },
  sheetBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, height: 56, borderBottomWidth: hairline, borderBottomColor: ink.border },
  sheetBody: { padding: 16, gap: 8 },
});
