// Turns the raw SSE event list into a readable build timeline (docs/harness.md §5, harness/DESIGN.md "Progress events").
import { metricSummary, type BuildMetrics, type GenerationEvent } from './api';

export type Step =
  | { key: string; kind: 'queued' | 'started' | 'requeued' | 'canceled'; label: string }
  | { key: string; kind: 'route'; label: string; detail?: string; reject?: boolean }
  | { key: string; kind: 'plan'; label: string; text: string }
  | { key: string; kind: 'note'; label: string; text: string }
  | { key: string; kind: 'ops'; label: string; added: number; changed: number; removed: number; scripts: number; files: number; reason: string; batches: number }
  | { key: string; kind: 'sprites'; label: string; ids: string[]; pending: string[]; failed: string[] }
  | { key: string; kind: 'content'; label: string; done: number; total: number }
  | { key: string; kind: 'playtest'; label: string }
  | { key: string; kind: 'validate'; label: string; errors: number }
  | { key: string; kind: 'review'; label: string; score?: number; verdict?: string; fixes?: number }
  | { key: string; kind: 'escalate'; label: string }
  | { key: string; kind: 'round'; label: string }
  | { key: string; kind: 'checkpoint'; label: string; version: number; summary: string }
  | { key: string; kind: 'succeeded'; label: string; version: number }
  | { key: string; kind: 'failed'; label: string; error: string }
  | { key: string; kind: 'memory'; label: string; hits: number; lessons: number }
  | { key: string; kind: 'metrics'; label: string; score: number | null; cost: number | null; minutes: number | null };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const human = (id: string) => id.replace(/[_-]+/g, ' ').trim();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function buildTimeline(events: GenerationEvent[]): { steps: Step[]; working: string | null; cost: number | null } {
  const steps: Step[] = [];
  let working: string | null = null;
  let cost: number | null = null;
  let lastRound = 0;
  const tail = () => steps[steps.length - 1];

  for (const [i, e] of events.entries()) {
    const d = e.data;
    const key = e.id || `${i}`;
    if (e.type !== 'working' && e.type !== 'heartbeat' && e.type !== 'cost') working = null;
    switch (e.type) {
      case 'queued': steps.push({ key, kind: 'queued', label: 'Queued — waiting for a builder' }); break;
      case 'started': steps.push({ key, kind: 'started', label: num(d.attempt) > 1 ? `Started (attempt ${num(d.attempt)})` : 'Builder picked it up' }); break;
      case 'requeued': steps.push({ key, kind: 'requeued', label: 'Hit a snag — retrying' }); break;
      case 'canceled': steps.push({ key, kind: 'canceled', label: 'Canceled' }); break;
      case 'eta': {
        const round = num(d.round);
        if (num(d.rounds) > 1 && round !== lastRound) {
          lastRound = round;
          steps.push({ key, kind: 'round', label: `Round ${round} of ${num(d.rounds)}` });
        }
        break;
      }
      case 'route': {
        const k = str(d.kind);
        const label = k === 'new_game' ? `New ${[str(d.style), str(d.dimension)].filter(Boolean).join(' ') || ''} game`.replace(/\s+/g, ' ')
          : k === 'feature' ? 'New feature' : k === 'tweak' ? 'Quick tweak' : k === 'asset' ? 'New art' : k === 'reject' ? "Can't build that" : 'Planning';
        steps.push({ key, kind: 'route', label, detail: str(d.reason) || undefined, reject: k === 'reject' });
        break;
      }
      case 'plan': steps.push({ key, kind: 'plan', label: 'Plan', text: str(d.text) }); break;
      case 'note': {
        const t = tail();
        if (t?.kind === 'note') t.text += `\n\n${str(d.text)}`;
        else steps.push({ key, kind: 'note', label: 'Notes', text: str(d.text) });
        break;
      }
      case 'ops': {
        const t = tail();
        const v = { added: num(d.added), changed: num(d.changed), removed: num(d.removed), scripts: num(d.scripts), files: num(d.files), reason: str(d.reason) };
        if (t?.kind === 'ops') Object.assign(t, v, { batches: t.batches + 1 });
        else steps.push({ key, kind: 'ops', label: 'Edits', ...v, batches: 1 });
        const s = tail() as Extract<Step, { kind: 'ops' }>;
        const parts = [s.added && `+${plural(s.added, 'entity', 'entities')}`, s.changed && `${s.changed} changed`, s.removed && `−${s.removed} removed`, s.scripts && plural(s.scripts, 'script')].filter(Boolean);
        s.label = parts.length ? parts.join(' · ') : 'Editing';
        break;
      }
      case 'sprite': case 'asset.started': case 'asset.done': case 'asset.failed': {
        let t = tail();
        if (t?.kind !== 'sprites') { t = { key, kind: 'sprites', label: '', ids: [], pending: [], failed: [] }; steps.push(t); }
        const id = str(d.id);
        if (e.type === 'asset.started') t.pending.push(id);
        else {
          t.pending = t.pending.filter((p) => p !== id);
          if (e.type === 'asset.failed') t.failed.push(id);
          else if (!t.ids.includes(id)) t.ids.push(id);
        }
        t.label = t.pending.length ? `Drawing ${human(t.pending[0]!)}…` : `Drew ${plural(t.ids.length, 'sprite')}`;
        break;
      }
      case 'content': {
        const t = tail();
        const label = `Building ${plural(num(d.items), human(str(d.kind)) || 'item')} in parallel`;
        if (t?.kind === 'content') Object.assign(t, { done: num(d.done), total: num(d.items), label });
        else steps.push({ key, kind: 'content', label, done: num(d.done), total: num(d.items) });
        break;
      }
      case 'playtest': steps.push({ key, kind: 'playtest', label: `Playtested${num(d.seconds) ? ` ${num(d.seconds)}s` : ''}${num(d.shots) ? ` · ${plural(num(d.shots), 'screenshot')}` : ''}` }); break;
      case 'validate': steps.push({ key, kind: 'validate', label: num(d.errors) ? `Found ${plural(num(d.errors), 'problem')} — fixing` : 'Validated — all good', errors: num(d.errors) }); break;
      case 'review': steps.push({ key, kind: 'review', label: 'Art director reviewing…' }); break;
      case 'review.done': {
        const t = [...steps].reverse().find((s) => s.kind === 'review' && s.score == null) as Extract<Step, { kind: 'review' }> | undefined;
        const v = { score: num(d.score), verdict: str(d.verdict), fixes: num(d.fixes) };
        const label = `Art director: ${v.score}/10${v.verdict === 'polish' && v.fixes ? ` · ${plural(v.fixes, 'fix', 'fixes')} requested` : ' · approved'}`;
        if (t) Object.assign(t, v, { label }); else steps.push({ key, kind: 'review', label, ...v });
        break;
      }
      case 'escalate': steps.push({ key, kind: 'escalate', label: 'Bringing in a stronger model' }); break;
      case 'checkpoint': steps.push({ key, kind: 'checkpoint', label: `Version ${num(d.version)} ready`, version: num(d.version), summary: str(d.summary) }); break;
      case 'succeeded': steps.push({ key, kind: 'succeeded', label: num(d.version) ? `Done — version ${num(d.version)}` : 'Done', version: num(d.version) }); break;
      case 'failed': steps.push({ key, kind: 'failed', label: 'Build failed', error: str(d.error) }); break;
      case 'working': {
        const what = str(d.what);
        working = what === 'thinking' ? 'Thinking…' : what === 'writing' ? 'Writing…' : what ? `${what.charAt(0).toUpperCase()}${what.slice(1)}…` : null;
        break;
      }
      case 'memory': {
        const hits = num(d.hits);
        const lessons = Array.isArray(d.lessonsUsed) ? d.lessonsUsed.length : num(d.lessonsUsed);
        steps.push({ key, kind: 'memory', label: `Learned from ${plural(hits, 'past build')}${lessons ? ` · ${plural(lessons, 'lesson')} applied` : ''}`, hits, lessons });
        break;
      }
      case 'metrics': {
        const m = metricSummary(d as BuildMetrics);
        steps.push({ key, kind: 'metrics', label: 'Build metrics', ...m });
        break;
      }
      case 'cost.final': cost = (cost ?? 0) + num(d.usd); break;
      default: break;
    }
  }
  return { steps, working, cost };
}

/** One-line description of the latest meaningful step (progress cards, sprite cards). */
export function latestLine(events: GenerationEvent[]): string | null {
  const { steps, working } = buildTimeline(events);
  if (working) return working;
  const s = steps[steps.length - 1];
  if (!s) return null;
  if (s.kind === 'plan' || s.kind === 'note') return truncate(s.text.split('\n').find((l) => l.trim())?.trim() ?? s.label, 90);
  return s.label;
}
