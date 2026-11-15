import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Avatar, Chip, Empty, ErrorNote, Segmented } from '../../components/ui';
import { api } from '../../lib/api';
import { useUser } from '../../lib/auth';
import { boardValue, timeAgo } from '../../lib/format';
import { useResource } from '../../lib/store';

/** Workspace tab: the game's leaderboards (DREAMSY.MD §13), public or scoped to one of my groups. */
export function LeaderboardPanel({ gameId }: { gameId: string }) {
  const me = useUser();
  const boards = useResource(`boards:${gameId}`, () => api.boards(gameId));
  const groups = useResource('groups', api.myGroups);
  const list = boards.data?.boards ?? [];
  const [board, setBoard] = useState<string | null>(null);
  const [scope, setScope] = useState('public');
  useEffect(() => {
    if (list.length && (!board || !list.some((b) => b.board === board))) setBoard(list[0]!.board);
  }, [list, board]);
  const current = board && list.some((b) => b.board === board) ? board : null;
  const lb = useResource(current ? `lb:${gameId}:${current}:${scope}` : null, () => api.leaderboard(gameId, current!, scope, 20));

  if (boards.error) return <ErrorNote error={boards.error} onRetry={boards.refetch} />;
  if (!boards.data) return <div className="lb-skeleton">{Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton skel-line" />)}</div>;
  if (!list.length) {
    return <Empty compact title="No runs yet" body={<>Leaderboards fill in when players finish a run (<code>leaderboard.finish()</code> in the game's scripts).</>} />;
  }

  const scopes = [{ value: 'public', label: <><Icon name="star" size={13} /> Public</> },
    ...(groups.data?.groups ?? []).map((g) => ({ value: `group:${g.id}`, label: <><Icon name="users" size={13} /> {g.name}</> }))];
  const data = lb.data;
  const mineInTop = data?.entries.some((e) => e.user.id === me.id);

  return (
    <div className="lb">
      <div className="lb-controls">
        {list.length > 1 ? (
          <label className="lb-board">
            <span className="kicker">Board</span>
            <select className="input input-sm" value={current ?? ''} onChange={(e) => setBoard(e.target.value)}>
              {list.map((b) => <option key={b.board} value={b.board}>{b.board} · {b.players} {b.players === 1 ? 'player' : 'players'}</option>)}
            </select>
          </label>
        ) : (
          <div className="lb-board-one"><span className="kicker">Board</span><b>{list[0]!.board}</b><span className="muted small">{list[0]!.players} {list[0]!.players === 1 ? 'player' : 'players'}</span></div>
        )}
        {scopes.length > 1 && <Segmented value={scope} onChange={setScope} options={scopes} />}
      </div>

      {lb.error ? <ErrorNote error={lb.error} onRetry={lb.refetch} />
        : !data ? <div className="lb-skeleton">{Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton skel-line" />)}</div>
        : data.entries.length === 0 ? <Empty compact title="Nobody here yet" body="No one in this group has finished a run." />
        : (
          <ol className="lb-list">
            {data.entries.map((e) => (
              <li key={e.runId} className={`lb-row ${e.user.id === me.id ? 'is-me' : ''} ${e.rank <= 3 ? `is-top is-${e.rank}` : ''}`}>
                <span className="lb-rank">{e.rank}</span>
                <Avatar handle={e.user.handle} size="sm" />
                <span className="lb-who">
                  <span className="lb-handle">@{e.user.handle}</span>
                  <span className="lb-meta">v{e.version} · {timeAgo(e.at)}</span>
                </span>
                {e.hasGhost && <Chip tone="live">ghost</Chip>}
                <span className="lb-value">{boardValue(e.value, data.order)}</span>
              </li>
            ))}
          </ol>
        )}
      {data?.me && !mineInTop && (
        <div className="lb-row is-me lb-mine">
          <span className="lb-rank">{data.me.rank}</span>
          <Avatar handle={me.handle} size="sm" />
          <span className="lb-who"><span className="lb-handle">You</span></span>
          <span className="lb-value">{boardValue(data.me.value, data.order)}</span>
        </div>
      )}
      {data && <p className="tiny muted lb-foot">{data.order === 'asc' ? 'Fastest time wins' : 'Highest score wins'} · each player's best run</p>}
    </div>
  );
}
