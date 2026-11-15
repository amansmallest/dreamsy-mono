import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import type { FeedGame } from '../api';
import { compact } from '../social';
import { ink, stroke } from '../theme';
import { Card, Chip, Txt } from '../ui';
import { Avatar } from './Avatar';
import { Thumbnail } from './Thumbnail';

export const openGame = (id: string) => router.push({ pathname: '/discover/[id]', params: { id } });

function Stats({ game, size = 12 }: { game: FeedGame; size?: number }) {
  return (
    <View style={styles.stats}>
      <Ionicons name="play" size={size} color={ink.fg} />
      <Txt variant="meta">{compact(game.stats.plays)}</Txt>
      <Ionicons name="heart" size={size} color={ink.fg} style={styles.statGap} />
      <Txt variant="meta">{compact(game.stats.likes)}</Txt>
    </View>
  );
}

/** Full-width feed card. */
export function GameCard({ game }: { game: FeedGame }) {
  return (
    <Card accessibilityLabel={`${game.name} by @${game.creator.handle}`} onPress={() => openGame(game.id)}>
      <Thumbnail url={game.thumbnailUrl} seed={game.id} name={game.name} size="lg" style={styles.thumb} />
      {game.orientation === 'portrait' && (
        <View style={styles.orient}>
          <Ionicons name="phone-portrait-outline" size={12} color={ink.fg} />
        </View>
      )}
      <View style={styles.meta}>
        <View style={styles.row}>
          <Txt variant="heading" numberOfLines={1} style={styles.flex}>
            {game.name}
          </Txt>
          <Stats game={game} />
        </View>
        <View style={styles.row}>
          <Avatar user={game.creator} size={22} />
          <Txt variant="meta" muted numberOfLines={1} style={styles.flex}>
            @{game.creator.handle}
          </Txt>
        </View>
        {game.remixOf && <RemixBadge name={game.remixOf.name} />}
      </View>
    </Card>
  );
}

/** Compact grid tile (profiles). */
export function GameTile({ game, width }: { game: FeedGame; width: number }) {
  return (
    <Card accessibilityLabel={game.name} onPress={() => openGame(game.id)} style={{ width }}>
      <Thumbnail url={game.thumbnailUrl} seed={game.id} name={game.name} style={styles.tileThumb} />
      <View style={styles.tileMeta}>
        <Txt variant="heading" numberOfLines={1} style={styles.tileName}>
          {game.name}
        </Txt>
        <Stats game={game} size={10} />
      </View>
    </Card>
  );
}

export function RemixBadge({ name, onPress }: { name?: string; onPress?: () => void }) {
  return <Chip icon="git-branch-outline" label={`Spin-off of ${name || 'another game'}`} onPress={onPress} />;
}

const styles = StyleSheet.create({
  thumb: { aspectRatio: 16 / 10, borderBottomWidth: stroke.base, borderBottomColor: ink.fg },
  orient: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: ink.card,
    borderWidth: stroke.thin,
    borderColor: ink.fg,
    borderRadius: 10,
    padding: 4,
  },
  meta: { gap: 6, padding: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  stats: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  statGap: { marginLeft: 6 },
  tileThumb: { aspectRatio: 1, borderBottomWidth: stroke.base, borderBottomColor: ink.fg },
  tileMeta: { padding: 10, gap: 4 },
  tileName: { fontSize: 15 },
});
