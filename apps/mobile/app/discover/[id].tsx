import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { api, ApiError, type FeedGame, type Creator, type Game, type GameStats, type Orientation, type RemixOf } from '@/api';
import { useAuth } from '@/auth';
import { Avatar } from '@/components/Avatar';
import { GameTile, RemixBadge } from '@/components/GameCard';
import { SpinOffSheet } from '@/components/SpinOffSheet';
import { Thumbnail } from '@/components/Thumbnail';
import { compact, REPORT_REASONS, shareGame } from '@/social';
import { errorMessage, ink } from '@/theme';
import { Card, Empty, InkButton, Loading, RoundButton, Txt, type IconName } from '@/ui';

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

/** Game page: preview, Play, Like, Share, Spin-off, creator, spin-offs row, report. */
export default function GameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [game, setGame] = useState<Detail | null>(null);
  const [liked, setLiked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [spinOffOpen, setSpinOffOpen] = useState(false);
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
        {error ? (
          <Empty title="Hmm" body={error} action={<InkButton label="Try again" size="sm" variant="outline" onPress={load} />} />
        ) : (
          <Loading />
        )}
      </View>
    );
  }

  const canPlay = !!game.publishedVersion;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={ink.fg} />}
    >
      <Stack.Screen
        options={{
          title: game.name,
          headerRight: () => (
            <Pressable accessibilityLabel="More" onPress={menu} hitSlop={10}>
              <Ionicons name="ellipsis-horizontal" size={22} color={ink.fg} />
            </Pressable>
          ),
        }}
      />

      <Card style={styles.heroCard}>
        <Pressable accessibilityRole="button" accessibilityLabel="Play" disabled={!canPlay} onPress={play}>
          <Thumbnail
            url={game.thumbnailUrl}
            seed={game.id}
            name={game.name}
            size="lg"
            style={[styles.hero, { aspectRatio: game.orientation === 'portrait' ? 4 / 5 : 16 / 10 }]}
          />
          {canPlay && (
            <View style={styles.heroPlay} pointerEvents="none">
              <Ionicons name="play" size={30} color={ink.accentFg} style={styles.heroPlayIcon} />
            </View>
          )}
        </Pressable>
      </Card>

      <View style={styles.titleBlock}>
        <Txt variant="display" center>
          {game.name}
        </Txt>
        {game.remixOf && (
          <View style={styles.centerRow}>
            <RemixBadge
              name={game.remixOf.name}
              onPress={() => router.push({ pathname: '/discover/[id]', params: { id: game.remixOf!.gameId } })}
            />
          </View>
        )}
      </View>

      {game.creator && (
        <Card
          accessibilityLabel={`@${game.creator.handle}`}
          onPress={() => router.push({ pathname: '/user/[id]', params: { id: game.creator!.id } })}
          style={styles.creator}
        >
          <Avatar user={game.creator} size={40} />
          <View style={styles.flex}>
            <Txt variant="label" muted>
              made by
            </Txt>
            <Txt variant="heading">@{game.creator.handle}</Txt>
          </View>
          <Ionicons name="chevron-forward" size={18} color={ink.fg} />
        </Card>
      )}

      <Card style={styles.stats}>
        <Stat value={game.stats.plays} label="plays" />
        <Stat value={game.stats.likes} label="likes" />
        <Stat value={game.stats.remixes} label="spin-offs" last />
      </Card>

      <InkButton label={canPlay ? 'Play' : 'Not published yet'} icon="play" sparkles={canPlay} disabled={!canPlay} onPress={play} />

      <View style={styles.actions}>
        <Action icon={liked ? 'heart' : 'heart-outline'} filled={liked} label={liked ? 'Liked' : 'Like'} onPress={toggleLike} />
        <Action icon="share-outline" label="Share" onPress={() => void shareGame(game)} disabled={!canPlay} />
        <Action icon="git-branch-outline" label="Spin-off" onPress={() => setSpinOffOpen(true)} />
        {isOwner && <Action icon="create-outline" label="Edit" onPress={() => router.push({ pathname: '/game/[id]', params: { id: game.id } })} />}
      </View>

      {spinOffs.length > 0 && (
        <View style={styles.spinOffs}>
          <Txt variant="label" muted>
            Spin-offs
          </Txt>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.spinOffRow}>
            {spinOffs.map((g) => (
              <GameTile key={g.id} game={g} width={150} />
            ))}
          </ScrollView>
        </View>
      )}

      {!!game.description && (
        <Card style={styles.desc}>
          <Txt variant="label" muted>
            About
          </Txt>
          <Txt variant="body">{game.description}</Txt>
        </Card>
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

function Stat({ value, label, last }: { value: number; label: string; last?: boolean }) {
  return (
    <View style={[styles.stat, !last && styles.statDivider]}>
      <Txt variant="title">{compact(value)}</Txt>
      <Txt variant="label" muted>
        {label}
      </Txt>
    </View>
  );
}

function Action({
  icon,
  label,
  onPress,
  filled,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  filled?: boolean;
  disabled?: boolean;
}) {
  return (
    <View style={styles.action}>
      <RoundButton icon={icon} label={label} onPress={onPress} filled={filled} disabled={disabled} size={62} />
      <Txt variant="label">{label}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: ink.bg },
  scroll: { backgroundColor: ink.bg },
  content: { padding: 20, gap: 18, paddingBottom: 48 },
  heroCard: { borderRadius: 26 },
  hero: { maxHeight: 460 },
  heroPlay: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    marginLeft: -36,
    marginTop: -36,
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: ink.fg,
    borderWidth: 3,
    borderColor: ink.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroPlayIcon: { marginLeft: 4 },
  titleBlock: { gap: 8 },
  centerRow: { alignItems: 'center' },
  creator: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  flex: { flex: 1 },
  stats: { flexDirection: 'row', paddingVertical: 14 },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statDivider: { borderRightWidth: 1.5, borderRightColor: ink.border },
  actions: { flexDirection: 'row', justifyContent: 'center', gap: 18 },
  action: { alignItems: 'center', gap: 6 },
  desc: { padding: 16, gap: 6 },
  spinOffs: { gap: 10 },
  spinOffRow: { gap: 12 },
});
