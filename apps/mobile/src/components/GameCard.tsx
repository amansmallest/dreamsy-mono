import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { playersLabel, type FeedGame, type Players } from '../api';
import { compact } from '../social';
import { floating, ink, radius } from '../theme';
import { Badge, Button, Chip, Pressy, Txt } from '../ui';
import { Avatar } from './Avatar';
import { Thumbnail } from './Thumbnail';

export const openGame = (id: string, params: Record<string, string> = {}) =>
  router.push({ pathname: '/discover/[id]', params: { id, ...params } });

const NEW_MS = 3 * 24 * 3600 * 1000;
const isNew = (g: FeedGame) => !!g.publishedAt && Date.now() - new Date(g.publishedAt).getTime() < NEW_MS;

/** Likes and plays, side by side. */
export function GameStatsLine({ game, color = ink.muted }: { game: FeedGame; color?: string }) {
  return (
    <View style={styles.statsLine}>
      <Ionicons name="heart" size={11} color={color} />
      <Txt variant="meta" color={color} style={styles.statText}>
        {compact(game.stats.likes)}
      </Txt>
      <Ionicons name="play" size={11} color={color} style={styles.statGap} />
      <Txt variant="meta" color={color} style={styles.statText}>
        {compact(game.stats.plays)}
      </Txt>
    </View>
  );
}

/** Multiplayer marker (§4.5): people icon + "2P" / "Up to 8". Renders nothing for single-player games. */
export function PlayersBadge({ game, tone = 'white', style }: {
  game: { multiplayer?: boolean; players?: Players | null } | null | undefined;
  tone?: 'white' | 'sky' | 'blue';
  style?: StyleProp<ViewStyle>;
}) {
  const label = playersLabel(game);
  if (!label) return null;
  const bg = { white: ink.card, sky: ink.wash, blue: ink.accent }[tone];
  const fg = tone === 'blue' ? ink.accentFg : ink.navy;
  return (
    <View style={[styles.players, { backgroundColor: bg }, style]} accessibilityLabel={`Multiplayer, ${label === '2P' ? '2 players' : label.toLowerCase() + ' players'}`}>
      <Ionicons name="people" size={11} color={fg} />
      <Txt variant="badge" color={fg}>
        {label}
      </Txt>
    </View>
  );
}

/** Marketplace tile: square cover, name, likes and plays. Shelves and grids. */
export const GameCard = memo(function GameCard({ game, width }: { game: FeedGame; width: number }) {
  return (
    <Pressy accessibilityRole="button" accessibilityLabel={game.name} onPress={() => openGame(game.id)} haptic={false} style={{ width, gap: 6 }}>
      <View>
        <Thumbnail url={game.thumbnailUrl} seed={game.id} name={game.name} style={[styles.cover, { width, height: width }]} />
        {isNew(game) && <Badge label="new" tone="blue" style={styles.corner} />}
        <PlayersBadge game={game} style={styles.cornerBottom} />
        {game.orientation === 'portrait' && (
          <View style={styles.portrait}>
            <Ionicons name="phone-portrait-outline" size={11} color={ink.accentFg} />
          </View>
        )}
      </View>
      <Txt variant="heading" numberOfLines={2} style={styles.name}>
        {game.name}
      </Txt>
      <GameStatsLine game={game} />
    </Pressy>
  );
});

/** The big banner at the top of Home. */
export function FeaturedGame({ game, width }: { game: FeedGame; width: number }) {
  const h = Math.round(width * 0.62);
  return (
    <Pressy accessibilityRole="button" accessibilityLabel={game.name} onPress={() => openGame(game.id)} haptic={false} style={[styles.featured, { width, height: h }]}>
      <Thumbnail url={game.thumbnailUrl} seed={game.id} name={game.name} size="lg" style={StyleSheet.absoluteFill} />
      <View style={styles.featuredShade} />
      <View style={[styles.corner, styles.badgeRow]}>
        <Badge label="featured" tone="white" />
        <PlayersBadge game={game} />
      </View>
      <View style={styles.featuredBottom}>
        <View style={styles.flex}>
          <Txt variant="title" color={ink.accentFg} numberOfLines={2}>
            {game.name}
          </Txt>
          <View style={styles.featuredWho}>
            <Avatar user={game.creator} size={18} />
            <Txt variant="meta" color={ink.accentFg} numberOfLines={1} style={styles.flexShrink}>
              @{game.creator.handle}
            </Txt>
            <GameStatsLine game={game} color={ink.accentFg} />
          </View>
        </View>
        <Button label="Play" icon="play" size="md" onPress={() => openGame(game.id)} />
      </View>
    </Pressy>
  );
}

/** List row: small cover, name, creator, stats. Search results. */
export function GameRow({ game }: { game: FeedGame }) {
  return (
    <Pressy accessibilityRole="button" accessibilityLabel={game.name} onPress={() => openGame(game.id)} haptic={false} style={styles.row}>
      <Thumbnail url={game.thumbnailUrl} seed={game.id} name={game.name} style={styles.rowThumb} />
      <View style={styles.rowMain}>
        <Txt variant="heading" numberOfLines={1}>
          {game.name}
        </Txt>
        <Txt variant="meta" muted numberOfLines={1}>
          @{game.creator.handle}
        </Txt>
        <View style={styles.badgeRow}>
          <GameStatsLine game={game} />
          <PlayersBadge game={game} tone="sky" />
        </View>
      </View>
      <View style={styles.rowPlay}>
        <Ionicons name="play" size={16} color={ink.accentFg} style={{ marginLeft: 2 }} />
      </View>
    </Pressy>
  );
}

export function RemixBadge({ name, onPress }: { name?: string; onPress?: () => void }) {
  return <Chip icon="git-branch-outline" label={`Spin-off of ${name || 'another game'}`} onPress={onPress} />;
}

export { Badge };

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  cover: { borderRadius: radius.md },
  corner: { position: 'absolute', top: 8, left: 8 },
  cornerBottom: { position: 'absolute', bottom: 8, left: 8 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  players: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
  portrait: { position: 'absolute', bottom: 8, right: 8, width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(13,42,102,0.55)', alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 14, lineHeight: 18 },
  statsLine: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  statText: { fontSize: 12 },
  statGap: { marginLeft: 8 },
  featured: { borderRadius: radius.xl, overflow: 'hidden', ...floating },
  featuredShade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '60%', backgroundColor: 'rgba(13,42,102,0.45)' },
  featuredBottom: { position: 'absolute', left: 16, right: 16, bottom: 16, flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  featuredWho: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  rowThumb: { width: 64, height: 64, borderRadius: radius.md },
  rowMain: { flex: 1, gap: 2 },
  rowPlay: { width: 36, height: 36, borderRadius: 18, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
});
