import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { api, ApiError, type FeedGame, type Creator, type Game, type GameStats, type Orientation, type RemixOf } from '@/api';
import { useAuth } from '@/auth';
import { Avatar } from '@/components/Avatar';
import { GameCard, RemixBadge } from '@/components/GameCard';
import { SpinOffSheet } from '@/components/SpinOffSheet';
import { Thumbnail } from '@/components/Thumbnail';
import { compact, REPORT_REASONS, shareGame } from '@/social';
import { errorMessage, hairline, ink, radius } from '@/theme';
import { Button, Empty, Loading, Pressy, Txt, type IconName } from '@/ui';

/** Everything the page shows, merged from GET /v1/games/:id and GET /v1/public/games/:id. */
type Detail = {
  id: string;
  ownerId: string | null;
  name: string;
  description: string;
  orientation: Orientation;
  thumbnailUrl: string | null;
  creator: Creator | null;
  stats: GameStats;
  remixOf: RemixOf | null;
  publishedVersion: number | null;
  latestVersion: number | null;
};

/** Game page: cover, name and creator, big Play, actions, stats, about, spin-offs. */
export default function GameScreen() {
  const { id, spin } = useLocalSearchParams<{ id: string; spin?: string }>();
  const { width } = useWindowDimensions();
  const { user } = useAuth();
  const [game, setGame] = useState<Detail | null>(null);
  const [liked, setLiked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [spinOffOpen, setSpinOffOpen] = useState(spin === '1');
  const [spinOffs, setSpinOffs] = useState<FeedGame[]>([]);
  const likeSeq = useRef(0);

  const load = useCallback(async () => {
    try {
      // The authed view has viewer.liked (and owner fields); the public view has the feed fields.
      // Either may be missing on an older API or for a draft, so take what comes back.
      const [authed, pub] = await Promise.allSettled([api.game(id), api.publicGame(id)]);
      if (authed.status === 'rejected' && pub.status === 'rejected') throw authed.reason;
      const g = authed.status === 'fulfilled' ? authed.value.game : null;
      const p = pub.status === 'fulfilled' ? pub.value.game : null;
      const viewer = authed.status === 'fulfilled' ? (authed.value.viewer ?? authed.value.game.viewer) : undefined;
      setGame({
        id,
        ownerId: g?.ownerId ?? p?.creator.id ?? null,
        name: g?.name ?? p!.name,
        description: g?.description ?? p?.description ?? '',
        orientation: p?.orientation ?? g?.orientation ?? 'landscape',
        thumbnailUrl: p?.thumbnailUrl ?? g?.thumbnailUrl ?? null,
        creator: p?.creator ?? g?.creator ?? null,
        stats: p?.stats ?? g?.stats ?? { plays: 0, likes: 0, remixes: 0 },
        remixOf: p?.remixOf ?? g?.remixOf ?? null,
        publishedVersion: g?.publishedVersion ?? p?.publishedVersion ?? null,
        latestVersion: g && 'latestVersion' in g ? (g as Game).latestVersion : null,
      });
      setLiked(!!viewer?.liked);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'This game isn’t available.' : errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api.remixes(id).then((r) => setSpinOffs(r.games), () => {});
  }, [id]);

  const pull = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const isOwner = !!game && !!user && game.ownerId === user.id;

  const play = () => {
    if (!game?.publishedVersion) return;
    const version = game.publishedVersion;
    // Count it; the API dedupes per user per game per hour. Never blocks playing.
    if (!isOwner) api.countPlay(game.id, version).catch(() => {});
    router.push({
      pathname: '/play/[id]',
      params: { id: game.id, version: String(version), orientation: game.orientation },
    });
  };

  const toggleLike = async () => {
    if (!game) return;
    const next = !liked;
    const seq = ++likeSeq.current;
    setLiked(next);
    setGame((g) => g && { ...g, stats: { ...g.stats, likes: Math.max(0, g.stats.likes + (next ? 1 : -1)) } });
    try {
      await (next ? api.like(game.id) : api.unlike(game.id));
    } catch (e) {
      if (seq !== likeSeq.current) return; // a later tap already superseded this one
      setLiked(!next);
      setGame((g) => g && { ...g, stats: { ...g.stats, likes: Math.max(0, g.stats.likes + (next ? -1 : 1)) } });
      Alert.alert(next ? "Couldn't like" : "Couldn't unlike", errorMessage(e));
    }
  };

  const report = () => {
    if (!game) return;
    const send = async (reason: string) => {
      try {
        await api.report(game.id, reason);
        Alert.alert('Thanks for reporting', 'We’ll review this game.');
      } catch (e) {
        Alert.alert("Couldn't send report", errorMessage(e));
      }
    };
    pick('Why are you reporting this game?', REPORT_REASONS, (i) => void send(REPORT_REASONS[i]!), true);
  };

  const menu = () => {
    if (!game) return;
    const items = ['Share', ...(isOwner ? [] : ['Report'])];
    pick(game.name, items, (i) => (items[i] === 'Share' ? void shareGame(game) : report()), false, items.indexOf('Report'));
  };

  if (!game) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: '' }} />
        {error ? <Empty title="Can't open this game" body={error} action={<Button label="Try again" size="sm" variant="outline" onPress={load} />} /> : <Loading />}
      </View>
    );
  }

  const canPlay = !!game.publishedVersion;
  const portrait = game.orientation === 'portrait';

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={ink.accent} />}>
      <Stack.Screen
        options={{
          title: game.name,
          headerStyle: { backgroundColor: ink.bg },
          headerRight: () => (
            <Pressable accessibilityLabel="More" onPress={menu} hitSlop={10}>
              <Ionicons name="ellipsis-horizontal" size={22} color={ink.fg} />
            </Pressable>
          ),
        }}
      />

      <Pressable accessibilityRole="button" accessibilityLabel="Play" disabled={!canPlay} onPress={play}>
        <Thumbnail url={game.thumbnailUrl} seed={game.id} name={game.name} size="lg" style={{ width, height: portrait ? Math.min(width * 1.1, 480) : Math.round(width * 0.62) }} />
      </Pressable>

      <View style={styles.body}>
        <Txt variant="display" style={styles.name}>
          {game.name}
        </Txt>
        {game.creator && (
          <Pressable onPress={() => router.push({ pathname: '/user/[id]', params: { id: game.creator!.id } })} style={styles.who} hitSlop={4}>
            <Avatar user={game.creator} size={22} />
            <Txt variant="meta" muted>
              By
            </Txt>
            <Txt variant="label" color={ink.accent}>
              @{game.creator.handle}
            </Txt>
          </Pressable>
        )}
        {game.remixOf && (
          <RemixBadge name={game.remixOf.name} onPress={() => router.push({ pathname: '/discover/[id]', params: { id: game.remixOf!.gameId } })} />
        )}

        <Button label={canPlay ? 'Play' : 'Not published yet'} icon="play" disabled={!canPlay} onPress={play} style={styles.play} />

        <View style={styles.actions}>
          <Action icon={liked ? 'heart' : 'heart-outline'} color={liked ? ink.danger : ink.navy} label={compact(game.stats.likes)} a11y={liked ? 'Unlike' : 'Like'} onPress={toggleLike} />
          <Action icon="git-branch-outline" label="Spin-off" onPress={() => setSpinOffOpen(true)} />
          <Action icon="share-outline" label="Share" disabled={!canPlay} onPress={() => void shareGame(game)} />
          {isOwner && <Action icon="create-outline" label="Edit" onPress={() => router.push({ pathname: '/game/[id]', params: { id: game.id } })} />}
        </View>

        <View style={styles.stats}>
          <Stat label="Plays" value={compact(game.stats.plays)} />
          <Stat label="Likes" value={compact(game.stats.likes)} />
          <Stat label="Spin-offs" value={compact(game.stats.remixes)} />
          <Stat label="Screen" value={portrait ? 'Portrait' : 'Landscape'} />
        </View>

        {!!game.description && (
          <View style={styles.about}>
            <Txt variant="pixel">About</Txt>
            <Txt variant="body">{game.description}</Txt>
          </View>
        )}
      </View>

      {spinOffs.length > 0 && (
        <View style={styles.spinOffs}>
          <Txt variant="pixel" style={styles.sectionTitle}>
            Spin-offs
          </Txt>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.spinOffRow}>
            {spinOffs.map((g) => (
              <GameCard key={g.id} game={g} width={140} />
            ))}
          </ScrollView>
        </View>
      )}

      <SpinOffSheet
        visible={spinOffOpen}
        source={game}
        onClose={() => setSpinOffOpen(false)}
        onCreated={() => setGame((g) => g && { ...g, stats: { ...g.stats, remixes: g.stats.remixes + 1 } })}
      />
    </ScrollView>
  );
}

/** iOS action sheet / Android alert. onPick(index into options). */
function pick(title: string, options: string[], onPick: (i: number) => void, destructiveAll = false, destructiveIndex = -1) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...options, 'Cancel'],
        cancelButtonIndex: options.length,
        destructiveButtonIndex: destructiveAll ? undefined : destructiveIndex >= 0 ? destructiveIndex : undefined,
      },
      (i) => i < options.length && onPick(i),
    );
  } else {
    Alert.alert(title, undefined, [
      ...options.map((o, i) => ({ text: o, onPress: () => onPick(i) })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }
}

function Action({ icon, label, onPress, color = ink.navy, disabled, a11y }: { icon: IconName; label: string; onPress: () => void; color?: string; disabled?: boolean; a11y?: string }) {
  return (
    <Pressy accessibilityRole="button" accessibilityLabel={a11y ?? label} disabled={disabled} onPress={onPress} style={[styles.action, disabled && { opacity: 0.4 }]}>
      <Ionicons name={icon} size={22} color={color} />
      <Txt variant="label" color={ink.navy}>
        {label}
      </Txt>
    </Pressy>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Txt variant="pixel" color={ink.navy} numberOfLines={1}>
        {value}
      </Txt>
      <Txt variant="meta" muted>
        {label}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: ink.bg },
  scroll: { backgroundColor: ink.bg },
  content: { paddingBottom: 48 },
  body: { padding: 16, gap: 10 },
  name: { fontSize: 30, lineHeight: 34, color: ink.navy },
  who: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  flex: { flex: 1 },
  play: { marginTop: 8 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  action: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 10, borderRadius: radius.md, backgroundColor: ink.card },
  stats: { flexDirection: 'row', marginTop: 6, paddingVertical: 14, borderRadius: radius.lg, backgroundColor: ink.wash },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  about: { gap: 6, marginTop: 10 },
  spinOffs: { marginTop: 18, paddingTop: 16, gap: 12, borderTopWidth: hairline, borderTopColor: ink.border },
  sectionTitle: { paddingHorizontal: 16 },
  spinOffRow: { gap: 12, paddingHorizontal: 16 },
});
