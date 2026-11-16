import { useEffect, useState } from 'react';
import { api, currentToken, errorMessage, insufficientCoins, type Game } from '../lib/api';
import { env } from '../lib/env';
import { compactCoins } from '../lib/format';
import { InsufficientCoinsModal, type CoinShortfall } from './Costs';
import { Modal } from './ui';

/**
 * Play a game right in the studio: the same engine the phone app uses (play.dreamsy.dev) in an iframe,
 * signed in as you. Starting goes through pay-per-play like the app (your own games are free).
 */
export function PlayInStudio({ game, version, open, onClose }: { game: Game; version: number; open: boolean; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [need, setNeed] = useState<CoinShortfall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const portrait = (game.orientation ?? 'portrait') === 'portrait';

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

  return (
    <>
      <Modal open={open} onClose={onClose} title={`${game.name} · v${version}`} width={portrait ? 460 : 980}>
        <div className={`studio-player ${portrait ? 'is-portrait' : 'is-landscape'}`}>
          {error ? <p className="form-error">{error}</p>
            : src ? <iframe src={src} title={`Play ${game.name}`} allow="autoplay; fullscreen; gamepad; clipboard-read; clipboard-write" />
            : <div className="studio-player-loading">Starting…</div>}
        </div>
        <p className="muted small studio-player-hint">
          {note ? <b>{note} · </b> : null}Keyboard: arrows/WASD move, Space = A, X = B, C = C · Esc pauses. Click the game first to focus it.
        </p>
      </Modal>
      <InsufficientCoinsModal need={need} onClose={() => setNeed(null)} />
    </>
  );
}
