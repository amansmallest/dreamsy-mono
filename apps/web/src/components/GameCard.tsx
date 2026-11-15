import { Link } from 'react-router-dom';
import { isActive, type Game } from '../lib/api';
import { timeAgo } from '../lib/format';
import { formatEta, useEtaRemaining, etaFromGeneration } from '../lib/generation';
import { Sparkle } from './Icon';
import { AuthedImg, Chip, ProgressPill } from './ui';

export function Thumb({ url, name, className = '' }: { url: string | null | undefined; name: string; className?: string }) {
  return (
    <div className={`thumb ${className}`}>
      <AuthedImg url={url} alt={name} className="thumb-img" fallback={
        <div className="thumb-empty"><Sparkle size={26} /><span className="label">No preview yet</span></div>
      } />
    </div>
  );
}

function RunningBadge({ game }: { game: Game }) {
  const g = game.activeGeneration!;
  const eta = etaFromGeneration(g);
  const remaining = useEtaRemaining(eta);
  const round = eta && eta.rounds > 1 ? `Round ${eta.round}/${eta.rounds}` : g.status === 'queued' ? 'Queued' : 'Building';
  const value = eta && eta.rounds > 1 ? (eta.round - 0.5) / eta.rounds : null;
  return (
    <div className="running-badge">
      <div className="running-badge-top">
        <Sparkle size={11} className="spin-slow" />
        <span>{round}{remaining != null ? ` · ${formatEta(remaining)}` : ''}</span>
      </div>
      <ProgressPill size="sm" value={value} />
    </div>
  );
}

export function GameCard({ game }: { game: Game }) {
  const running = game.activeGeneration && isActive(game.activeGeneration.status);
  return (
    <Link to={`/games/${game.id}`} className="game-card">
      <div className="game-card-media">
        <Thumb url={game.thumbnailUrl} name={game.name} />
        {running && <RunningBadge game={game} />}
      </div>
      <div className="game-card-body">
        <h3 className="game-card-name">{game.name}</h3>
        <div className="game-card-meta">
          {game.status === 'published' ? <Chip tone="ok">Live v{game.publishedVersion}</Chip> : <Chip>Draft</Chip>}
          {game.latestVersion > 0 && <span className="label">v{game.latestVersion}</span>}
          <span className="label muted push">{timeAgo(game.updatedAt)}</span>
        </div>
      </div>
    </Link>
  );
}
