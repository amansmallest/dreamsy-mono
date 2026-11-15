import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ProgressCard, STATUS_LABEL, STATUS_TONE } from '../components/BuildEntry';
import { Thumb } from '../components/GameCard';
import { Icon } from '../components/Icon';
import { Timeline } from '../components/Timeline';
import { Button, Chip, Empty, ErrorNote, Segmented } from '../components/ui';
import { api, isActive, metricSummary, type ActivityItem } from '../lib/api';
import { duration, timeAgo } from '../lib/format';
import { useGenerationStream } from '../lib/generation';
import { useResource } from '../lib/store';
import { truncate } from '../lib/timeline';

type Filter = 'all' | 'running' | 'succeeded' | 'failed';

export function Activity() {
  const first = useResource('activity', () => api.activity());
  const [more, setMore] = useState<ActivityItem[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const items = [...(first.data?.items ?? []), ...more];
  const cursor = next === undefined ? first.data?.next ?? null : next;
  const shown = items.filter(({ generation: g }) =>
    filter === 'all' ? true : filter === 'running' ? isActive(g.status) : filter === 'failed' ? g.status === 'failed' || g.status === 'canceled' : g.status === 'succeeded');

  return (
    <div className="page narrow">
      <section className="hero compact">
        <div>
          <span className="label">Everything you've built</span>
          <h1 className="display">Activity</h1>
        </div>
        <Segmented value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All' }, { value: 'running', label: 'Running' }, { value: 'succeeded', label: 'Succeeded' }, { value: 'failed', label: 'Failed' },
        ]} />
      </section>
      {first.error ? <ErrorNote error={first.error} onRetry={first.refetch} />
        : !first.data ? <div className="feed">{Array.from({ length: 5 }, (_, i) => <div key={i} className="feed-item skeleton" />)}</div>
        : shown.length === 0 ? <Empty title={items.length ? 'Nothing matches' : 'No builds yet'} body={items.length ? 'Try another filter.' : 'Builds across all your games show up here.'} />
        : (
          <div className="feed">
            {shown.map((it) => <FeedItem key={it.generation.id} item={it} />)}
            {cursor && (
              <Button variant="outline" className="center" busy={loadingMore} onClick={async () => {
                setLoadingMore(true);
                try { const r = await api.activity(cursor); setMore((m) => [...m, ...r.items]); setNext(r.next); } finally { setLoadingMore(false); }
              }}>Load more</Button>
            )}
          </div>
        )}
    </div>
  );
}

function FeedItem({ item: { generation: g, game } }: { item: ActivityItem }) {
  const active = isActive(g.status);
  const [open, setOpen] = useState(active);
  const stream = useGenerationStream(g, { enabled: open || active });
  const m = metricSummary(g.metrics);
  return (
    <article className={`feed-item ${open ? 'is-open' : ''}`}>
      <button className="feed-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Thumb url={game.thumbnailUrl} name={game.name} className="feed-thumb" />
        <div className="feed-text">
          <div className="feed-top">
            <span className="feed-game">{game.name}</span>
            <Chip tone={STATUS_TONE[g.status]}>{STATUS_LABEL[g.status]}</Chip>
            {g.resultVersion && <span className="label">v{g.resultVersion}</span>}
            {m.score != null && <Chip icon="star">{m.score.toFixed(1)}</Chip>}
          </div>
          <p className="feed-prompt">{truncate(g.prompt, 160)}</p>
          <span className="label muted">{timeAgo(g.createdAt)}{g.startedAt && !active ? ` · took ${duration(g.startedAt, g.finishedAt)}` : ''}{m.cost != null ? ` · $${m.cost.toFixed(2)}` : ''}</span>
        </div>
        <Icon name="chevronDown" size={18} className={`chev ${open ? 'is-open' : ''}`} />
      </button>
      {active && <div className="feed-progress"><ProgressCard generation={g} stream={stream} compact /></div>}
      {open && (
        <div className="feed-body">
          <Timeline events={stream?.events ?? []} live={active} />
          <Link to={`/games/${game.id}`} className="link-btn">Open in workspace <Icon name="arrowRight" size={12} /></Link>
        </div>
      )}
    </article>
  );
}
