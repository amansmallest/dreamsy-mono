// Live progress for one generation: SSE over expo/fetch streaming (RN has no EventSource), with
// Last-Event-ID resume on reconnect, and a 1.5s polling fallback if streaming isn't available.

import { fetch as expoFetch } from 'expo/fetch';
import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  apiErrorFrom,
  authedRequestInit,
  isActiveGeneration,
  type Generation,
  type GenerationEvent,
  type GenerationStatus,
  type BuildProgress,
} from './api';

class StreamingUnsupported extends Error {}

const TERMINAL_EVENTS = new Set(['succeeded', 'failed', 'canceled']);
const POLL_MS = 1500;

/**
 * Read GET /v1/generations/:id/events until the server closes it (generation terminal) or `signal`
 * aborts. Calls onEvent for each event. Throws ApiError on HTTP errors, StreamingUnsupported if the
 * response has no readable body.
 */
export async function streamGenerationEvents(
  generationId: string,
  opts: { lastEventId?: string | null; signal: AbortSignal; onEvent: (e: GenerationEvent) => void },
): Promise<void> {
  const { url, headers } = await authedRequestInit();
  const reqHeaders: Record<string, string> = { ...headers, Accept: 'text/event-stream' };
  if (opts.lastEventId) reqHeaders['Last-Event-ID'] = opts.lastEventId;

  const res = await expoFetch(`${url}/v1/generations/${encodeURIComponent(generationId)}/events`, {
    headers: reqHeaders,
    signal: opts.signal,
  });
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    throw apiErrorFrom(res.status, data, !!headers.Authorization);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new StreamingUnsupported('response body is not streamable');

  const decoder = new TextDecoder();
  let buffer = '';
  // Fields of the event being assembled.
  let id: string | null = null;
  let type = 'message';
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(data.join('\n'));
      } catch {}
      opts.onEvent({
        id: id ?? '',
        type,
        data: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {},
      });
    }
    id = null;
    type = 'message';
    data = [];
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        dispatch();
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let val = colon === -1 ? '' : line.slice(colon + 1);
      if (val.startsWith(' ')) val = val.slice(1);
      if (field === 'id') id = val;
      else if (field === 'event') type = val;
      else if (field === 'data') data.push(val);
    }
  }
}

/** ETA snapshot: `etaSeconds` was the estimate at `at` (Date.now() ms); count down locally from there. */
export type Eta = BuildProgress & { etaSeconds: number | null; at: number };

export type Progress = {
  events: GenerationEvent[];
  /** Latest round/phase/ETA (from `eta` events or the generation record); null for short builds. */
  eta: Eta | null;
  /** Latest known status (from events or polling). */
  status: GenerationStatus;
  /** 'stream' while SSE works; 'poll' after falling back. */
  mode: 'stream' | 'poll';
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/** ETA from a generation record (as fetched now). */
export function etaFromGeneration(g: Generation): Eta | null {
  if (!g.progress && g.etaSeconds == null) return null;
  return {
    round: g.progress?.round ?? 0,
    rounds: g.progress?.rounds ?? 0,
    phase: g.progress?.phase ?? '',
    etaSeconds: g.etaSeconds ?? null,
    at: Date.now(),
  };
}

const etaFromEvent = (d: Record<string, unknown>, prev: Eta | null): Eta => ({
  round: typeof d.round === 'number' ? d.round : (prev?.round ?? 0),
  rounds: typeof d.rounds === 'number' ? d.rounds : (prev?.rounds ?? 0),
  phase: typeof d.phase === 'string' ? d.phase : (prev?.phase ?? ''),
  etaSeconds: typeof d.etaSeconds === 'number' ? d.etaSeconds : null,
  at: Date.now(),
});

const statusFromEvent = (type: string): GenerationStatus | null => {
  if (type === 'queued' || type === 'requeued') return 'queued';
  if (type === 'started') return 'running';
  if (TERMINAL_EVENTS.has(type)) return type as GenerationStatus;
  return null;
};

/**
 * Follow an active generation. `onFinished` fires once with the final generation record.
 * `onCheckpoint` fires for each `checkpoint` event: a new playable version mid-build. Live events
 * only; replayed ones (stream resume from the start) are skipped by version.
 * Pass null (or a terminal generation) to do nothing.
 */
export function useGenerationProgress(
  generation: Generation | null,
  onFinished: (g: Generation) => void,
  onCheckpoint?: (version: number, summary: string) => void,
): Progress | null {
  const [progress, setProgress] = useState<Progress | null>(null);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const onCheckpointRef = useRef(onCheckpoint);
  onCheckpointRef.current = onCheckpoint;
  const generationRef = useRef(generation);
  generationRef.current = generation;

  const activeId = generation && isActiveGeneration(generation.status) ? generation.id : null;
  const initialStatus = generation?.status ?? 'queued';

  useEffect(() => {
    if (!activeId) {
      setProgress(null);
      return;
    }
    const abort = new AbortController();
    const { signal } = abort;
    let lastEventId: string | null = null;
    let lastCheckpoint = 0;
    const seed = generationRef.current;
    setProgress({ events: [], eta: seed ? etaFromGeneration(seed) : null, status: initialStatus, mode: 'stream' });

    const onEvent = (e: GenerationEvent) => {
      if (e.id) lastEventId = e.id;
      const s = statusFromEvent(e.type);
      setProgress(
        (p) =>
          p && {
            ...p,
            events: [...p.events, e],
            status: s ?? p.status,
            eta: e.type === 'eta' ? etaFromEvent(e.data, p.eta) : p.eta,
          },
      );
      if (e.type === 'checkpoint' && typeof e.data.version === 'number' && e.data.version > lastCheckpoint) {
        lastCheckpoint = e.data.version;
        onCheckpointRef.current?.(e.data.version, typeof e.data.summary === 'string' ? e.data.summary : '');
      }
    };

    const finish = async () => {
      // Re-read so callers get resultVersion / error.
      for (let i = 0; i < 5 && !signal.aborted; i++) {
        try {
          const { generation: g } = await api.generation(activeId);
          setProgress((p) => p && { ...p, status: g.status, eta: etaFromGeneration(g) ?? p.eta });
          if (!isActiveGeneration(g.status)) {
            onFinishedRef.current(g);
            return;
          }
          return 'still-active' as const;
        } catch {
          await sleep(POLL_MS, signal);
        }
      }
    };

    const poll = async () => {
      setProgress((p) => p && { ...p, mode: 'poll' });
      while (!signal.aborted) {
        if ((await finish()) !== 'still-active') return;
        await sleep(POLL_MS, signal);
      }
    };

    (async () => {
      let backoff = 1000;
      while (!signal.aborted) {
        try {
          await streamGenerationEvents(activeId, { lastEventId, signal, onEvent });
          if (signal.aborted) return;
          // Server closes the stream once the generation is terminal; otherwise it closed early
          // (proxy timeout etc.) and we resume from lastEventId.
          if ((await finish()) !== 'still-active') return;
          backoff = 1000;
        } catch (e) {
          if (signal.aborted) return;
          if (e instanceof StreamingUnsupported) return poll();
          // 4xx other than timeouts won't get better by retrying the stream.
          if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408) {
            return poll();
          }
          await sleep(backoff, signal);
          backoff = Math.min(backoff * 2, 10_000);
        }
      }
    })();

    return () => abort.abort();
    // initialStatus only seeds the state; don't restart the stream when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  return progress;
}

// ---------- friendly lines ----------

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const humanize = (id: string) => id.replace(/[_-]+/g, ' ').trim();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One short line per event for the progress feed; null = don't show. */
export function describeEvent(e: GenerationEvent): string | null {
  const d = e.data;
  switch (e.type) {
    case 'queued':
      return 'Waiting for a builder…';
    case 'started':
      return num(d.attempt) > 1 ? `Starting again (attempt ${num(d.attempt)})…` : 'Starting…';
    case 'requeued':
      return 'Hit a snag, retrying…';
    case 'route': {
      const kind = str(d.kind);
      if (kind === 'new_game') {
        const style = str(d.style);
        const dim = str(d.dimension);
        return `Planning a ${[style, dim].filter(Boolean).join(' ') || 'new'} game…`;
      }
      if (kind === 'feature') return 'Planning a new feature…';
      if (kind === 'tweak') return 'Planning a tweak…';
      if (kind === 'asset') return 'Planning new art…';
      if (kind === 'reject') return str(d.reason) ? `Can't build that: ${truncate(str(d.reason), 120)}` : "Can't build that one.";
      return 'Planning…';
    }
    case 'plan': {
      const first = str(d.text).split('\n').find((l) => l.trim()) ?? '';
      return first ? truncate(first.trim(), 140) : null;
    }
    case 'ops': {
      const parts: string[] = [];
      if (num(d.added)) parts.push(`+${plural(num(d.added), 'thing')}`);
      if (num(d.changed)) parts.push(`${num(d.changed)} changed`);
      if (num(d.removed)) parts.push(`−${num(d.removed)} removed`);
      if (num(d.scripts)) parts.push(plural(num(d.scripts), 'script'));
      const head = parts.join(', ') || 'Editing';
      return str(d.reason) ? `${head} · ${truncate(str(d.reason), 80)}` : head;
    }
    case 'asset.started':
      return `Painting ${humanize(str(d.id)) || 'art'}…`;
    case 'asset.done':
      return `Painted ${humanize(str(d.id)) || 'art'}`;
    case 'validate':
      return num(d.errors) ? `Found ${plural(num(d.errors), 'problem')}, fixing…` : 'Checked: all good';
    case 'escalate':
      return 'Bringing in a stronger model…';
    case 'checkpoint':
      return num(d.version)
        ? `Version ${num(d.version)} ready${str(d.summary) ? `: ${truncate(str(d.summary), 100)}` : ''}`
        : null;
    case 'succeeded':
      return num(d.version) ? `Done: version ${num(d.version)}` : 'Done';
    case 'failed':
      return `Failed${str(d.error) ? `: ${truncate(str(d.error), 160)}` : ''}`;
    case 'canceled':
      return 'Canceled';
    default:
      // heartbeat, cost, cost.final, note, unknown harness events
      return null;
  }
}

// ---------- build summary (the Claude card) ----------

export const BUILD_STAGES = ['Plan', 'Build', 'Art', 'Test', 'Polish'] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];

export type BuildSummary = {
  /** Index into BUILD_STAGES of the furthest stage reached. */
  stage: number;
  /** What Claude is doing right now ("drawing a sprite"), from the latest working/progress event. */
  activity: string | null;
  /** Readable milestones, oldest first, deduped. */
  log: string[];
  counts: { edits: number; sprites: number; art: number; playtests: number };
  /** Art-director score (0–10) when a review finished. */
  review: { score: number; verdict: string } | null;
  checkpoints: { version: number; summary: string }[];
};

const STAGE_OF: Record<string, BuildStage> = {
  route: 'Plan',
  plan: 'Plan',
  memory: 'Plan',
  ops: 'Build',
  content: 'Build',
  sprite: 'Art',
  'asset.started': 'Art',
  'asset.done': 'Art',
  playtest: 'Test',
  validate: 'Test',
  review: 'Polish',
  'review.done': 'Polish',
};

const WORKING_STAGE: Record<string, BuildStage> = {
  'reading files': 'Plan',
  'inspecting entities': 'Plan',
  building: 'Build',
  'building content in parallel': 'Build',
  'drawing a sprite': 'Art',
  'checking the sprite library': 'Art',
  'painting an asset': 'Art',
  playtesting: 'Test',
  'final check': 'Polish',
};

const ACTIVITY: Record<string, string> = {
  thinking: 'Thinking it through',
  writing: 'Writing',
  'reading files': 'Reading the game',
  'inspecting entities': 'Looking at the scene',
  building: 'Building',
  'building content in parallel': 'Building content with helpers',
  'drawing a sprite': 'Drawing a sprite',
  'checking the sprite library': 'Looking for sprites',
  'painting an asset': 'Painting art',
  playtesting: 'Playtesting',
  'final check': 'Final check',
};

/** Fold the raw harness events into what the build card shows. */
export function summarizeBuild(events: GenerationEvent[]): BuildSummary {
  const out: BuildSummary = {
    stage: 0,
    activity: null,
    log: [],
    counts: { edits: 0, sprites: 0, art: 0, playtests: 0 },
    review: null,
    checkpoints: [],
  };
  const reach = (s: BuildStage | undefined) => {
    if (s) out.stage = Math.max(out.stage, BUILD_STAGES.indexOf(s));
  };
  const push = (line: string | null) => {
    if (line && out.log[out.log.length - 1] !== line) out.log.push(line);
  };
  for (const e of events) {
    const d = e.data;
    reach(STAGE_OF[e.type]);
    switch (e.type) {
      case 'working': {
        const what = str(d.what);
        reach(WORKING_STAGE[what]);
        out.activity = ACTIVITY[what] ?? (what ? humanizePhase(what) : null);
        break;
      }
      case 'ops':
        out.counts.edits++;
        if (str(d.reason)) push(truncate(capitalize(str(d.reason)), 90));
        break;
      case 'sprite':
        out.counts.sprites++;
        break;
      case 'asset.done':
        out.counts.art++;
        break;
      case 'playtest':
        out.counts.playtests++;
        push('Played it to check it works');
        break;
      case 'review.done':
        out.review = { score: num(d.score), verdict: str(d.verdict) };
        push(`Art director: ${num(d.score)}/10${num(d.fixes) ? `, ${plural(num(d.fixes), 'fix', 'fixes')} to make` : ''}`);
        break;
      case 'content':
        if (num(d.items)) push(`Building ${plural(num(d.items), str(d.kind) || 'item')} with ${plural(num(d.workers), 'helper')}`);
        break;
      case 'checkpoint':
        if (num(d.version)) out.checkpoints.push({ version: num(d.version), summary: str(d.summary) });
        push(describeEvent(e));
        break;
      case 'route':
      case 'plan':
      case 'validate':
      case 'escalate':
      case 'requeued':
      case 'failed':
        push(describeEvent(e));
        break;
    }
  }
  return out;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- ETA ----------

/** Seconds left now, counting down from the snapshot; null if unknown. Re-renders every second. */
export function useEtaRemaining(eta: Eta | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  const has = eta?.etaSeconds != null;
  useEffect(() => {
    if (!has) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [has]);
  if (!eta || eta.etaSeconds == null) return null;
  return Math.max(0, eta.etaSeconds - (now - eta.at) / 1000);
}

export function formatEta(seconds: number): string {
  if (seconds < 45) return 'almost done';
  const min = Math.round(seconds / 60);
  if (min < 60) return `~${Math.max(1, min)} min left`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `~${h} h${m ? ` ${m} min` : ''} left`;
}

/** "Round 2/5 · ~18 min left · Building levels" (parts that are known). */
export function etaLine(eta: Eta | null | undefined, remaining: number | null): string | null {
  if (!eta) return null;
  const parts: string[] = [];
  if (eta.rounds > 1) parts.push(`Round ${eta.round}/${eta.rounds}`);
  if (remaining != null) parts.push(formatEta(remaining));
  if (eta.phase) parts.push(humanizePhase(eta.phase));
  return parts.length ? parts.join(' · ') : null;
}

const humanizePhase = (p: string) => {
  const s = p.replace(/[_.-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
