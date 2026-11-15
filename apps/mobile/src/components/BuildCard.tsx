import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { isActiveGeneration, thumbnailUrlFor, type GameVersion, type Generation } from '../api';
import { BUILD_STAGES, etaLine, summarizeBuild, useEtaRemaining, type Progress } from '../generationProgress';
import { floating, hairline, ink, radius } from '../theme';
import { Button as InkButton, PixelSky, ProgressBar, Sparkle, Txt } from '../ui';
import { Thumbnail } from './Thumbnail';

const MAX_LOG = 4;

type Props = {
  generation: Generation;
  /** The version this generation produced, once known (summary). */
  version: GameVersion | undefined;
  /** Live progress; only for the active generation. */
  progress: Progress | null;
  gameId: string;
  imageHeaders: Record<string, string> | undefined;
  canceling: boolean;
  onCancel: () => void;
  onPlay: (version: number) => void;
};

/** One turn of the conversation: your prompt, then Claude's build card. */
export function BuildTurn(props: Props) {
  const g = props.generation;
  return (
    <View style={styles.turn}>
      <View style={styles.you}>
        <Txt variant="body" color={ink.accentFg}>
          {g.prompt}
        </Txt>
        {g.imageIds.length > 0 && (
          <View style={styles.youMeta}>
            <Ionicons name="image-outline" size={12} color={ink.accentFg} />
            <Txt variant="label" color={ink.accentFg}>
              {g.imageIds.length} reference{g.imageIds.length === 1 ? '' : 's'}
            </Txt>
          </View>
        )}
      </View>
      <View style={styles.them}>
        <View style={styles.mark}>
          <Sparkle size={14} color={ink.accentFg} />
        </View>
        <BuildCard {...props} />
      </View>
    </View>
  );
}

function ClaudeHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.head}>
      <Txt variant="pixel" style={styles.headTitle} numberOfLines={1}>
        {title}
      </Txt>
      {right}
    </View>
  );
}

function BuildCard({ generation: g, version, progress, gameId, imageHeaders, canceling, onCancel, onPlay }: Props) {
  const status = progress?.status ?? g.status;

  if (isActiveGeneration(status)) {
    return <LiveCard generation={g} progress={progress} canceling={canceling} onCancel={onCancel} onPlay={onPlay} />;
  }

  if (status === 'succeeded') {
    const v = g.resultVersion;
    return (
      <View style={styles.card}>
        <ClaudeHead
          title="Done"
          right={
            v != null && (
              <Txt variant="label" muted>
                v{v}
              </Txt>
            )
          }
        />
        {v != null && (
          <Pressable accessibilityRole="button" accessibilityLabel={`Play version ${v}`} onPress={() => onPlay(v)}>
            <Thumbnail url={thumbnailUrlFor(gameId, v)} headers={imageHeaders} seed={`${gameId}@${v}`} style={styles.result} />
            <View style={styles.resultPlay} pointerEvents="none">
              <Ionicons name="play" size={20} color={ink.accentFg} style={{ marginLeft: 2 }} />
            </View>
          </Pressable>
        )}
        <Txt variant="body">{version?.summary || (v ? `Built version ${v}.` : 'Done.')}</Txt>
      </View>
    );
  }

  if (status === 'failed') {
    return (
      <View style={[styles.card, styles.failed]}>
        <ClaudeHead title="Couldn't build that" />
        <Txt variant="body" muted>
          {g.error ? friendlyError(g.error) : 'Try saying it a different way.'}
        </Txt>
      </View>
    );
  }

  return (
    <View style={[styles.card, styles.quiet]}>
      <ClaudeHead title="Canceled" />
    </View>
  );
}

function LiveCard({
  generation: g,
  progress,
  canceling,
  onCancel,
  onPlay,
}: {
  generation: Generation;
  progress: Progress | null;
  canceling: boolean;
  onCancel: () => void;
  onPlay: (version: number) => void;
}) {
  const summary = useMemo(() => summarizeBuild(progress?.events ?? []), [progress?.events]);
  const remaining = useEtaRemaining(progress?.eta);
  const eta = etaLine(progress?.eta, remaining);
  const queued = (progress?.status ?? g.status) === 'queued';
  const rounds = progress?.eta?.rounds ?? 0;
  const round = progress?.eta?.round ?? 0;
  const log = summary.log.slice(-MAX_LOG);
  const lastCheckpoint = summary.checkpoints.at(-1);

  return (
    <View style={styles.card}>
      <PixelSky style={styles.sky} />
      <ClaudeHead
        title={queued ? 'In line' : 'Building'}
        right={
          <Pressable accessibilityRole="button" onPress={onCancel} disabled={canceling} hitSlop={10}>
            <Txt variant="label" color={ink.navy} style={{ opacity: canceling ? 0.5 : 1 }}>
              {canceling ? 'Stopping' : 'Stop'}
            </Txt>
          </Pressable>
        }
      />

      {!queued && <Stages current={summary.stage} />}

      <View style={styles.activity}>
        <Pulse />
        <Txt variant="heading" style={styles.flex} numberOfLines={1}>
          {queued ? 'Starting soon' : (summary.activity ?? 'Getting started')}
        </Txt>
      </View>

      {rounds > 1 && (
        <View style={styles.rounds}>
          <ProgressBar value={Math.max(0.04, (round - 1) / rounds)} height={8} />
          <Txt variant="meta" muted>
            {eta}
          </Txt>
        </View>
      )}
      {rounds <= 1 && !!eta && (
        <Txt variant="meta" muted>
          {eta}
        </Txt>
      )}

      {log.length > 0 && (
        <View style={styles.log}>
          {log.map((l, i) => (
            <View key={`${i}-${l}`} style={styles.logRow}>
              <View style={[styles.logDot, i === log.length - 1 && styles.logDotNow]} />
              <Txt variant="meta" color={i === log.length - 1 ? ink.fg : ink.muted} style={styles.flex} numberOfLines={2}>
                {l}
              </Txt>
            </View>
          ))}
        </View>
      )}

      <Counts counts={summary.counts} />

      {lastCheckpoint && (
        <InkButton
          label={`Play v${lastCheckpoint.version} now`}
          icon="play"
          size="sm"
          variant="outline"
          onPress={() => onPlay(lastCheckpoint.version)}
        />
      )}
      {rounds > 1 && (
        <Txt variant="meta" muted>
          Safe to leave. New versions land here.
        </Txt>
      )}
    </View>
  );
}

function Stages({ current }: { current: number }) {
  return (
    <View style={styles.stages}>
      {BUILD_STAGES.map((s, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <View key={s} style={styles.stage}>
            <View style={[styles.stageDot, (done || now) && styles.stageDotOn]}>
              {done ? (
                <Ionicons name="checkmark" size={12} color={ink.accentFg} />
              ) : now ? (
                <ActivityIndicator size="small" color={ink.accentFg} style={{ transform: [{ scale: 0.6 }] }} />
              ) : null}
            </View>
            <Txt variant="label" color={done || now ? ink.fg : ink.muted} style={styles.stageLabel}>
              {s}
            </Txt>
            {i < BUILD_STAGES.length - 1 && <View style={[styles.stageLine, done && styles.stageLineOn]} />}
          </View>
        );
      })}
    </View>
  );
}

function Counts({ counts }: { counts: { edits: number; sprites: number; art: number; playtests: number } }) {
  const items = [
    counts.edits && { icon: 'construct-outline' as const, n: counts.edits, label: 'edits' },
    counts.sprites + counts.art && { icon: 'color-palette-outline' as const, n: counts.sprites + counts.art, label: 'art' },
    counts.playtests && { icon: 'game-controller-outline' as const, n: counts.playtests, label: 'tests' },
  ].filter(Boolean) as { icon: 'construct-outline'; n: number; label: string }[];
  if (!items.length) return null;
  return (
    <View style={styles.counts}>
      {items.map((it) => (
        <View key={it.label} style={styles.count}>
          <Ionicons name={it.icon} size={13} color={ink.accent} />
          <Txt variant="meta">
            {it.n} {it.label}
          </Txt>
        </View>
      ))}
    </View>
  );
}

/** Small breathing blue dot: "alive". */
function Pulse() {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <Animated.View
      style={[
        styles.pulse,
        { opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }), transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.15] }) }] },
      ]}
    />
  );
}

/** Harness errors can be long and technical; keep the first sentence. */
function friendlyError(e: string) {
  const first = e.split('\n')[0] ?? e;
  return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}

const styles = StyleSheet.create({
  turn: { gap: 10 },
  you: {
    alignSelf: 'flex-end',
    maxWidth: '82%',
    backgroundColor: ink.accent,
    borderRadius: 22,
    borderBottomRightRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 4,
  },
  youMeta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  them: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  card: {
    flex: 1,
    backgroundColor: ink.card,
    borderWidth: hairline,
    borderColor: ink.border,
    borderRadius: radius.lg,
    borderBottomLeftRadius: 6,
    padding: 14,
    gap: 12,
    overflow: 'hidden',
  },
  failed: { borderColor: ink.danger },
  quiet: { opacity: 0.6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mark: { width: 28, height: 28, borderRadius: 14, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
  headTitle: { flex: 1, fontSize: 14 },
  sky: { marginHorizontal: -14, marginTop: -14, height: 44, justifyContent: 'center', paddingHorizontal: 14 },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pulse: { width: 8, height: 8, borderRadius: 4, backgroundColor: ink.accent },
  flex: { flex: 1 },
  rounds: { gap: 6 },
  stages: { flexDirection: 'row' },
  stage: { flex: 1, alignItems: 'center', gap: 5 },
  stageDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: ink.wash,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  stageDotOn: { backgroundColor: ink.accent },
  stageLabel: { fontSize: 10 },
  stageLine: { position: 'absolute', top: 9, left: '50%', right: '-50%', height: 2, backgroundColor: ink.wash },
  stageLineOn: { backgroundColor: ink.accent },
  log: { gap: 6, borderTopWidth: hairline, borderTopColor: ink.border, paddingTop: 10 },
  logRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  logDot: { width: 5, height: 5, borderRadius: 1, backgroundColor: ink.sky, marginTop: 6 },
  logDotNow: { backgroundColor: ink.accent },
  counts: { flexDirection: 'row', gap: 14 },
  count: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  result: { aspectRatio: 16 / 10, borderRadius: radius.md },
  resultPlay: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: ink.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...floating,
  },
});
