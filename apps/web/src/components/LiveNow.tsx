import { useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { useEffect, useState } from 'react';
import { env } from '../lib/env';

/** Real-time build feed from Convex (services/live/convex/live.ts → feed). */
type Build = { _id: string; genId: string; gameId: string; gameName: string; creator: string; kind: string; status: 'running' | 'succeeded' | 'failed'; lastText: string; steps: number; startedAt: number; updatedAt: number };
type Ev = { _id: string; genId: string; gameName: string; creator: string; type: string; text: string; at: number };
type Feed = { running: Build[]; recentBuilds: Build[]; events: Ev[]; stats: { started: number; succeeded: number; failed: number } };
const feedRef = makeFunctionReference<'query', Record<string, never>, Feed>('live:feed');

const KIND: Record<string, string> = { new_game: 'New game', feature: 'Feature', tweak: 'Tweak', asset: 'Sprite edit' };

function ago(t: number, now: number) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

export function LiveNow() {
  if (!env.convexUrl) return null;
  return <LiveNowInner />;
}

function LiveNowInner() {
  const feed = useQuery(feedRef, {});
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!feed) return null;
  const builds = feed.running.length ? feed.running : feed.recentBuilds.slice(0, 4);
  return (
    <section className="live card">
      <header className="live-head">
        <span className={`live-dot${feed.running.length ? ' on' : ''}`} aria-hidden />
        <h2 className="h3">Live builds</h2>
        <span className="label muted">
          {feed.running.length} building · {feed.stats.succeeded} shipped all-time
        </span>
      </header>
      <div className="live-grid">
        <ul className="live-builds">
          {builds.length === 0 && <li className="muted">No builds yet. Start one and it shows up here instantly.</li>}
          {builds.map((b) => (
            <li key={b._id} className={`live-build ${b.status}`}>
              <div className="live-build-top">
                <b>{b.gameName || 'Untitled game'}</b>
                <span className="label muted">{KIND[b.kind] ?? 'Build'} · @{b.creator}</span>
              </div>
              <div className="live-build-step">{b.status === 'running' ? '▸ ' : b.status === 'succeeded' ? '✓ ' : '✕ '}{b.lastText}</div>
              <div className="label muted">{b.steps} steps · started {ago(b.startedAt, now)} ago</div>
            </li>
          ))}
        </ul>
        <ol className="live-events" aria-live="polite">
          {feed.events.slice(0, 12).map((e) => (
            <li key={e._id}>
              <span className="label muted">{ago(e.at, now)}</span>
              <span><b>{e.gameName || 'Untitled'}</b> {e.text}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
