import { useState } from 'react';
import { BarList, LineChart } from '../components/Charts';
import { Icon, PixelSky } from '../components/Icon';
import { Empty, ErrorNote, Segmented } from '../components/ui';
import { Link } from 'react-router-dom';
import { api, isNotFound, type Insights as Data, type InsightsDay } from '../lib/api';
import { coins, coinsToUsd, compactCoins, DEFAULT_PLAY_PRICE, usd } from '../lib/format';
import { invalidate, useResource } from '../lib/store';

const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const rate = (d: InsightsDay) => (d.builds ? (d.succeeded / d.builds) * 100 : null);

/** Align two daily series on the union of dates. */
function align(a: InsightsDay[], b: InsightsDay[]) {
  const dates = [...new Set([...a, ...b].map((d) => d.date))].sort();
  const ma = new Map(a.map((d) => [d.date, d]));
  const mb = new Map(b.map((d) => [d.date, d]));
  return { dates, a: dates.map((d) => ma.get(d) ?? null), b: dates.map((d) => mb.get(d) ?? null) };
}

/** First-week vs last-week average, as % change. */
function trend(vals: (number | null)[]) {
  const k = Math.max(1, Math.min(7, Math.floor(vals.length / 3)));
  const first = avg(vals.slice(0, k));
  const last = avg(vals.slice(-k));
  return first && last != null ? ((last - first) / first) * 100 : null;
}

export function Insights() {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const mine = useResource(`insights:mine:${days}`, () => api.insightsMine(Number(days)));
  const engine = useResource(`insights:engine:${days}`, () => api.insightsEngine(Number(days)));
  const err = mine.error ?? engine.error;

  return (
    <div className="page">
      <section className="page-head">
        <h1 className="display">insights</h1>
        <Segmented value={days} onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
      </section>
      <EarningsSection />
      <div className="section-head compact"><h2 className="h2">Builds</h2></div>
      {err ?<ErrorNote error={err} onRetry={() => { mine.refetch(); engine.refetch(); }} />
        : !mine.data || !engine.data ? <><div className="headlines">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton skel-headline" />)}</div><div className="insights-grid">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton skel-chart" />)}</div></>
        : <Body mine={mine.data} engine={engine.data} days={days} />}
    </div>
  );
}

function Body({ mine, engine, days }: { mine: Data; engine: Data; days: string }) {
  if (!engine.daily.length && !mine.daily.length) return <Empty title="No builds in this window" body="Try a longer range." />;
  const { dates, a: e, b: m } = align(engine.daily, mine.daily);
  const up = trend(e.map((d) => d?.avgArtScore ?? null));
  const pick = (rows: (InsightsDay | null)[], f: (d: InsightsDay) => number | null) => rows.map((d) => (d ? f(d) : null));
  const two = (f: (d: InsightsDay) => number | null) => [
    { name: 'Engine', values: pick(e, f) },
    { name: 'Mine', values: pick(m, f), dashed: true },
  ];

  return (
    <>
      <div className="headlines">
        <PixelSky preset="card" className="headline is-sky">
          <span className="kicker">Engine quality</span>
          <div className="headline-num">{up == null ? '—' : `${up >= 0 ? '↑' : '↓'} ${Math.abs(up).toFixed(0)}%`}</div>
          <span className="small">art-director score over {days} days</span>
        </PixelSky>
        <div className="card headline">
          <span className="kicker">Your builds</span>
          <div className="headline-num">{mine.totals.builds}</div>
          <span className="small muted">{mine.totals.builds ? `${Math.round((mine.totals.succeeded / mine.totals.builds) * 100)}% succeeded` : 'none yet'}</span>
        </div>
        <div className="card headline">
          <span className="kicker">Your art score</span>
          <div className="headline-num">{mine.totals.avgArtScore?.toFixed(1) ?? '—'}<small>/10</small></div>
          <span className="small muted">engine avg {engine.totals.avgArtScore?.toFixed(1) ?? '—'}</span>
        </div>
        <div className="card headline">
          <span className="kicker">Cost per build</span>
          <div className="headline-num">{mine.totals.avgCostUsd != null ? `$${mine.totals.avgCostUsd.toFixed(2)}` : '—'}</div>
          <span className="small muted">{engine.totals.memoryItems != null ? `${engine.totals.memoryItems.toLocaleString()} lessons in memory` : `engine $${engine.totals.avgCostUsd?.toFixed(2) ?? '—'}`}</span>
        </div>
      </div>

      <div className="insights-grid">
        <ChartCard wide title="Art-director score" sub="Daily average, out of 10">
          <LineChart dates={dates} series={two((d) => d.avgArtScore)} min={0} max={10} height={240} />
        </ChartCard>
        <ChartCard title="Success rate" sub="% of builds that finished">
          <LineChart dates={dates} series={two(rate)} min={0} max={100} format={(v) => `${Math.round(v)}%`} />
        </ChartCard>
        <ChartCard title="Learned from past builds" sub="Lessons reused per build, engine-wide">
          <LineChart dates={dates} series={[{ name: 'Memory hits', values: pick(e, (d) => d.avgMemoryHits) }]} area />
        </ChartCard>
        <ChartCard title="Cost per build" sub="USD, engine-wide">
          <LineChart dates={dates} series={[{ name: 'Cost', values: pick(e, (d) => d.avgCostUsd) }]} format={(v) => `$${v.toFixed(2)}`} />
        </ChartCard>
        <ChartCard title="Minutes per build" sub="Engine-wide">
          <LineChart dates={dates} series={[{ name: 'Minutes', values: pick(e, (d) => d.avgMinutes) }]} format={(v) => `${Math.round(v)}m`} />
        </ChartCard>
        <ChartCard title="Sprites reused" sub="% pulled from earlier builds">
          <LineChart dates={dates} series={[{ name: 'Reused', values: pick(e, (d) => d.spritesReusedPct) }]} min={0} max={100} format={(v) => `${Math.round(v)}%`} area />
        </ChartCard>
        <ChartCard title="By kit" sub="Builds per genre kit · avg art score">
          <BarList rows={[...engine.byKit].sort((a, b) => b.builds - a.builds).map((k) => ({
            label: k.kit, value: k.builds,
            extra: k.avgArtScore != null ? <><Icon name="star" size={11} /> {k.avgArtScore.toFixed(1)}</> : null,
          }))} />
        </ChartCard>
      </div>
    </>
  );
}

/** Pay-per-play earnings (all-time + today). Hidden while /v1/me/earnings isn't deployed (404). */
function EarningsSection() {
  const r = useResource('earnings', api.earnings);
  if (isNotFound(r.error)) return null;
  const e = r.data;
  const games = e ? [...e.games].sort((a, b) => b.coins - a.coins) : [];
  return (
    <section className="earnings">
      <div className="section-head compact">
        <div className="section-title"><h2 className="h2">Earnings</h2><span className="section-count">You keep 90% of every play</span></div>
        <button className="icon-btn sm ghost" aria-label="Refresh earnings" title="Refresh" onClick={() => { invalidate('earnings'); invalidate('wallet'); }}><Icon name="refresh" size={15} /></button>
      </div>
      {r.error ? <ErrorNote error={r.error} onRetry={r.refetch} />
        : !e ? <div className="headlines">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton skel-headline" />)}</div>
        : (
          <>
            <div className="headlines">
              <PixelSky preset="card" className="headline is-sky">
                <span className="kicker">Total earned</span>
                <div className="headline-num">{usd(e.usd.total)}</div>
                <span className="small">{e.totalCoins.toLocaleString()} coins</span>
              </PixelSky>
              <div className="card headline">
                <span className="kicker">Today</span>
                <div className="headline-num">{usd(e.usd.today)}</div>
                <span className="small muted">{coins(e.todayCoins)}</span>
              </div>
              <div className="card headline">
                <span className="kicker">Paid plays</span>
                <div className="headline-num">{e.paidPlays.toLocaleString()}</div>
                <span className="small muted">plays of your games by others</span>
              </div>
              <div className="card headline">
                <span className="kicker">Your share</span>
                <div className="headline-num">90<small>%</small></div>
                <span className="small muted">{compactCoins(DEFAULT_PLAY_PRICE * 0.9)} of every {compactCoins(DEFAULT_PLAY_PRICE)}-coin play</span>
              </div>
            </div>
            <div className="insights-grid earnings-grid">
              <section className="card chart-card">
                <div className="chart-card-head">
                  <h3 className="h3">By game</h3>
                  <span className="chart-sub">All-time paid plays · own plays and replays within 30 min are free</span>
                </div>
                {games.length === 0 ? (
                  <p className="small muted earn-empty">No paid plays yet. Publish a game: every play by someone else earns you {compactCoins(DEFAULT_PLAY_PRICE * 0.9)} coins.</p>
                ) : (
                  <table className="earn-table">
                    <thead><tr><th>Game</th><th>Plays</th><th>Coins</th><th>$</th></tr></thead>
                    <tbody>
                      {games.map((g) => (
                        <tr key={g.gameId}>
                          <td><Link to={`/games/${g.gameId}`} className="earn-game">{g.name}</Link></td>
                          <td>{g.plays.toLocaleString()}</td>
                          <td title={`${g.coins.toLocaleString()} coins`}>{compactCoins(g.coins)}</td>
                          <td>{usd(coinsToUsd(g.coins))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
              <ChartCard title="Coins per game" sub="All-time, creator share">
                {games.length === 0 ? <p className="small muted earn-empty">Bars appear after your first paid play.</p> : (
                  <div className="earn-bars">
                    <BarList format={compactCoins} rows={games.slice(0, 8).map((g) => ({ label: g.name, value: g.coins, extra: usd(coinsToUsd(g.coins)) }))} />
                  </div>
                )}
              </ChartCard>
            </div>
          </>
        )}
    </section>
  );
}

function ChartCard({ title, sub, children, wide }: { title: string; sub: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`card chart-card ${wide ? 'is-wide' : ''}`}>
      <div className="chart-card-head">
        <h3 className="h3">{title}</h3>
        <span className="chart-sub">{sub}</span>
      </div>
      {children}
    </section>
  );
}
