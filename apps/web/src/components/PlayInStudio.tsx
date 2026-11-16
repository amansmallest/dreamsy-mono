import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, currentToken, errorMessage, insufficientCoins, type Game } from '../lib/api';
import { env } from '../lib/env';
import { compactCoins } from '../lib/format';
import { InsufficientCoinsModal, type CoinShortfall } from './Costs';
import { Modal } from './ui';

/**
 * Play a game right in the studio: the same engine the phone app uses (play.dreamsy.dev) in an iframe,
 * signed in as you. Starting goes through pay-per-play like the app (your own games are free).
 */
/** Engine → host `runEnd` (finish/submit come with the leaderboard result). */
export type RunEnd = { type: 'runEnd'; reason: 'finish' | 'submit' | 'gameover' | 'quit' | (string & {}); board?: string; value?: number; rank?: number };

const engineOrigin = (() => { try { return new URL(env.engineUrl).origin; } catch { return null; } })();

/** Engine messages arrive as an object or a JSON string (same payload as the app's WebView bridge). */
function parseEngineMessage(data: unknown): { type?: unknown } & Record<string, unknown> | null {
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return null; } }
  return data && typeof data === 'object' ? (data as { type?: unknown } & Record<string, unknown>) : null;
}

/** Touch phone (or small touch tablet): the in-studio player goes full screen like the app. */
function useIsPhone(): boolean {
  const q = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches && Math.min(window.innerWidth, window.innerHeight) < 820;
  const [phone, setPhone] = useState(q);
  useEffect(() => { const on = () => setPhone(q()); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  return phone;
}

export function PlayInStudio({ game, version, open, onClose, onRunEnd, onQuit, banner }: {
  game: Game; version: number; open: boolean; onClose: () => void;
  /** The game reported a finished run (iframe postMessage `runEnd`). */
  onRunEnd?: (e: RunEnd) => void;
  /** The player hit Quit inside the game (iframe postMessage `quit`). */
  onQuit?: () => void;
  /** Shown above the player (e.g. the onboarding note). */
  banner?: ReactNode;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const handlers = useRef({ onRunEnd, onQuit });
  handlers.current = { onRunEnd, onQuit };
  const [src, setSrc] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [need, setNeed] = useState<CoinShortfall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const portrait = (game.orientation ?? 'portrait') === 'portrait';
  const phone = useIsPhone();
  const full = useRef<HTMLDivElement>(null);
  // Phones: lock page scroll, ask for real fullscreen (Android/Chrome; iOS Safari ignores it), lock orientation if allowed.
  useEffect(() => {
    if (!open || !phone) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const el = full.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    try { void (el?.requestFullscreen?.({ navigationUI: 'hide' }) ?? el?.webkitRequestFullscreen?.())?.catch?.(() => {}); } catch { /* not allowed */ }
    try { void (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.(portrait ? 'portrait' : 'landscape')?.catch(() => {}); } catch { /* unsupported */ }
    return () => {
      document.body.style.overflow = prev;
      try { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); } catch { /* ignore */ }
    };
  }, [open, phone, portrait]);

  useEffect(() => {
    if (!open) { setSrc(null); setNote(null); setError(null); return; }
    let alive = true;
    (async () => {
      try {
        const r = await api.playStart(game.id).catch((e) => {
          if (insufficientCoins(e)) throw e;
          return null; // older API / transient error: play anyway (same as the app)
        });
        if (!alive) return;
        if (r?.charged) setNote(`−${compactCoins(r.price)} coins · creator earned ${compactCoins(r.creatorEarned)}`);
        const q = new URLSearchParams({ api: env.apiUrl, game: game.id, version: String(version), token: currentToken() ?? '', embed: '1' });
        setSrc(`${env.engineUrl}/?${q}`);
      } catch (e) {
        if (!alive) return;
        const short = insufficientCoins(e);
        if (short) { setNeed({ ...short, action: `Playing ${game.name}` }); onClose(); }
        else setError(errorMessage(e));
      }
    })();
    return () => { alive = false; };
  }, [open, game.id, game.name, version, onClose]);

  // Engine → host messages from our iframe only (origin = the engine, source = this frame).
  useEffect(() => {
    if (!open || !src) return;
    const onMessage = (e: MessageEvent) => {
      if (!engineOrigin || e.origin !== engineOrigin) return;
      if (frame.current && e.source !== frame.current.contentWindow) return;
      const msg = parseEngineMessage(e.data);
      if (msg?.type === 'runEnd') handlers.current.onRunEnd?.(msg as RunEnd);
      else if (msg?.type === 'quit') handlers.current.onQuit?.();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [open, src]);

  return (
    <>
      {phone ? (
        // Phones: play like the app — the whole screen, no modal chrome, page scroll locked.
        open && (
          <div className="player-fullscreen" ref={full}>
            <div className={`player-fullscreen-frame ${portrait ? 'is-portrait' : 'is-landscape'}`}>
              {error ? <p className="form-error">{error}</p>
            : src ? <iframe ref={frame} src={src} title={`Play ${game.name}`} allow="autoplay; fullscreen; gamepad; clipboard-read; clipboard-write" />
            : <div className="studio-player-loading">Starting…</div>}
            </div>
            <button className="player-fullscreen-close" aria-label="Close game" onClick={onClose}>×</button>
            {banner ? <div className="player-fullscreen-banner">{banner}</div> : null}
            {note ? <div className="player-fullscreen-note">{note}</div> : null}
            {!portrait && <div className="rotate-hint">Turn your phone sideways for this game</div>}
          </div>
        )
      ) : (
      <Modal open={open} onClose={onClose} title={`${game.name} · v${version}`} width={portrait ? 460 : 980}>
        {banner}
        <div className={`studio-player ${portrait ? 'is-portrait' : 'is-landscape'}`}>
          {error ? <p className="form-error">{error}</p>
            : src ? <iframe ref={frame} src={src} title={`Play ${game.name}`} allow="autoplay; fullscreen; gamepad; clipboard-read; clipboard-write" />
            : <div className="studio-player-loading">Starting…</div>}
        </div>
        <p className="muted small studio-player-hint">
          {note ? <b>{note} · </b> : null}Keyboard: arrows/WASD move, Space = A, X = B, C = C · Esc pauses. Click the game first to focus it.
        </p>
      </Modal>
      )}
      <InsufficientCoinsModal need={need} onClose={() => setNeed(null)} />
    </>
  );
}
