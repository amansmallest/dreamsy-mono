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
import { errorMessage, ink } from '../theme';
import { Card, Empty, Field, InkButton, Loading, ProgressBar, RoundButton, Txt } from '../ui';
import { AvatarHero } from './AvatarMaker';
import { GameTile } from './GameCard';

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const GAP = 12;
const PAD = 20;

/**
 * A creator's profile: handle, bio, stats, follow (others) or edit (self), published games grid.
 * `header`/`footer` slot in screen-specific sections (the Profile tab's wallet, sign out).
 */
export function ProfileView({ userId, header, footer, onRefresh }: { userId: string; header?: ReactNode; footer?: ReactNode; onRefresh?: () => Promise<void> }) {
  const { user: me, updateUser } = useAuth();
  const isSelf = me?.id === userId;
  const { width } = useWindowDimensions();
  const tileW = (width - PAD * 2 - GAP) / 2;

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
        {error ? (
          <Empty title="Couldn't load" body={error} action={<InkButton label="Try again" size="sm" variant="outline" onPress={load} />} />
        ) : (
          <Loading />
        )}
      </View>
    );
  }

  const u = profile.user;
  const avatar = isSelf ? (me?.avatar ?? u.avatar) : u.avatar;
  const lvl = levelOf(profile.stats);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={ink.fg} />}
    >
      <View style={styles.head}>
        <Pressable disabled={!isSelf} onPress={() => router.push('/avatar')} accessibilityLabel="Edit avatar">
          <AvatarHero avatar={avatar} seed={u.id} size={190} />
        </Pressable>
        <Txt variant="display" center numberOfLines={1}>
          @{u.handle}
        </Txt>
        <Txt variant="heading" center>
          lv. {lvl.level} <Txt variant="meta" muted>({compact(lvl.exp)} exp)</Txt>
        </Txt>
        {!!u.bio && (
          <Txt variant="body" muted center style={styles.bio}>
            {u.bio}
          </Txt>
        )}
      </View>

      <View style={styles.levelBlock}>
        <ProgressBar value={lvl.progress} height={20} />
        <View style={styles.levelEnds}>
          <Txt variant="meta" muted>
            {compact(lvl.from)} exp
          </Txt>
          <Txt variant="meta" muted>
            {compact(lvl.to)} exp
          </Txt>
        </View>
      </View>

      {isSelf ? (
        <View style={styles.actionsRow}>
          <RoundButton icon="pencil" label="Edit name and bio" onPress={() => setEditing(true)} />
          <RoundButton icon="shirt-outline" label="Edit avatar" onPress={() => router.push('/avatar')} />
          <RoundButton icon="add" filled label="Make a game" onPress={() => router.navigate('/create')} />
        </View>
      ) : (
        <InkButton
          label={profile.viewer.following ? 'Following' : 'Follow'}
          variant={profile.viewer.following ? 'outline' : 'solid'}
          icon={profile.viewer.following ? 'checkmark' : 'add'}
          sparkles={!profile.viewer.following}
          onPress={toggleFollow}
        />
      )}

      <Card style={styles.stats}>
        <Stat value={profile.stats.games} label="games" />
        <Stat value={profile.stats.plays} label="plays" />
        <Stat value={profile.stats.likes} label="likes" />
        <Stat value={profile.stats.followers} label="fans" />
        <Stat value={profile.stats.following} label="follows" last />
      </Card>

      {header}

      <Txt variant="label" muted>
        {isSelf ? 'My published games' : 'Games'}
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
          title="No games yet"
          body={isSelf ? 'Publish a game from Make and it shows up here.' : 'Nothing published yet.'}
        />
      ) : (
        <View style={styles.grid}>
          {games.map((g) => (
            <GameTile key={g.id} game={g} width={tileW} />
          ))}
        </View>
      )}
      {next && <InkButton label="Show more" size="sm" variant="outline" busy={moreBusy} onPress={loadMore} style={styles.more} />}

      {footer}

      {isSelf && (
        <EditProfileDialog visible={editing} handle={u.handle} bio={u.bio ?? ''} onCancel={() => setEditing(false)} onSave={save} />
      )}
    </ScrollView>
  );
}

/** Creator level from public stats: exp = plays + 5·likes + 25·games + 10·followers; level n starts at 100·(n-1)². */
function levelOf(stats: UserProfile['stats']) {
  const exp = stats.plays + 5 * stats.likes + 25 * stats.games + 10 * stats.followers;
  const level = Math.floor(Math.sqrt(exp / 100)) + 1;
  const from = 100 * (level - 1) ** 2;
  const to = 100 * level ** 2;
  return { exp, level, from, to, progress: (exp - from) / (to - from) };
}

function Stat({ value, label, last }: { value: number; label: string; last?: boolean }) {
  return (
    <View style={[styles.stat, !last && styles.statDivider]}>
      <Txt variant="heading">{compact(value)}</Txt>
      <Txt variant="label" muted>
        {label}
      </Txt>
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
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Card style={styles.dialog}>
          <Txt variant="pixel">Edit profile</Txt>
          <Txt variant="label" muted>
            Handle
          </Txt>
          <Field
            prefix="@"
            value={handle}
            onChangeText={(t) => setHandle(t.toLowerCase())}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={20}
          />
          {!valid && (
            <Txt variant="meta" muted>
              3–20 characters: a–z, 0–9, underscore.
            </Txt>
          )}
          <Txt variant="label" muted>
            Bio
          </Txt>
          <Field value={bio} onChangeText={setBio} multiline maxLength={160} placeholder="A line about you and your games" />
          {error && (
            <Txt variant="meta" color={ink.danger}>
              {error}
            </Txt>
          )}
          <View style={styles.dialogActions}>
            <InkButton label="Cancel" variant="outline" size="md" onPress={onCancel} style={styles.flex} />
            <InkButton label="Save" size="md" busy={busy} disabled={!valid} onPress={submit} style={styles.flex} />
          </View>
        </Card>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: ink.bg },
  scroll: { backgroundColor: ink.bg },
  content: { padding: PAD, gap: 18, paddingBottom: 48 },
  head: { alignItems: 'center', gap: 4 },
  bio: { marginHorizontal: 16, marginTop: 4 },
  levelBlock: { gap: 6 },
  levelEnds: { flexDirection: 'row', justifyContent: 'space-between' },
  actionsRow: { flexDirection: 'row', justifyContent: 'center', gap: 22 },
  stats: { flexDirection: 'row', paddingVertical: 12 },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statDivider: { borderRightWidth: 1.5, borderRightColor: ink.border },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  more: { alignSelf: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(20,20,20,0.45)', justifyContent: 'center', padding: 24 },
  dialog: { padding: 18, gap: 10 },
  dialogActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  flex: { flex: 1 },
});
