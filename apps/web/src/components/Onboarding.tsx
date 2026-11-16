import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Game, type OnboardingGame } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Thumb } from './GameCard';
import { Icon, Sparkle } from './Icon';
import { LivePlayerList, OnlineCount, playableVersion, useLive, useStudioPlayer } from './LivePlayers';
import { NewGameModal } from './NewGame';
import { PlayInStudio, type RunEnd } from './PlayInStudio';
import { Button, Modal, Spinner } from './ui';

/**
 * Guided first experience ("Welcome to Dreamsy world"): a brand-new account (me.onboardedAt == null) lands
 * in the onboarding game (GET /v1/onboarding, free first play) with a banner. When the first run ends
 * (runEnd from the engine iframe), they quit or close the player, or after 120 s, the Welcome modal opens
 * and POST /v1/me/onboarding marks it done (once per account, both platforms).
 */

const FALLBACK_MS = 120_000;
const DEFAULT_MESSAGE = 'Your first Dreamsy game — made by AI.';

type Phase =
  | { k: 'idle' }
  | { k: 'playing'; game: Game; version: number; message: string }
  | { k: 'welcome' }
  | { k: 'done' };

/** Minimal Game for the player when GET /v1/games/:id isn't reachable. */
function stubGame(o: OnboardingGame): Game {
  const now = new Date().toISOString();
  return {
    id: o.gameId, ownerId: '', name: o.gameName, description: '', status: 'published',
    latestVersion: o.version, publishedVersion: o.version, publishedAt: null, orientation: 'portrait',
    thumbnailUrl: null, createdAt: now, updatedAt: now,
  };
}

/** "You swam 412 m · #7 today" (distance boards), else "You scored 1,240 · #7 today". */
function resultLine(r: RunEnd | null): string | null {
  if (!r || typeof r.value !== 'number' || !Number.isFinite(r.value)) return null;
  const metres = /dist|meter|metre|depth|swim|run|\bm\b/i.test(r.board ?? '') || !r.board;
  const head = metres ? `You swam ${Math.round(r.value).toLocaleString()} m` : `You scored ${r.value.toLocaleString()}`;
  return typeof r.rank === 'number' && r.rank > 0 ? `${head} · #${r.rank} today` : head;
}

export function Onboarding() {
  const { state, setUser } = useAuth();
  const user = state.status === 'signedIn' ? state.user : null;
  const nav = useNavigate();
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [result, setResult] = useState<RunEnd | null>(null);
  const [bannerOpen, setBannerOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const started = useRef<string | null>(null);
  const marked = useRef(false);

  // Kick off once per account. undefined onboardedAt = older API: skip.
  useEffect(() => {
    if (!user || user.onboardedAt !== null || started.current === user.id) return;
    started.current = user.id;
    // No cancel on cleanup: the user object is replaced on token refresh; `started` dedupes.
    void (async () => {
      try {
        const o = await api.onboarding();
        const game = await api.game(o.gameId).then((r) => r.game, () => stubGame(o));
        setPhase({ k: 'playing', game, version: o.version || playableVersion(game), message: o.message || DEFAULT_MESSAGE });
      } catch { /* endpoint not deployed / no onboarding game: regular studio */ }
    })();
  }, [user]);

  const toWelcome = useCallback((r?: RunEnd) => {
    if (r) setResult(r);
    setPhase((p) => (p.k === 'playing' ? { k: 'welcome' } : p));
  }, []);
  const closePlayer = useCallback(() => toWelcome(), [toWelcome]);

  // 120 s fallback while playing.
  useEffect(() => {
    if (phase.k !== 'playing') return;
    const t = setTimeout(() => toWelcome(), FALLBACK_MS);
    return () => clearTimeout(t);
  }, [phase.k, toWelcome]);

  // Mark done the moment the Welcome modal shows.
  useEffect(() => {
    if (phase.k !== 'welcome' || marked.current) return;
    marked.current = true;
    api.completeOnboarding().then(({ user: u }) => setUser(u), () => { /* retried next sign-in */ });
  }, [phase.k, setUser]);

  return (
    <>
      {phase.k === 'playing' && (
        <PlayInStudio
          game={phase.game}
          version={phase.version}
          open
          onClose={closePlayer}
          onRunEnd={toWelcome}
          onQuit={closePlayer}
          banner={bannerOpen ? (
            <div className="onb-banner" role="note">
              <Sparkle size={14} className="onb-banner-spark" />
              <span>{phase.message}</span>
              <button className="icon-btn sm ghost" aria-label="Dismiss" onClick={() => setBannerOpen(false)}><Icon name="x" size={14} /></button>
            </div>
          ) : null}
        />
      )}
      {phase.k === 'welcome' && (
        <Welcome
          result={resultLine(result)}
          onExplore={() => { setPhase({ k: 'done' }); nav('/'); }}
          onCreate={() => { setPhase({ k: 'done' }); setCreating(true); }}
        />
      )}
      <NewGameModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function Welcome({ result, onExplore, onCreate }: { result: string | null; onExplore: () => void; onCreate: () => void }) {
  const studio = useStudioPlayer();
  const live = useLive(!studio.playing);
  const playing = live.data?.playing ?? [];
  const featured = (live.data?.featured ?? []).slice(0, 6);

  return (
    <>
      <Modal
        open={!studio.playing}
        onClose={onExplore}
        width={760}
        title={<span className="onb-title"><Sparkle size={20} className="onb-title-spark" />Welcome to Dreamsy world</span>}
      >
        <div className="onb">
          <p className="lead onb-sub">Every game here was made by someone typing an idea. Try a few, then make your own.</p>
          {result && <div className="onb-result"><Icon name="trophy" size={16} /><b>{result}</b></div>}

          {live.loading ? (
            <div className="onb-loading"><Spinner size={20} /></div>
          ) : (
            <>
              {live.data && (
                <section className="onb-section">
                  <header className="onb-section-head">
                    <h3 className="h3">Live now</h3>
                    <OnlineCount online={live.data.online} />
                  </header>
                  {playing.length > 0
                    ? <LivePlayerList playing={playing} onPlay={(id) => void studio.play(id)} busy={studio.busy} />
                    : <p className="muted small">Nobody's in a room right now. Try a game below.</p>}
                </section>
              )}

              {featured.length > 0 && (
                <section className="onb-section">
                  <header className="onb-section-head"><h3 className="h3">Try these</h3></header>
                  <div className="onb-games">
                    {featured.map((g) => (
                      <button key={g.id} className="onb-game" onClick={() => void studio.play(g)} title={`Play ${g.name}`}>
                        <div className="onb-game-media">
                          <Thumb url={g.thumbnailUrl} name={g.name} />
                          <span className="onb-game-play"><Icon name="play" size={18} /></span>
                        </div>
                        <span className="onb-game-name">{g.name}</span>
                        {g.creator && <span className="muted small">@{g.creator.handle}</span>}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
          {studio.error && <p className="form-error small">{studio.error}</p>}

          <div className="onb-actions">
            <Button variant="outline" size="lg" onClick={onExplore}>Explore</Button>
            <Button size="lg" icon="plus" onClick={onCreate}>Make your own game</Button>
          </div>
        </div>
      </Modal>
      {studio.player}
    </>
  );
}
