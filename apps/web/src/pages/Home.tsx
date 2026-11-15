import { useMemo, useState } from 'react';
import { GameCard } from '../components/GameCard';
import { Doodles, Icon } from '../components/Icon';
import { NewGameModal } from '../components/NewGame';
import { Button, Empty, ErrorNote, Segmented } from '../components/ui';
import { api, isActive } from '../lib/api';
import { useUser } from '../lib/auth';
import { useResource } from '../lib/store';

type Filter = 'all' | 'live' | 'draft' | 'building';

export function Home() {
  const user = useUser();
  const games = useResource('games', api.myGames);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const list = games.data?.games ?? [];
  const building = list.filter((g) => g.activeGeneration && isActive(g.activeGeneration.status)).length;
  const shown = useMemo(() => list.filter((g) =>
    filter === 'all' ? true : filter === 'live' ? g.status === 'published' : filter === 'draft' ? g.status === 'draft'
      : !!g.activeGeneration && isActive(g.activeGeneration.status)), [list, filter]);

  return (
    <div className="page">
      <section className="hero">
        <Doodles variant="b" />
        <div>
          <span className="label">Hey @{user.handle}</span>
          <h1 className="display">Your games</h1>
          <p className="lead muted">
            {games.data ? <>{list.length} {list.length === 1 ? 'game' : 'games'}{building ? <> · <b>{building} building now</b></> : null}</> : 'Loading your studio…'}
          </p>
        </div>
        <Button size="lg" sparkles onClick={() => setCreating(true)}>New game</Button>
      </section>

      {list.length > 0 && (
        <div className="toolbar">
          <Segmented value={filter} onChange={setFilter} options={[
            { value: 'all', label: 'All' }, { value: 'building', label: `Building${building ? ` · ${building}` : ''}` },
            { value: 'live', label: 'Live' }, { value: 'draft', label: 'Drafts' },
          ]} />
        </div>
      )}

      {games.error ? <ErrorNote error={games.error} onRetry={games.refetch} />
        : !games.data ? (
          <div className="game-grid">{Array.from({ length: 6 }, (_, i) => <div key={i} className="game-card skeleton" />)}</div>
        ) : list.length === 0 ? (
          <Empty title="Nothing here yet" body="Describe a game and Dreamsy builds it — art, levels, logic and all."
            action={<Button sparkles onClick={() => setCreating(true)}>Start your first game</Button>} />
        ) : (
          <div className="game-grid">
            <button className="game-card new-card" onClick={() => setCreating(true)}>
              <span className="new-card-plus"><Icon name="plus" size={28} /></span>
              <span className="h3">New game</span>
              <span className="label muted">Prompt → playable</span>
            </button>
            {shown.map((g) => <GameCard key={g.id} game={g} />)}
          </div>
        )}
      <NewGameModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
