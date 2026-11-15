import { useState } from 'react';
import { BarList, LineChart } from '../components/Charts';
import { Doodles, Icon, Sparkle } from '../components/Icon';
import { Empty, ErrorNote, Segmented } from '../components/ui';
import { api, type Insights as Data, type InsightsDay } from '../lib/api';
import { useResource } from '../lib/store';

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
      <section className="hero compact">
        <Doodles variant="c" />
        <div>
          <span className="label">How the builder is learning</span>
          <h1 className="display">Insights</h1>
        </div>
        <Segmented value={days} onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
      </section>
      {err ? <ErrorNote error={err} onRetry={() => { mine.refetch(); engine.refetch(); }} />
        : !mine.data || !engine.data ? <div className="insights-grid">{Array.from({ length: 6 }, (_, i) => <div key={i} className="card chart-card skeleton" />)}</div>
        : <Body mine={mine.data} engine={engine.data} days={days} />}
    </div>
  );
}

function Body({ mine, engine, days }: { mine: Data; engine: Data; days: string }) {
  if (!engine.daily.length && !mine.daily.length) return <Empty title="No builds in this window" body="Charts fill in as builds finish." />;
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
        <div className="card headline is-ink">
          <Sparkle size={18} className="headline-spark" />
          <span className="label">Engine quality</span>
          <div className="headline-num">{up == null ? '—' : `${up >= 0 ? '↑' : '↓'} ${Math.abs(up).toFixed(0)}%`}</div>
          <span className="small">art-director score over {days} days</span>
        </div>
        <div className="card headline">
          <span className="label">Your builds</span>
          <div className="headline-num">{mine.totals.builds}</div>
          <span className="small muted">{mine.totals.builds ? `${Math.round((mine.totals.succeeded / mine.totals.builds) * 100)}% succeeded` : 'none yet'}</span>
        </div>
        <div className="card headline">
          <span className="label">Your avg art score</span>
          <div className="headline-num">{mine.totals.avgArtScore?.toFixed(1) ?? '—'}<small>/10</small></div>
          <span className="small muted">engine avg {engine.totals.avgArtScore?.toFixed(1) ?? '—'}</span>
        </div>
        <div className="card headline">
          <span className="label">Avg cost / build</span>
          <div className="headline-num">{mine.totals.avgCostUsd != null ? `$${mine.totals.avgCostUsd.toFixed(2)}` : '—'}</div>
          <span className="small muted">{engine.totals.memoryItems != null ? `${engine.totals.memoryItems.toLocaleString()} lessons in memory` : `engine $${engine.totals.avgCostUsd?.toFixed(2) ?? '—'}`}</span>
        </div>
      </div>

      <div className="insights-grid">
        <ChartCard wide title="Art-director score" sub="Average per day, out of 10">
          <LineChart dates={dates} series={two((d) => d.avgArtScore)} min={0} max={10} height={240} />
        </ChartCard>
        <ChartCard title="Success rate" sub="Builds that finished, %">
          <LineChart dates={dates} series={two(rate)} min={0} max={100} format={(v) => `${Math.round(v)}%`} />
        </ChartCard>
        <ChartCard title="Learned from past builds" sub="Avg memory hits per engine build">
          <LineChart dates={dates} series={[{ name: 'Memory hits', values: pick(e, (d) => d.avgMemoryHits) }]} area />
        </ChartCard>
        <ChartCard title="Cost per build" sub="Average USD, engine-wide">
          <LineChart dates={dates} series={[{ name: 'Cost', values: pick(e, (d) => d.avgCostUsd) }]} format={(v) => `$${v.toFixed(2)}`} />
        </ChartCard>
        <ChartCard title="Minutes per build" sub="Average wall time, engine-wide">
          <LineChart dates={dates} series={[{ name: 'Minutes', values: pick(e, (d) => d.avgMinutes) }]} format={(v) => `${Math.round(v)}m`} />
        </ChartCard>
        <ChartCard title="Sprites reused" sub="Share of sprites pulled from earlier builds">
          <LineChart dates={dates} series={[{ name: 'Reused', values: pick(e, (d) => d.spritesReusedPct) }]} min={0} max={100} format={(v) => `${Math.round(v)}%`} area />
        </ChartCard>
        <ChartCard title="By kit" sub="Engine builds per genre kit · avg score">
          <BarList rows={[...engine.byKit].sort((a, b) => b.builds - a.builds).map((k) => ({
            label: k.kit, value: k.builds,
            extra: k.avgArtScore != null ? <><Icon name="star" size={11} /> {k.avgArtScore.toFixed(1)}</> : null,
          }))} />
        </ChartCard>
      </div>
    </>
  );
}

function ChartCard({ title, sub, children, wide }: { title: string; sub: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`card chart-card ${wide ? 'is-wide' : ''}`}>
      <h3 className="h3">{title}</h3>
      <span className="label muted">{sub}</span>
      {children}
    </section>
  );
}
