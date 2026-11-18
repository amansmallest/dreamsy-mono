import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { api, type BoardEntry, type BoardOrder, type BoardScope, type BoardSummary, type Group, type Leaderboard } from '../api';
import { useAuth } from '../auth';
import { errorMessage, hairline, ink, radius } from '../theme';
import { Badge, Loading, Pills, Txt } from '../ui';
import { Avatar } from './Avatar';

const TOP = 20;

/** Seconds -> "1:05.42" (m:ss.cc), "1:02:03.40" past an hour. */
export function formatTime(seconds: number): string {
  const cs = Math.round(Math.max(0, seconds) * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h ? `${h}:${pad(m)}` : pad(m)}:${pad(s)}.${pad(c)}`;
}

/** asc boards are times; desc boards are scores. */
export const formatValue = (order: BoardOrder, v: number) =>
  order === 'asc' ? formatTime(v) : v.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** "fastest_lap" -> "Fastest lap". */
const boardLabel = (b: string) => {
  const t = b.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * Game page leaderboards (docs/platform.md §13): board picker, scope (Public / each of my groups), top 20,
 * me highlighted (plus my row under the list if I'm outside the top 20), ghost badge. Renders nothing
 * for games without boards. Refetches on focus, so a run finished in the player shows up on return.
 */
export function LeaderboardSection({ gameId }: { gameId: string }) {
  const { user } = useAuth();
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [board, setBoard] = useState<string | null>(null);
  const [scope, setScope] = useState<BoardScope>('public');
  const [data, setData] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const loadBoards = useCallback(async () => {
    try {
      const [b, g] = await Promise.all([api.boards(gameId), api.myGroups().catch(() => ({ groups: [] as Group[] }))]);
      setBoards(b.boards);
      setGroups(g.groups);
      setBoard((cur) => (cur && b.boards.some((x) => x.board === cur) ? cur : (b.boards.find((x) => x.board === 'fastest') ?? b.boards[0])?.board ?? null));
    } catch {
      setBoards((cur) => cur ?? []); // no section rather than an error box on a game page
    }
  }, [gameId]);

  const loadBoard = useCallback(async () => {
    if (!board) return;
    const mine = ++seq.current;
    try {
      const r = await api.leaderboard(gameId, board, scope, TOP);
      if (mine !== seq.current) return;
      setData(r);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(errorMessage(e));
    }
  }, [gameId, board, scope]);

  useFocusEffect(
    useCallback(() => {
      void loadBoards();
    }, [loadBoards]),
  );

  useEffect(() => {
    setData((d) => (d && d.board === board ? d : null));
    void loadBoard();
  }, [loadBoard, board]);

  // A group I left disappears from the scope list.
  useEffect(() => {
    if (scope !== 'public' && !groups.some((g) => `group:${g.id}` === scope)) setScope('public');
  }, [groups, scope]);

  if (!boards?.length || !board) return null;

  const order = data?.order ?? boards.find((b) => b.board === board)?.order ?? 'asc';
  const entries = data?.scope === scope ? data.entries : null;
  const meOutside = data?.me && entries && !entries.some((e) => e.user.id === user?.id) ? data.me : null;
  const scopes = [{ value: 'public' as BoardScope, label: 'Everyone' }, ...groups.map((g) => ({ value: `group:${g.id}` as BoardScope, label: g.name }))];

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Ionicons name="trophy-outline" size={18} color={ink.navy} />
        <Txt variant="pixel" style={styles.flex}>
          Leaderboard
        </Txt>
        <Txt variant="meta" muted>
          {order === 'asc' ? 'Fastest first' : 'Highest first'}
        </Txt>
      </View>

      {boards.length > 1 && <Pills options={boards.map((b) => ({ value: b.board, label: boardLabel(b.board) }))} value={board} onChange={setBoard} style={styles.pills} />}
      {scopes.length > 1 && <Pills options={scopes} value={scope} onChange={setScope} style={styles.pills} />}

      <View style={styles.list}>
        {entries === null ? (
          error ? (
            <Txt variant="meta" color={ink.danger} style={styles.pad}>
              {error}
            </Txt>
          ) : (
            <Loading style={styles.loading} />
          )
        ) : entries.length === 0 ? (
          <Txt variant="body" muted style={styles.pad}>
            {scope === 'public' ? 'No runs yet. Be the first.' : 'Nobody in this group has a run yet. Play it and set the time to beat.'}
          </Txt>
        ) : (
          entries.map((e, i) => <Row key={e.runId} entry={e} order={order} me={e.user.id === user?.id} last={i === entries.length - 1 && !meOutside} />)
        )}
        {meOutside && user && (
          <>
            <View style={styles.gap}>
              <Txt variant="meta" muted>
                ···
              </Txt>
            </View>
            <Row entry={{ rank: meOutside.rank, user, value: meOutside.value, runId: meOutside.runId, hasGhost: false, version: 0, at: '' }} order={order} me last />
          </>
        )}
      </View>
    </View>
  );
}

function Row({ entry, order, me, last }: { entry: BoardEntry; order: BoardOrder; me: boolean; last: boolean }) {
  const top = entry.rank <= 3;
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/user/[id]', params: { id: entry.user.id } })}
      style={[styles.row, me && styles.rowMe, !last && styles.line]}
      accessibilityLabel={`${entry.rank}. ${entry.user.handle}, ${formatValue(order, entry.value)}${entry.hasGhost ? ', has a ghost' : ''}`}
    >
      <View style={[styles.rank, top && styles.rankTop]}>
        <Txt variant="label" color={top ? ink.accentFg : ink.navy}>
          {entry.rank}
        </Txt>
      </View>
      <Avatar user={entry.user} size={30} />
      <Txt variant="heading" numberOfLines={1} color={me ? ink.navy : ink.fg} style={styles.flex}>
        {me ? 'You' : `@${entry.user.handle}`}
      </Txt>
      {entry.hasGhost && <Badge label="Ghost" tone="white" />}
      <Txt variant="pixel" color={ink.navy} style={styles.value}>
        {formatValue(order, entry.value)}
      </Txt>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10, marginTop: 18 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pills: { paddingRight: 16 },
  list: { backgroundColor: ink.card, borderRadius: radius.lg, borderWidth: hairline, borderColor: ink.border, overflow: 'hidden' },
  pad: { padding: 16 },
  loading: { marginVertical: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, height: 52 },
  rowMe: { backgroundColor: ink.wash },
  line: { borderBottomWidth: hairline, borderBottomColor: ink.border },
  rank: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: ink.bg },
  rankTop: { backgroundColor: ink.accent },
  value: { fontVariant: ['tabular-nums'] },
  gap: { alignItems: 'center', paddingVertical: 2, borderBottomWidth: hairline, borderBottomColor: ink.border },
  flex: { flex: 1 },
});
