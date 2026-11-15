import { useState } from 'react';
import { api, errorMessage, isActive, metricSummary, type Generation, type GenerationEvent } from '../lib/api';
import { duration, humanId, timeAgo } from '../lib/format';
import { formatEta, humanizePhase, useEtaRemaining, useGenerationStream, type Stream } from '../lib/generation';
import { buildTimeline, latestLine, truncate, type Step } from '../lib/timeline';
import { Icon, PixelSky, Sparkle } from './Icon';
import { Timeline } from './Timeline';
import { AuthedImg, Button, Chip, ProgressPill } from './ui';

export const STATUS_TONE = { queued: 'live', running: 'live', succeeded: 'ok', failed: 'danger', canceled: 'plain' } as const;
export const STATUS_LABEL = { queued: 'Queued', running: 'Building', succeeded: 'Done', failed: 'Failed', canceled: 'Canceled' } as const;

const STAGES = ['Plan', 'Build', 'Test', 'Review'] as const;
const STAGE_OF: Partial<Record<Step['kind'], number>> = {
  route: 0, plan: 0, memory: 0, note: 0, ops: 1, sprites: 1, content: 1, playtest: 2, validate: 2, review: 3, checkpoint: 3, metrics: 3, succeeded: 3,
};

/** Which build stage the latest event belongs to (-1 before planning starts). */
function currentStage(events: GenerationEvent[]) {
  const { steps } = buildTimeline(events);
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = STAGE_OF[steps[i]!.kind];
    if (s != null) return s;
  }
  return -1;
}

function StageDots({ stage }: { stage: number }) {
  return (
    <ol className="stages" aria-label={stage >= 0 ? `Stage: ${STAGES[stage]}` : 'Starting'}>
      {STAGES.map((s, i) => (
        <li key={s} className={i < stage ? 'is-done' : i === stage ? 'is-now' : ''}><span className="stage-dot" />{s}</li>
      ))}
    </ol>
  );
}

/** Pixel-cloud header, stage dots, "Round 2/5 · ~18 min left · Building levels", blue bar, latest line, cancel. */
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
  const queued = status === 'queued';
  const meta = queued ? 'Waiting for a builder' : parts.length ? parts.join(' · ') : 'Starting';

  if (compact) {
    return (
      <div className="progress-card is-compact">
        <div className="progress-card-meta"><Sparkle size={10} className="blue" /> {meta}</div>
        <ProgressPill value={queued ? null : value} size="sm" />
        {line && <p className="progress-card-line">{line}</p>}
      </div>
    );
  }
  return (
    <div className="progress-card">
      <PixelSky preset="strip" className="progress-sky">
        <div className="progress-sky-row">
          <span className="progress-card-title">{queued ? 'queued…' : 'building…'}</span>
          <Button size="sm" variant="outline" icon="stop" busy={canceling}
            onClick={async () => { setCanceling(true); try { await api.cancel(generation.id); } catch (e) { alert(errorMessage(e)); } finally { setCanceling(false); } }}>
            Cancel
          </Button>
        </div>
        <StageDots stage={queued ? -1 : currentStage(stream?.events ?? [])} />
      </PixelSky>
      <div className="progress-card-body">
        <div className="progress-card-meta">{meta}</div>
        <ProgressPill value={queued ? null : value} />
        {line && <p className="progress-card-line">{line}</p>}
      </div>
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
      <div className="msg-me">
        <div className="bubble">
          <p>{long && !showFull ? truncate(generation.prompt, 360) : generation.prompt}</p>
          {long && <button className="link-btn on-blue" onClick={() => setShowFull(!showFull)}>{showFull ? 'Less' : 'Full brief'}</button>}
          {(generation.imageIds.length > 0 || assetIds.length > 0) && (
            <div className="bubble-attach">
              {generation.imageIds.map((id) => (
                <AuthedImg key={id} url={`/v1/uploads/${id}`} alt="reference" className="bubble-img" fallback={<span className="bubble-img" />} />
              ))}
              {assetIds.map((id) => <span key={id} className="mini-chip on-blue">{humanId(id)}</span>)}
            </div>
          )}
        </div>
        <span className="msg-meta">{timeAgo(generation.createdAt)}</span>
      </div>

      <div className="msg-bot">
        <span className="bot-avatar" aria-hidden><Sparkle size={12} /></span>
        <div className={`build-card ${active ? 'is-active' : ''} ${status === 'failed' ? 'is-failed' : ''}`}>
          {active ? <ProgressCard generation={generation} stream={stream} /> : (
            <button className="build-head" onClick={() => setOpen(!open)} aria-expanded={open}>
              <span className="build-title">
                {status === 'succeeded' ? <>Built <span className="vtag">v{generation.resultVersion ?? ''}</span></> : STATUS_LABEL[status]}
              </span>
              {status !== 'succeeded' && <Chip tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Chip>}
              {m.score != null && <span className="score"><Icon name="star" size={13} /> {m.score.toFixed(1)}</span>}
              {generation.startedAt && <span className="build-dur">{duration(generation.startedAt, generation.finishedAt)}</span>}
              <Icon name="chevronDown" size={16} className={`chev ${open ? 'is-open' : ''}`} />
            </button>
          )}
          {!active && status === 'failed' && generation.error && !open && <p className="build-error">{truncate(generation.error, 160)}</p>}
          {open && (
            <div className="build-body">
              <Timeline events={stream?.events ?? []} live={active} onSelectVersion={onSelectVersion} />
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
