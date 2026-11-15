import { useMemo, useState } from 'react';
import { GameCard } from '../components/GameCard';
import { Icon, PixelSky } from '../components/Icon';
import { IDEAS, NewGameModal } from '../components/NewGame';
import { LiveNow } from '../components/LiveNow';
import { Button, Empty, ErrorNote, Segmented } from '../components/ui';
import { api, isActive } from '../lib/api';
import { useUser } from '../lib/auth';
import { useResource } from '../lib/store';

type Filter = 'all' | 'live' | 'draft' | 'building';

export function Home() {
  const user = useUser();
  const games = useResource('games', api.myGames);
  const [creating, setCreating] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [multiplayer, setMultiplayer] = useState(false);
  const list = games.data?.games ?? [];
  const building = list.filter((g) => g.activeGeneration && isActive(g.activeGeneration.status)).length;
  const shown = useMemo(() => list.filter((g) => (!multiplayer || !!g.multiplayer) && (
    filter === 'all' ? true : filter === 'live' ? g.status === 'published' : filter === 'draft' ? g.status === 'draft'
      : !!g.activeGeneration && isActive(g.activeGeneration.status))), [list, filter, multiplayer]);
  const start = (prompt: string) => setCreating(prompt);

  return (
    <div className="page">
      <PixelSky preset="hero" className="home-hero">
        <div className="home-hero-body">
          <span className="kicker">hey @{user.handle}</span>
          <h1 className="display">What do you want to make?</h1>
          <form className="prompt-box" onSubmit={(e) => { e.preventDefault(); start(draft.trim()); }}>
            <Icon name="edit" size={18} className="prompt-box-icon" />
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="A cozy farming game where the crops sing at night…" aria-label="Describe a game" />
            <Button type="submit" icon="plus">New game</Button>
          </form>
          <div className="idea-row">
            {IDEAS.map((idea) => <button key={idea} className="idea-chip" onClick={() => start(idea)}>{idea}</button>)}
          </div>
        </div>
      </PixelSky>

      <div className="section-head">
        <div className="section-title">
          <h2 className="h2">your games</h2>
          {games.data && list.length > 0 && (
            <span className="section-count">{list.length}{building ? <> · <b className="blue">{building} building</b></> : null}</span>
          )}
        </div>
        {list.length > 0 && (
          <div className="section-filters">
            <button className={`filter-chip ${multiplayer ? 'is-on' : ''}`} aria-pressed={multiplayer} onClick={() => setMultiplayer((m) => !m)}>
              <Icon name="users" size={14} /> Multiplayer
            </button>
            <Segmented value={filter} onChange={setFilter} options={[
              { value: 'all', label: 'All' }, { value: 'building', label: 'Building' },
              { value: 'live', label: 'Live' }, { value: 'draft', label: 'Drafts' },
            ]} />
          </div>
        )}
      </div>

      {games.error ? <ErrorNote error={games.error} onRetry={games.refetch} />
        : !games.data ? (
          <div className="tile-grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="tile-skeleton"><div className="skeleton tile-skel-media" /><div className="skeleton skel-line" /></div>)}</div>
        ) : list.length === 0 ? (
          <Empty title="No games yet" body="Describe one above and Dreamsy builds it." />
        ) : shown.length === 0 ? (
          <Empty compact title="Nothing here" action={<button className="link-btn" onClick={() => { setFilter('all'); setMultiplayer(false); }}>Show all games</button>} />
        ) : (
          <div className="tile-grid">
            {shown.map((g) => <GameCard key={g.id} game={g} />)}
          </div>
        )}
      <LiveNow />
      <NewGameModal open={creating != null} initialPrompt={creating ?? ''} onClose={() => setCreating(null)} />
    </div>
  );
}
