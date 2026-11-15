import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, authHeader, isActiveGeneration, thumbnailUrlFor, type Game, type Generation } from '@/api';
import { Thumbnail } from '@/components/Thumbnail';
import { etaFromGeneration, etaLine, useEtaRemaining } from '@/generationProgress';
import { errorMessage, ink, stroke } from '@/theme';
import { Card, Header, InkButton, Loading, Sparkle, Txt } from '@/ui';

/** Without `activeGeneration` on the Game view, ask per game for the most recent ones only. */
const MAX_BUILD_LOOKUPS = 15;
const ACTIVE_POLL_MS = 20_000;

export default function CreateScreen() {
  const [games, setGames] = useState<Game[] | null>(null);
  const [builds, setBuilds] = useState<Record<string, Generation>>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [headers, setHeaders] = useState<Record<string, string> | undefined>(undefined);
  const focused = useRef(false);

  useEffect(() => {
    void authHeader().then(setHeaders, () => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.myGames();
      setGames(r.games);
      setError(null);
      // Running builds (they can take an hour; this list is where you come back to them).
      const next: Record<string, Generation> = {};
      const ask: Game[] = [];
      for (const g of r.games) {
        if ('activeGeneration' in g) {
          if (g.activeGeneration && isActiveGeneration(g.activeGeneration.status)) next[g.id] = g.activeGeneration;
        } else if (ask.length < MAX_BUILD_LOOKUPS) ask.push(g);
      }
      const found = await Promise.all(
        ask.map((g) =>
          api.generations(g.id).then(
            (x) => x.generations.find((gen) => isActiveGeneration(gen.status)) ?? null,
            () => null,
          ),
        ),
      );
      for (const gen of found) if (gen) next[gen.gameId] = gen;
      setBuilds(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  // Refresh whenever the tab comes back into view or the app returns to the foreground.
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void load();
      return () => {
        focused.current = false;
      };
    }, [load]),
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && focused.current && void load());
    return () => sub.remove();
  }, [load]);

  // While something is building, poll gently for round/ETA/checkpoints.
  const anyActive = Object.keys(builds).length > 0;
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => focused.current && AppState.currentState === 'active' && void load(), ACTIVE_POLL_MS);
    return () => clearInterval(t);
  }, [anyActive, load]);

  // Building games first, then most recently updated (API order).
  const sorted = useMemo(
    () => (games ? [...games].sort((a, b) => Number(!!builds[b.id]) - Number(!!builds[a.id])) : null),
    [games, builds],
  );

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const newGame = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const { game } = await api.createGame({ name: 'Untitled game' });
      router.push({ pathname: '/game/[id]', params: { id: game.id } });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <Header title="Make" subtitle="your games" />
      {sorted === null && !error ? (
        <Loading />
      ) : (
        <FlatList
          data={sorted ?? []}
          keyExtractor={(g) => g.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={ink.fg} />}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <View style={styles.headerBlock}>
              <Card style={styles.hero}>
                <View style={styles.heroMarks}>
                  <Sparkle size={26} />
                  <Sparkle size={12} style={{ marginTop: 16 }} />
                </View>
                <Txt variant="title">What do you want to play?</Txt>
                <Txt variant="body" muted>
                  Describe it in a sentence, add a picture if you like. Dreamsy builds it while you wait.
                </Txt>
                <InkButton label="New game" sparkles busy={creating} onPress={newGame} style={styles.heroButton} />
              </Card>
              {error && (
                <Txt variant="meta" color={ink.danger} center>
                  {error}
                </Txt>
              )}
              {!!sorted?.length && <Txt variant="label" muted>Your games</Txt>}
            </View>
          }
          renderItem={({ item }) => <GameRow game={item} build={builds[item.id]} headers={headers} />}
        />
      )}
    </SafeAreaView>
  );
}

function GameRow({ game, build, headers }: { game: Game; build?: Generation; headers?: Record<string, string> }) {
  // ETA snapshot taken when this record arrived; counts down locally until the next poll.
  const eta = useMemo(() => (build ? etaFromGeneration(build) : null), [build]);
  const remaining = useEtaRemaining(eta);
  const line = build ? (etaLine(eta, remaining) ?? (build.status === 'queued' ? 'Queued…' : 'Building…')) : null;
  const live = game.status === 'published';

  return (
    <Card onPress={() => router.push({ pathname: '/game/[id]', params: { id: game.id } })} style={styles.row}>
      <Thumbnail
        url={game.latestVersion > 0 ? (game.thumbnailUrl ?? thumbnailUrlFor(game.id, game.latestVersion)) : null}
        headers={headers}
        seed={game.id}
        style={styles.thumb}
      />
      <View style={styles.rowMain}>
        <Txt variant="heading" numberOfLines={1}>
          {game.name}
        </Txt>
        {line ? (
          <View style={styles.buildRow}>
            <ActivityIndicator size="small" color={ink.fg} />
            <Txt variant="meta" numberOfLines={1} style={styles.flex}>
              {line}
            </Txt>
          </View>
        ) : (
          <View style={styles.buildRow}>
            {live && <View style={styles.liveDot} />}
            <Txt variant="meta" muted numberOfLines={1}>
              {live ? `Live · v${game.publishedVersion}` : game.latestVersion > 0 ? `Draft · v${game.latestVersion}` : 'Empty'}
            </Txt>
          </View>
        )}
        {game.remixOf && (
          <Txt variant="meta" muted numberOfLines={1}>
            Spin-off{game.remixOf.name ? ` of ${game.remixOf.name}` : ''}
          </Txt>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color={ink.fg} />
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.bg },
  list: { padding: 20, paddingTop: 6, gap: 12 },
  headerBlock: { gap: 14, marginBottom: 2 },
  hero: { padding: 20, gap: 8 },
  heroMarks: { flexDirection: 'row', gap: 4, marginBottom: 4 },
  heroButton: { marginTop: 10 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 10, gap: 12 },
  thumb: { width: 76, aspectRatio: 1, borderRadius: 14, borderWidth: stroke.thin, borderColor: ink.fg },
  rowMain: { flex: 1, gap: 4 },
  buildRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  flex: { flex: 1 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: ink.ok },
});
