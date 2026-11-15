import { useState } from 'react';
import { api, errorMessage, isActive, metricSummary, type Generation } from '../lib/api';
import { duration, humanId, timeAgo } from '../lib/format';
import { formatEta, humanizePhase, useEtaRemaining, useGenerationStream, type Stream } from '../lib/generation';
import { latestLine, truncate } from '../lib/timeline';
import { Icon, Sparkle } from './Icon';
import { Timeline } from './Timeline';
import { AuthedImg, Button, Chip, ProgressPill } from './ui';

export const STATUS_TONE = { queued: 'live', running: 'live', succeeded: 'ok', failed: 'danger', canceled: 'plain' } as const;
export const STATUS_LABEL = { queued: 'Queued', running: 'Building', succeeded: 'Done', failed: 'Failed', canceled: 'Canceled' } as const;

/** "Round 2/5 · ~18 min left · Building levels" + bar + latest line + cancel. */
export function ProgressCard({ generation, stream, compact }: { generation: Generation; stream: Stream | null; compact?: boolean }) {
  const eta = stream?.eta ?? null;
  const remaining = useEtaRemaining(eta);
  const [canceling, setCanceling] = useState(false);
  const status = stream?.status ?? generation.status;
  const parts: string[] = [];
  if (eta && eta.rounds > 1) parts.push(`Round ${eta.round}/${eta.rounds}`);
  if (remaining != null) parts.push(formatEta(remaining));
  if (eta?.phase) parts.push(humanizePhase(eta.phase));
  const started = generation.startedAt ? new Date(generation.startedAt).getTime() : null;
  let value: number | null = null;
  if (remaining != null && started) {
    const elapsed = (Date.now() - started) / 1000;
    value = elapsed / (elapsed + remaining);
  } else if (eta && eta.rounds > 1) value = (eta.round - 0.5) / eta.rounds;
  const line = stream ? latestLine(stream.events) : null;
  return (
    <div className={`progress-card ${compact ? 'is-compact' : ''}`}>
      <div className="progress-card-head">
        <Sparkle size={14} className="spin-slow" />
        <span className="progress-card-title">{status === 'queued' ? 'Waiting for a builder' : parts.length ? parts.join(' · ') : 'Building'}</span>
        {!compact && (
          <Button size="sm" variant="outline" icon="stop" busy={canceling}
            onClick={async () => { setCanceling(true); try { await api.cancel(generation.id); } catch (e) { alert(errorMessage(e)); } finally { setCanceling(false); } }}>
            Cancel
          </Button>
        )}
      </div>
      <ProgressPill value={status === 'queued' ? null : value} size={compact ? 'sm' : 'md'} />
      {line && <p className="progress-card-line">{line}</p>}
    </div>
  );
}

export function BuildEntry({ generation, defaultOpen, onFinished, onCheckpoint, onSelectVersion, stream: external }: {
  generation: Generation;
  /** Stream owned by the parent (the workspace follows the active build once and shares it). */
  stream?: Stream | null;
  defaultOpen?: boolean;
  onFinished?: (g: Generation) => void;
  onCheckpoint?: (v: number) => void;
  onSelectVersion?: (v: number) => void;
}) {
  const active = isActive(generation.status);
  const [open, setOpen] = useState(!!defaultOpen || active);
  const own = useGenerationStream(generation, { enabled: external === undefined && (open || active), onFinished, onCheckpoint });
  const stream = external === undefined ? own : external;
  const [showFull, setShowFull] = useState(false);
  const status = active ? (stream?.status ?? generation.status) : generation.status;
  const m = metricSummary(generation.metrics);
  const long = generation.prompt.length > 360;
  const assetIds = generation.assetIds ?? [];

  return (
    <article className="build">
      <div className="bubble-row">
        <div className="bubble">
          <p>{long && !showFull ? truncate(generation.prompt, 360) : generation.prompt}</p>
          {long && <button className="link-btn on-ink" onClick={() => setShowFull(!showFull)}>{showFull ? 'Less' : 'Full brief'}</button>}
          {(generation.imageIds.length > 0 || assetIds.length > 0) && (
            <div className="bubble-attach">
              {generation.imageIds.map((id) => (
                <AuthedImg key={id} url={`/v1/uploads/${id}`} alt="reference" className="bubble-img" fallback={<span className="bubble-img" />} />
              ))}
              {assetIds.map((id) => <span key={id} className="mini-chip on-ink"><Sparkle size={9} /> {humanId(id)}</span>)}
            </div>
          )}
        </div>
        <span className="bubble-meta label">{timeAgo(generation.createdAt)}</span>
      </div>

      <div className={`build-card ${active ? 'is-active' : ''}`}>
        <button className="build-head" onClick={() => !active && setOpen(!open)} aria-expanded={open}>
          <span className="build-mark"><Sparkle size={13} /></span>
          <span className="build-title">
            {active ? 'Dreamsy is building' : status === 'succeeded' ? `Built version ${generation.resultVersion ?? ''}` : STATUS_LABEL[status]}
          </span>
          <Chip tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Chip>
          {m.score != null && <Chip icon="star">{m.score.toFixed(1)}</Chip>}
          {!active && generation.startedAt && <span className="label">{duration(generation.startedAt, generation.finishedAt)}</span>}
          {!active && <Icon name="chevronDown" size={16} className={`chev ${open ? 'is-open' : ''}`} />}
        </button>
        {active && <ProgressCard generation={generation} stream={stream} />}
        {open && (
          <div className="build-body">
            <Timeline events={stream?.events ?? []} live={active} onSelectVersion={onSelectVersion} />
          </div>
        )}
        {!active && status === 'failed' && generation.error && !open && <p className="build-error">{truncate(generation.error, 160)}</p>}
      </div>
    </article>
  );
}
