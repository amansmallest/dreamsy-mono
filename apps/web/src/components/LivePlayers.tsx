import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, isNotFound, type Game, type Live, type LivePlayer } from '../lib/api';
import { roomLink } from '../lib/env';
import { Icon } from './Icon';
import { PlayInStudio } from './PlayInStudio';
import { QrCode } from './PlayOnPhone';
import { Avatar, Button } from './ui';

/**
 * Who's playing right now (GET /v1/live). Multiplayer lives on the phone, so Join / Spectate show a QR
 * into the app; Play opens the game in the studio player.
 */

const REFRESH_MS = 20_000;

/** Polls GET /v1/live every 20 s while `enabled` (skips hidden tabs). `gone` = endpoint not deployed (404). */
export function useLive(enabled = true) {
  const [data, setData] = useState<Live | null>(null);
  const [gone, setGone] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled || gone) return;
    let alive = true;
    const load = () => {
      if (document.visibilityState === 'hidden' && data) return;
      api.live().then(
        (d) => { if (alive) { setData(d); setFailed(false); } },
        (e) => { if (!alive) return; if (isNotFound(e)) setGone(true); else setFailed(true); },
      );
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
    // `data` only gates the hidden-tab skip; don't restart the interval on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, gone]);
  return { data, gone, failed, loading: enabled && !gone && !failed && !data };
}

export const playableVersion = (g: Pick<Game, 'publishedVersion' | 'latestVersion'>) => g.publishedVersion ?? g.latestVersion;

/** Open any game (object or id) in the in-studio player. Render `player`. */
export function useStudioPlayer() {
  const [target, setTarget] = useState<{ game: Game; version: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => setTarget(null), []);
  const play = useCallback(async (g: Game | string) => {
    setError(null);
    let game: Game;
    if (typeof g === 'string') {
      setBusy(g);
      try { game = (await api.game(g)).game; } catch (e) { setError(errorMessage(e)); return; } finally { setBusy(null); }
    } else game = g;
    const version = playableVersion(game);
    if (!(version > 0)) { setError(`${game.name} has no playable version yet.`); return; }
    setTarget({ game, version });
  }, []);
  const player = target ? <PlayInStudio game={target.game} version={target.version} open onClose={close} /> : null;
  return { play, busy, error, playing: target != null, player };
}

const statusLine = (p: LivePlayer) => `${p.status === 'in_room' ? 'lobby' : p.mode || 'match'} · ${p.players}/${p.max}`;

export function OnlineCount({ online }: { online: number }) {
  return (
    <span className="online-count">
      <span className={`live-dot${online > 0 ? ' on' : ''}`} aria-hidden />
      {online.toLocaleString()} {online === 1 ? 'person' : 'people'} online
    </span>
  );
}

/** Rows of people in rooms: avatar/handle, game, "1v1 · 2/2" / "lobby · 1/4", Join / Spectate / Play. */
export function LivePlayerList({ playing, onPlay, busy }: { playing: LivePlayer[]; onPlay: (gameId: string) => void; busy?: string | null }) {
  const [qr, setQr] = useState<{ key: string; spectate: boolean } | null>(null);
  return (
    <ul className="live-players">
      {playing.map((p) => {
        const key = `${p.roomCode}:${p.user.id}`;
        const open = qr?.key === key;
        const toggle = (spectate: boolean) => setQr(open && qr?.spectate === spectate ? null : { key, spectate });
        const canSpectate = p.status === 'in_match' && p.spectatable;
        return (
          <li key={key} className={`live-player${open ? ' is-open' : ''}`}>
            <div className="live-player-row">
              <Avatar handle={p.user.handle} size="sm" />
              <div className="live-player-text">
                <b>@{p.user.handle}</b>
                <span className="muted small">{p.gameName} · <span className="live-player-status">{statusLine(p)}</span></span>
              </div>
              <div className="live-player-actions">
                {p.joinable && <Button size="sm" variant={open && !qr?.spectate ? 'dark' : 'solid'} icon="users" onClick={() => toggle(false)}>Join</Button>}
                {canSpectate && <Button size="sm" variant={open && qr?.spectate ? 'dark' : 'outline'} icon="maximize" onClick={() => toggle(true)}>Spectate</Button>}
                <Button size="sm" variant="ghost" icon="play" busy={busy === p.gameId} onClick={() => onPlay(p.gameId)}>Play</Button>
              </div>
            </div>
            {open && qr && (
              <div className="live-player-qr">
                <QrCode value={roomLink(p.gameId, p.roomCode, qr.spectate)} size={112} />
                <div className="live-player-qr-copy">
                  <b>Open in the Dreamsy app</b>
                  <span className="muted small">
                    Scan with your phone camera to {qr.spectate ? 'watch' : 'join'} @{p.user.handle} in {p.gameName}.
                    Multiplayer happens on the phone; the studio is for building.
                  </span>
                  <a className="link-btn small row-icon" href={roomLink(p.gameId, p.roomCode, qr.spectate)}>
                    <Icon name="phone" size={14} /> On your phone? Open the app
                  </a>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Home "Live now" card: refreshes every 20 s, hidden when nobody's playing or the endpoint isn't deployed. */
export function LivePlayersCard() {
  const { data } = useLive();
  const studio = useStudioPlayer();
  if (!data || data.playing.length === 0) return studio.player;
  return (
    <section className="card live-now-card">
      <header className="live-head">
        <h2 className="h3">Live now</h2>
        <span className="label muted"><OnlineCount online={data.online} /></span>
      </header>
      <LivePlayerList playing={data.playing} onPlay={(id) => void studio.play(id)} busy={studio.busy} />
      {studio.error && <p className="form-error small">{studio.error}</p>}
      {studio.player}
    </section>
  );
}
