import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { InsufficientCoinsModal, REMIX_PRICE, remixLabel, type CoinShortfall } from '../components/Costs';
import { playPrice, Thumb } from '../components/GameCard';
import { Icon } from '../components/Icon';
import { useStudioPlayer } from '../components/LivePlayers';
import { Avatar, Button, Chip, Empty, ErrorNote, Modal, Segmented } from '../components/ui';
import { api, errorMessage, insufficientCoins, type FeedGame, type FeedPage, type FeedTab, type Game } from '../lib/api';
import { useUser } from '../lib/auth';
import { coins, coinsToUsd, compactCoins, timeAgo, usd } from '../lib/format';
import { invalidate } from '../lib/store';

const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const remixPrice = (g: FeedGame) => g.remixPrice ?? REMIX_PRICE;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Cursor-paged feed or search; resets whenever the query/tab/filter changes. */
function useExploreFeed(q: string, tab: FeedTab, multiplayer: boolean) {
  const [games, setGames] = useState<FeedGame[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ctl = useRef<AbortController | null>(null);
  const key = `${q}\u0000${tab}\u0000${multiplayer}`;

  const load = useCallback((cursor: string | null) => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setLoading(true);
    setError(null);
    const opts = { multiplayer, cursor, signal: c.signal };
    const req: Promise<FeedPage> = q ? api.search(q, opts) : api.feed(tab, opts);
    req.then(
      (page) => {
        if (c.signal.aborted) return;
        setGames((prev) => {
          if (!cursor) return page.games;
          const seen = new Set(prev.map((g) => g.id));
          return [...prev, ...page.games.filter((g) => !seen.has(g.id))];
        });
        setNext(page.next);
        setDone(!page.next);
        setLoading(false);
      },
      (e) => {
        if (c.signal.aborted || (e as Error).name === 'AbortError') return;
        setError(e);
        setLoading(false);
      },
    );
  }, [q, tab, multiplayer]);

  useEffect(() => {
    setGames([]); setNext(null); setDone(false);
    load(null);
    return () => ctl.current?.abort();
    // `key` captures q/tab/multiplayer; `load` changes with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const more = useCallback(() => { if (!loading && !error && !done && next) load(next); }, [loading, error, done, next, load]);
  const retry = useCallback(() => load(games.length ? next : null), [load, games.length, next]);
  return { games, loading, error, done, more, retry, initial: games.length === 0 && !done };
}

/** Calls `onHit` while the sentinel is near the viewport. */
function Sentinel({ onHit, active }: { onHit: () => void; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onHit);
  cb.current = onHit;
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) cb.current(); }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [active]);
  return <div ref={ref} className="explore-sentinel" aria-hidden />;
}

function Stats({ game }: { game: FeedGame }) {
  return (
    <span className="tile-meta tile-counts">
      <span title="Plays"><Icon name="play" size={13} /> {compact(game.stats?.plays ?? 0)}</span>
      <span title="Likes"><Icon name="heart" size={14} /> {compact(game.stats?.likes ?? 0)}</span>
    </span>
  );
}

type Actions = {
  own: (g: FeedGame) => boolean;
  play: (g: FeedGame) => void;
  remix: (g: FeedGame) => void;
  busy: string | null;
};

function ActionButtons({ game, actions, size = 'sm' }: { game: FeedGame; actions: Actions; size?: 'sm' | 'md' }) {
  const own = actions.own(game);
  return (
    <>
      <Button size={size} icon="play" busy={actions.busy === game.id} onClick={() => actions.play(game)}
        title={own ? 'Free: your game' : `${coins(playPrice(game))} per play`}>
        Play{own ? '' : ` · ${compactCoins(playPrice(game))}`}
      </Button>
      <Button size={size} variant="outline" icon="remix" onClick={() => actions.remix(game)}>
        {remixLabel(remixPrice(game), own)}
      </Button>
    </>
  );
}

function ExploreCard({ game, actions, onOpen }: { game: FeedGame; actions: Actions; onOpen: () => void }) {
  return (
    <article className="tile explore-card">
      <button type="button" className="explore-hit" onClick={onOpen} aria-label={`${game.name} details`}>
        <div className="tile-media">
          <Thumb url={game.thumbnailUrl} name={game.name} />
          {game.multiplayer && game.players && (
            <div className="tile-badges"><Chip tone="live" icon="users">Up to {game.players.max}</Chip></div>
          )}
          <span className="tile-price" title={`${playPrice(game).toLocaleString()} coins per play`}>
            <Icon name="coin" size={12} />{compactCoins(playPrice(game))} coins/play
          </span>
        </div>
        <div className="tile-caption">
          <span className="tile-name">{game.name}</span>
          <span className="explore-creator">{game.creator ? `@${game.creator.handle}` : ' '}</span>
          <Stats game={game} />
        </div>
      </button>
      <div className="explore-actions"><ActionButtons game={game} actions={actions} /></div>
    </article>
  );
}

function DetailModal({ game, actions, onClose }: { game: FeedGame | null; actions: Actions; onClose: () => void }) {
  const [full, setFull] = useState<Game | null>(null);
  useEffect(() => {
    setFull(null);
    if (!game) return;
    let alive = true;
    api.game(game.id).then((r) => { if (alive) setFull(r.game); }, () => { /* version is optional */ });
    return () => { alive = false; };
  }, [game]);
  if (!game) return null;
  const version = full?.publishedVersion ?? null;
  return (
    <Modal open onClose={onClose} title={game.name} width={560}>
      <div className="explore-detail">
        <div className="explore-detail-media">
          <Thumb url={game.thumbnailUrl} name={game.name} />
          <div className="tile-badges">
            {game.multiplayer && game.players && <Chip tone="live" icon="users">Multiplayer · up to {game.players.max}</Chip>}
          </div>
        </div>
        {game.creator && (
          <div className="explore-detail-creator">
            <Avatar handle={game.creator.handle} size="sm" />
            <b>@{game.creator.handle}</b>
            {actions.own(game) && <Chip>Yours</Chip>}
          </div>
        )}
        {game.description ? <p className="explore-detail-desc">{game.description}</p> : <p className="muted explore-detail-desc">No description.</p>}
        {game.remixOf && <p className="muted small">Remix of {game.remixOf.name}</p>}
        <div className="stat-row explore-detail-stats">
          <div><b>{compact(game.stats?.plays ?? 0)}</b><span>plays</span></div>
          <div><b>{compact(game.stats?.likes ?? 0)}</b><span>likes</span></div>
          <div><b>{compact(game.stats?.remixes ?? 0)}</b><span>remixes</span></div>
        </div>
        <dl className="explore-detail-facts">
          <div><dt>Version</dt><dd>{version ? `v${version}` : '…'}</dd></div>
          <div><dt>Published</dt><dd>{game.publishedAt ? timeAgo(game.publishedAt) : '…'}</dd></div>
          <div><dt>Per play</dt><dd>{actions.own(game) ? 'Free (yours)' : coins(playPrice(game))}</dd></div>
        </dl>
        <div className="explore-detail-actions"><ActionButtons game={game} actions={actions} size="md" /></div>
      </div>
    </Modal>
  );
}

function RemixConfirm({ game, own, busy, error, onConfirm, onClose }: {
  game: FeedGame | null; own: boolean; busy: boolean; error: string | null; onConfirm: () => void; onClose: () => void;
}) {
  if (!game) return null;
  const price = remixPrice(game);
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Remix ${game.name}?`} width={440}>
      <div className="coins-modal">
        <div className="coins-modal-icon"><Icon name="remix" size={26} /></div>
        <p className="coins-modal-lede">
          {own
            ? <>Makes a new draft copy of your game. <b>Free</b>.</>
            : <>Makes a new draft copy you own. Costs <b>{coins(price)}</b> <span className="muted">({usd(coinsToUsd(price))})</span>, paid to @{game.creator?.handle ?? 'the creator'}.</>}
        </p>
        {error && <p className="form-error">{error}</p>}
        <div className="coins-modal-actions">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button icon="remix" busy={busy} onClick={onConfirm}>{remixLabel(price, own)}</Button>
        </div>
      </div>
    </Modal>
  );
}

const TABS: { value: FeedTab; label: string }[] = [
  { value: 'trending', label: 'Trending' }, { value: 'new', label: 'New' }, { value: 'following', label: 'Following' },
];

export function Explore() {
  const user = useUser();
  const nav = useNavigate();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<FeedTab>('trending');
  const [multiplayer, setMultiplayer] = useState(false);
  const q = useDebounced(query.trim(), 300);
  const feed = useExploreFeed(q, tab, multiplayer);
  const studio = useStudioPlayer();

  const [detail, setDetail] = useState<FeedGame | null>(null);
  const [remixing, setRemixing] = useState<FeedGame | null>(null);
  const [remixBusy, setRemixBusy] = useState(false);
  const [remixError, setRemixError] = useState<string | null>(null);
  const [need, setNeed] = useState<CoinShortfall | null>(null);

  const own = useCallback((g: FeedGame) => g.creator?.id === user.id, [user.id]);
  const actions: Actions = {
    own,
    busy: studio.busy,
    play: (g) => { setDetail(null); void studio.play(g.id); },
    remix: (g) => { setDetail(null); setRemixError(null); setRemixing(g); },
  };

  const confirmRemix = async () => {
    if (!remixing) return;
    setRemixBusy(true);
    setRemixError(null);
    try {
      const r = await api.remix(remixing.id);
      invalidate('games');
      invalidate('wallet');
      setRemixing(null);
      nav(`/games/${r.game.id}`);
    } catch (e) {
      const short = insufficientCoins(e);
      if (short) { setNeed({ ...short, price: short.price ?? remixPrice(remixing), action: `Remixing ${remixing.name}` }); setRemixing(null); }
      else setRemixError(errorMessage(e));
    } finally {
      setRemixBusy(false);
    }
  };

  const searching = q.length > 0;
  const emptyTitle = searching ? `No games match "${q}"` : tab === 'following' ? 'Nothing from people you follow yet' : 'No games here yet';
  const emptyBody = searching ? 'Try another word or a creator’s handle.'
    : tab === 'following' ? 'Follow creators in the Dreamsy app and their new games show up here.'
      : multiplayer ? 'No multiplayer games yet.' : 'Published games show up here.';

  return (
    <div className="page">
      <div className="page-head explore-head">
        <div>
          <h1 className="h1">Explore</h1>
          <p className="muted explore-lede">Every public game on Dreamsy. Play it, or remix it into your own.</p>
        </div>
      </div>

      <div className="explore-bar">
        <label className="explore-search">
          <Icon name="search" size={17} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search games or @creators" aria-label="Search games" />
          {query && <button type="button" className="explore-clear" onClick={() => setQuery('')} aria-label="Clear search"><Icon name="x" size={15} /></button>}
        </label>
        <div className="explore-filters">
          <div className={searching ? 'explore-tabs is-dim' : 'explore-tabs'} title={searching ? 'Search covers all games' : undefined}>
            <Segmented value={tab} onChange={(t) => { setTab(t); setQuery(''); }} options={TABS} />
          </div>
          <button className={`filter-chip ${multiplayer ? 'is-on' : ''}`} aria-pressed={multiplayer} onClick={() => setMultiplayer((m) => !m)}>
            <Icon name="users" size={14} /> Multiplayer
          </button>
        </div>
      </div>

      {studio.error && <p className="form-error small">{studio.error}</p>}

      {feed.initial && feed.error ? <ErrorNote error={feed.error} onRetry={feed.retry} />
        : feed.initial ? (
          <div className="tile-grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="tile-skeleton"><div className="skeleton tile-skel-media" /><div className="skeleton skel-line" /></div>)}</div>
        ) : feed.games.length === 0 ? (
          <Empty title={emptyTitle} body={emptyBody} action={(searching || multiplayer || tab !== 'trending') ? (
            <button className="link-btn" onClick={() => { setQuery(''); setMultiplayer(false); setTab('trending'); }}>Show trending games</button>
          ) : undefined} />
        ) : (
          <>
            <div className="tile-grid explore-grid">
              {feed.games.map((g) => <ExploreCard key={g.id} game={g} actions={actions} onOpen={() => setDetail(g)} />)}
            </div>
            {feed.error ? <div className="explore-more"><ErrorNote error={feed.error} onRetry={feed.retry} /></div>
              : !feed.done ? (
                <>
                  <Sentinel onHit={feed.more} active={!feed.loading} />
                  <div className="explore-more">{feed.loading ? <span className="muted small">Loading more…</span>
                    : <Button variant="outline" size="sm" onClick={feed.more}>Load more</Button>}</div>
                </>
              ) : feed.games.length > 8 ? <p className="explore-more muted small">That's everything.</p> : null}
          </>
        )}

      <DetailModal game={detail} actions={actions} onClose={() => setDetail(null)} />
      <RemixConfirm game={remixing} own={!!remixing && own(remixing)} busy={remixBusy} error={remixError}
        onConfirm={() => void confirmRemix()} onClose={() => setRemixing(null)} />
      <InsufficientCoinsModal need={need} onClose={() => setNeed(null)} />
      {studio.player}
    </div>
  );
}
