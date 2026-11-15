import { Link } from 'react-router-dom';
import { isActive, type Game } from '../lib/api';
import { compactCoins, DEFAULT_PLAY_PRICE, timeAgo } from '../lib/format';
import { formatEta, useEtaRemaining, etaFromGeneration } from '../lib/generation';
import { Icon, PixelCloud, Sparkle } from './Icon';
import { AuthedImg, Chip, ProgressPill } from './ui';

const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export function Thumb({ url, name, className = '' }: { url: string | null | undefined; name: string; className?: string }) {
  return (
    <div className={`thumb ${className}`}>
      <AuthedImg url={url} alt={name} className="thumb-img" pixelated fallback={
        <div className="thumb-empty"><PixelCloud variant="b" px={4} className="drift" /><span className="thumb-empty-text">no preview yet</span></div>
      } />
    </div>
  );
}

/** Blue ring that rotates while a build runs, with the pixel sparkle at its centre. */
export function BuildRing({ size = 30, queued }: { size?: number; queued?: boolean }) {
  return (
    <span className={`build-ring ${queued ? 'is-queued' : ''}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 36 36" className="build-ring-arc" aria-hidden>
        <circle cx="18" cy="18" r="15.5" className="build-ring-track" />
        <circle cx="18" cy="18" r="15.5" className="build-ring-fill" pathLength={100} />
      </svg>
      <Sparkle size={Math.round(size * 0.36)} />
    </span>
  );
}

function RunningStrip({ game }: { game: Game }) {
  const g = game.activeGeneration!;
  const eta = etaFromGeneration(g);
  const remaining = useEtaRemaining(eta);
  const round = eta && eta.rounds > 1 ? `Round ${eta.round}/${eta.rounds}` : g.status === 'queued' ? 'Queued' : 'Building…';
  const value = eta && eta.rounds > 1 ? (eta.round - 0.5) / eta.rounds : null;
  return (
    <div className="tile-strip">
      <span className="tile-strip-text">{round}{remaining != null ? <span className="muted"> · {formatEta(remaining)}</span> : null}</span>
      <ProgressPill size="sm" value={value} />
    </div>
  );
}

export const playPrice = (g: Pick<Game, 'playPrice'>) => g.playPrice ?? DEFAULT_PLAY_PRICE;

/** "Multiplayer · up to N" — games whose `[players] max` > 1 (rooms: quick match, codes for family). */
export function MultiplayerChip({ game }: { game: Pick<Game, 'multiplayer' | 'players'> }) {
  if (!game.multiplayer || !game.players) return null;
  return <Chip tone="live" icon="users">Multiplayer · up to {game.players.max}</Chip>;
}

export function GameCard({ game }: { game: Game }) {
  const running = !!game.activeGeneration && isActive(game.activeGeneration.status);
  const live = game.status === 'published';
  return (
    <Link to={`/games/${game.id}`} className="tile">
      <div className="tile-media">
        <Thumb url={game.thumbnailUrl} name={game.name} />
        <div className="tile-badges">
          {live ? <Chip tone="ok">Live</Chip> : <Chip>Draft</Chip>}
          <MultiplayerChip game={game} />
        </div>
        {live && !running && <span className="tile-price" title={`${playPrice(game).toLocaleString()} coins per play · you keep 90%`}><Icon name="coin" size={12} />{compactCoins(playPrice(game))} coins/play</span>}
        {running && <span className="tile-ring"><BuildRing queued={game.activeGeneration!.status === 'queued'} /></span>}
        {running && <RunningStrip game={game} />}
      </div>
      <div className="tile-caption">
        <span className="tile-name">{game.name}</span>
        {live ? (
          <span className="tile-meta tile-counts">
            <span title="Likes"><Icon name="heart" size={14} /> {compact(game.stats?.likes ?? 0)}</span>
            <span title="Plays"><Icon name="play" size={13} /> {compact(game.stats?.plays ?? 0)}</span>
          </span>
        ) : (
          <span className="tile-meta">
            {game.latestVersion > 0 && <span className="vtag">v{game.latestVersion}</span>}
            <span>{timeAgo(game.updatedAt)}</span>
          </span>
        )}
      </div>
    </Link>
  );
}
