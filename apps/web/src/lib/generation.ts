// Live generation progress: SSE over fetch streaming (needs the bearer, so no EventSource), with
// Last-Event-ID resume, exponential backoff, and a polling fallback. Mirrors apps/mobile/src/generationProgress.ts.
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, authedFetch, isActive, type Generation, type GenerationEvent, type GenerationStatus } from './api';

const POLL_MS = 1500;

export async function streamEvents(
  generationId: string,
  opts: { lastEventId?: string | null; signal: AbortSignal; onEvent: (e: GenerationEvent) => void },
): Promise<void> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (opts.lastEventId) headers['Last-Event-ID'] = opts.lastEventId;
  const res = await authedFetch(`/v1/generations/${encodeURIComponent(generationId)}/events`, { headers, signal: opts.signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('stream unsupported');
  const decoder = new TextDecoder();
  let buffer = '';
  let id: string | null = null;
  let type = 'message';
  let data: string[] = [];
  const dispatch = () => {
    if (data.length) {
      let parsed: unknown = null;
      try { parsed = JSON.parse(data.join('\n')); } catch { /* keep {} */ }
      opts.onEvent({ id: id ?? '', type, data: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {} });
    }
    id = null; type = 'message'; data = [];
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') { dispatch(); continue; }
      if (line.startsWith(':')) continue;
      const c = line.indexOf(':');
      const field = c === -1 ? line : line.slice(0, c);
      let val = c === -1 ? '' : line.slice(c + 1);
      if (val.startsWith(' ')) val = val.slice(1);
      if (field === 'id') id = val;
      else if (field === 'event') type = val;
      else if (field === 'data') data.push(val);
    }
  }
}

export type Eta = { round: number; rounds: number; phase: string; etaSeconds: number | null; at: number };

export type Stream = { events: GenerationEvent[]; eta: Eta | null; status: GenerationStatus; done: boolean };

export function etaFromGeneration(g: Generation): Eta | null {
  if (!g.progress && g.etaSeconds == null) return null;
  return { round: g.progress?.round ?? 0, rounds: g.progress?.rounds ?? 0, phase: g.progress?.phase ?? '', etaSeconds: g.etaSeconds ?? null, at: Date.now() };
}

const statusFromEvent = (t: string): GenerationStatus | null =>
  t === 'queued' || t === 'requeued' ? 'queued' : t === 'started' ? 'running'
    : t === 'succeeded' || t === 'failed' || t === 'canceled' ? t : null;

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); r(); });
});

/**
 * Replays a generation's events from the start and, while it's active, follows it.
 * `onFinished` fires once with the final record; `onCheckpoint` for each checkpoint version.
 */
export function useGenerationStream(
  generation: Generation | null,
  opts: { enabled?: boolean; onFinished?: (g: Generation) => void; onCheckpoint?: (version: number) => void } = {},
): Stream | null {
  const [s, setS] = useState<Stream | null>(null);
  const cb = useRef(opts);
  cb.current = opts;
  const genRef = useRef(generation);
  genRef.current = generation;
  const enabled = opts.enabled ?? true;
  const id = generation && enabled ? generation.id : null;

  useEffect(() => {
    if (!id) { setS(null); return; }
    const seed = genRef.current!;
    const abort = new AbortController();
    const { signal } = abort;
    let last: string | null = null;
    const seen = new Set<string>();
    setS({ events: [], eta: etaFromGeneration(seed), status: seed.status, done: !isActive(seed.status) });

    const onEvent = (e: GenerationEvent) => {
      if (e.id) { if (seen.has(e.id)) return; seen.add(e.id); last = e.id; }
      const st = statusFromEvent(e.type);
      setS((p) => p && {
        ...p,
        events: [...p.events, e],
        status: st ?? p.status,
        eta: e.type === 'eta' ? {
          round: typeof e.data.round === 'number' ? e.data.round : p.eta?.round ?? 0,
          rounds: typeof e.data.rounds === 'number' ? e.data.rounds : p.eta?.rounds ?? 0,
          phase: typeof e.data.phase === 'string' ? e.data.phase : p.eta?.phase ?? '',
          etaSeconds: typeof e.data.etaSeconds === 'number' ? e.data.etaSeconds : null,
          at: Date.now(),
        } : p.eta,
      });
      if (e.type === 'checkpoint' && typeof e.data.version === 'number' && isActive(seed.status)) cb.current.onCheckpoint?.(e.data.version);
    };

    /** Re-read the record; 'active' if it's still going. */
    const check = async (): Promise<'active' | 'done'> => {
      const { generation: g } = await api.generation(id);
      if (isActive(g.status)) {
        setS((p) => p && { ...p, eta: etaFromGeneration(g) ?? p.eta });
        return 'active';
      }
      setS((p) => p && { ...p, status: g.status, done: true });
      if (isActive(seed.status)) cb.current.onFinished?.(g);
      return 'done';
    };

    (async () => {
      let backoff = 1000;
      while (!signal.aborted) {
        try {
          await streamEvents(id, { lastEventId: last, signal, onEvent });
          if (signal.aborted) return;
          if (!isActive(seed.status)) { setS((p) => p && { ...p, done: true }); return; }
          if ((await check()) === 'done') return;
          backoff = 1000;
          await sleep(500, signal);
        } catch (e) {
          if (signal.aborted) return;
          if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408) {
            // Streaming refused: poll the record instead.
            while (!signal.aborted) {
              try { if ((await check()) === 'done') return; } catch { /* retry */ }
              await sleep(POLL_MS, signal);
            }
            return;
          }
          await sleep(backoff, signal);
          backoff = Math.min(backoff * 2, 10_000);
        }
      }
    })();
    return () => abort.abort();
  }, [id]);

  return s;
}

/** Seconds left, counting down locally from the snapshot. */
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

export const humanizePhase = (p: string) => {
  const s = p.replace(/[_.-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
