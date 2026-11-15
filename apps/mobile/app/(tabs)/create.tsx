import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, authHeader, isActiveGeneration, thumbnailUrlFor, type Game, type Generation } from '@/api';
import { CREATE_PRICE, formatCoins, insufficientFrom, OutOfCoinsSheet, useCreatePrice } from '@/coins';
import { Thumbnail } from '@/components/Thumbnail';
import { etaFromGeneration, etaLine, useEtaRemaining } from '@/generationProgress';
import { errorMessage, font, ink, radius } from '@/theme';
import { showToast } from '@/toast';
import { Badge, Button, Header, IconButton, Loading, PixelSky, Pressy, Txt } from '@/ui';
import { walletChanged } from '@/wallet';

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

  const [idea, setIdea] = useState('');
  const createPrice = useCreatePrice();
  const [out, setOut] = useState<{ balance: number; price: number } | null>(null);

  /**
   * New game; with an idea, Claude starts building it straight away. That first build costs
   * createPrice coins (edits after it are free); a 402 shows "Out of coins" and keeps the idea.
   */
  const newGame = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const text = idea.trim();
      const { game } = await api.createGame({ name: text ? text.slice(0, 60) : 'Untitled game' });
      if (text) {
        try {
          const r = await api.generate(game.id, { prompt: text });
          if (r.charged) {
            showToast({ kind: 'charge', title: formatCoins(-r.charged, true) });
            walletChanged();
          }
        } catch (e) {
          const broke = insufficientFrom(e, createPrice ?? CREATE_PRICE);
          if (broke) {
            // The empty game exists; it shows in the list and can be built later.
            setOut(broke);
            walletChanged();
            void load();
            return;
          }
          // Anything else: the workspace shows the game and the user can send the idea again.
        }
      }
      setIdea('');
      router.push({ pathname: '/game/[id]', params: { id: game.id } });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <Header title="Create" right={<IconButton icon="qr-code-outline" label="Scan from dashboard" onPress={() => router.push('/scan')} />} />
      {sorted === null && !error ? (
        <Loading />
      ) : (
        <FlatList
          data={sorted ?? []}
          keyExtractor={(g) => g.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={ink.accent} />}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListHeaderComponent={
            <View style={styles.headerBlock}>
              <View style={styles.hero}>
                <PixelSky style={StyleSheet.absoluteFill} dense />
                <Txt variant="title" color={ink.navy}>
                  What do you want to play?
                </Txt>
                <TextInput
                  value={idea}
                  onChangeText={setIdea}
                  placeholder="a cozy fishing game on a tiny island"
                  placeholderTextColor={ink.faint}
                  selectionColor={ink.accent}
                  multiline
                  maxLength={2000}
                  style={styles.idea}
                />
                <Button
                  label={idea.trim() ? (createPrice ? 'Create' : 'Build it') : 'Start empty'}
                  price={idea.trim() && createPrice ? formatCoins(createPrice, true) : undefined}
                  sparkles={!!idea.trim()}
                  busy={creating}
                  onPress={newGame}
                />
              </View>
              {error && (
                <Txt variant="meta" color={ink.danger} center>
                  {error}
                </Txt>
              )}
              {!!sorted?.length && (
                <Txt variant="label" muted style={styles.section}>
                  Your games
                </Txt>
              )}
            </View>
          }
          renderItem={({ item }) => <GameRow game={item} build={builds[item.id]} headers={headers} />}
        />
      )}
      <OutOfCoinsSheet state={out} what="Creating a game" onClose={() => setOut(null)} />
    </SafeAreaView>
  );
}

function GameRow({ game, build, headers }: { game: Game; build?: Generation; headers?: Record<string, string> }) {
  // ETA snapshot taken when this record arrived; counts down locally until the next poll.
  const eta = useMemo(() => (build ? etaFromGeneration(build) : null), [build]);
  const remaining = useEtaRemaining(eta);
  const line = build ? (etaLine(eta, remaining) ?? (build.status === 'queued' ? 'Queued' : 'Building…')) : null;
  const live = game.status === 'published';

  return (
    <Pressy onPress={() => router.push({ pathname: '/game/[id]', params: { id: game.id } })} haptic={false} style={styles.row}>
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
            <ActivityIndicator size="small" color={ink.accent} />
            <Txt variant="meta" color={ink.accent} numberOfLines={1} style={styles.flex}>
              {line}
            </Txt>
          </View>
        ) : (
          <View style={styles.buildRow}>
            <Badge label={live ? 'live' : game.latestVersion > 0 ? 'draft' : 'empty'} tone={live ? 'ok' : 'sky'} />
            {game.latestVersion > 0 && (
              <Txt variant="meta" muted>
                v{game.latestVersion}
              </Txt>
            )}
            {game.remixOf && (
              <Txt variant="meta" muted numberOfLines={1} style={styles.flex}>
                · spin-off
              </Txt>
            )}
          </View>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color={ink.faint} />
    </Pressy>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.bg },
  list: { padding: 16, paddingTop: 4, gap: 8, paddingBottom: 32 },
  headerBlock: { gap: 14, marginBottom: 4 },
  hero: { borderRadius: radius.xl, overflow: 'hidden', padding: 18, paddingTop: 22, gap: 14 },
  idea: {
    minHeight: 88,
    maxHeight: 160,
    backgroundColor: ink.card,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    fontFamily: font.medium,
    fontSize: 16,
    color: ink.fg,
    textAlignVertical: 'top',
  },
  section: { marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 10, gap: 12, backgroundColor: ink.card, borderRadius: radius.lg },
  thumb: { width: 64, height: 64, borderRadius: radius.md },
  rowMain: { flex: 1, gap: 6 },
  buildRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  flex: { flex: 1 },
});
