import { useState } from 'react';
import type { GenerationEvent } from '../lib/api';
import { humanId } from '../lib/format';
import { buildTimeline, type Step } from '../lib/timeline';
import { Icon, Sparkle } from './Icon';
import { ProgressPill } from './ui';

const ICON: Partial<Record<Step['kind'], Parameters<typeof Icon>[0]['name']>> = {
  queued: 'clock', started: 'bolt', requeued: 'refresh', canceled: 'stop', route: 'arrowRight', plan: 'edit', note: 'edit',
  ops: 'layers', sprites: 'image', content: 'grid', playtest: 'play', validate: 'check', review: 'star', escalate: 'bolt',
  round: 'history', failed: 'x', memory: 'history', metrics: 'star',
};

export function Timeline({ events, live, onSelectVersion }: { events: GenerationEvent[]; live?: boolean; onSelectVersion?: (v: number) => void }) {
  const { steps, working, cost } = buildTimeline(events);
  if (!steps.length && !working) return <div className="tl-empty">{live ? 'Connecting to the builder…' : 'No events recorded.'}</div>;
  return (
    <ol className="timeline">
      {steps.map((s, i) => <TimelineStep key={s.key} step={s} last={i === steps.length - 1 && !working} live={live} onSelectVersion={onSelectVersion} />)}
      {working && live && (
        <li className="tl-step is-working">
          <span className="tl-node"><span className="tl-pulse" /></span>
          <div className="tl-body"><span className="tl-label muted">{working}</span></div>
        </li>
      )}
      {!live && cost != null && cost > 0 && (
        <li className="tl-step tl-meta"><span className="tl-node tl-node-dot" /><div className="tl-body"><span className="label">Compute ${cost.toFixed(2)}</span></div></li>
      )}
    </ol>
  );
}

function TimelineStep({ step: s, last, live, onSelectVersion }: { step: Step; last: boolean; live?: boolean; onSelectVersion?: (v: number) => void }) {
  const [open, setOpen] = useState(false);
  const big = s.kind === 'checkpoint' || s.kind === 'succeeded';
  const bad = s.kind === 'failed' || (s.kind === 'route' && s.reject);
  return (
    <li className={`tl-step tl-k-${s.kind} ${big ? 'is-big' : ''} ${bad ? 'is-bad' : ''} ${last && live ? 'is-current' : ''}`}>
      <span className="tl-node">
        {big ? <Sparkle size={14} /> : <Icon name={ICON[s.kind] ?? 'chevronRight'} size={12} />}
      </span>
      <div className="tl-body">
        {s.kind === 'memory' ? (
          <span className="chip chip-memory"><Sparkle size={10} /> {s.label}</span>
        ) : s.kind === 'metrics' ? (
          <div className="tl-metrics">
            {s.score != null && <span><b>{s.score.toFixed(1)}</b>/10 art</span>}
            {s.cost != null && <span><b>${s.cost.toFixed(2)}</b> cost</span>}
            {s.minutes != null && <span><b>{Math.round(s.minutes)}</b> min</span>}
          </div>
        ) : (
          <span className="tl-label">{s.label}</span>
        )}
        {s.kind === 'route' && s.detail && <p className="tl-detail">{s.detail}</p>}
        {(s.kind === 'plan' || s.kind === 'note') && (
          <div className={`tl-text ${open ? 'is-open' : ''}`}>
            <p>{s.text}</p>
            {s.text.length > 220 && <button className="link-btn" onClick={() => setOpen(!open)}>{open ? 'Show less' : `Show full ${s.kind}`}</button>}
          </div>
        )}
        {s.kind === 'ops' && s.reason && <p className="tl-detail">{s.reason}{s.batches > 1 ? ` · ${s.batches} batches` : ''}</p>}
        {s.kind === 'sprites' && (s.ids.length > 0 || s.pending.length > 0) && (
          <div className="tl-chips">
            {s.ids.slice(0, 14).map((id) => <span key={id} className="mini-chip">{humanId(id)}</span>)}
            {s.ids.length > 14 && <span className="mini-chip">+{s.ids.length - 14}</span>}
            {s.pending.map((id) => <span key={id} className="mini-chip is-pending">{humanId(id)}…</span>)}
            {s.failed.map((id) => <span key={id} className="mini-chip is-failed">{humanId(id)} ✕</span>)}
          </div>
        )}
        {s.kind === 'content' && s.total > 0 && (
          <div className="tl-progress"><ProgressPill size="sm" value={s.done / s.total} /><span className="label">{s.done}/{s.total}</span></div>
        )}
        {s.kind === 'review' && s.score != null && (
          <div className="score-row">
            {Array.from({ length: 10 }, (_, i) => <span key={i} className={`score-dot ${i < Math.round(s.score!) ? 'on' : ''}`} />)}
          </div>
        )}
        {s.kind === 'checkpoint' && (
          <div className="tl-cp-body">
            {s.summary && <p>{s.summary}</p>}
            {onSelectVersion && <button className="link-btn" onClick={() => onSelectVersion(s.version)}>View v{s.version} <Icon name="arrowRight" size={12} /></button>}
          </div>
        )}
        {s.kind === 'succeeded' && s.version > 0 && onSelectVersion && (
          <button className="link-btn" onClick={() => onSelectVersion(s.version)}>View v{s.version} <Icon name="arrowRight" size={12} /></button>
        )}
        {s.kind === 'failed' && s.error && <p className="tl-detail tl-error">{s.error}</p>}
      </div>
    </li>
  );
}
