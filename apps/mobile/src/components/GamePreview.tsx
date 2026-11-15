import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ink, radius } from '../theme';
import { PixelSky, Sparkle, Txt } from '../ui';
import { EngineView } from './EngineView';

export type GamePreviewProps = {
  gameId: string;
  /** Version to show; 0 = empty game (no package yet). */
  version: number;
};

/**
 * Inline, playable preview of (gameId, version) in a rounded 16:10 card. Reloads whenever the
 * version changes. Engine errors show as a small dismissible banner over the card.
 */
export function GamePreview({ gameId, version }: GamePreviewProps) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setError(null), [gameId, version]);

  if (version <= 0) {
    return (
      <View style={[styles.card, styles.empty]}>
        <PixelSky dense style={StyleSheet.absoluteFill} />
        <View style={styles.marks}>
          <Sparkle size={26} color={ink.navy} />
          <Sparkle size={12} color={ink.navy} style={{ marginTop: 18 }} />
        </View>
        <Txt variant="pixel" color={ink.navy} center>
          Describe your game below
        </Txt>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <EngineView key={`${gameId}@${version}`} gameId={gameId} version={version} style={styles.fill} onError={setError} />
      {error && (
        <Pressable accessibilityRole="button" accessibilityHint="Dismiss" onPress={() => setError(null)} style={styles.banner}>
          <Txt variant="meta" color={ink.accentFg} numberOfLines={2}>
            {error}
          </Txt>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    aspectRatio: 16 / 10,
    borderRadius: radius.lg,
    backgroundColor: ink.navy,
    overflow: 'hidden',
  },
  fill: { flex: 1 },
  empty: { justifyContent: 'center', alignItems: 'center', padding: 20, gap: 10, backgroundColor: ink.wash },
  marks: { flexDirection: 'row', gap: 4 },
  banner: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: ink.danger,
  },
});
