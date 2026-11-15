// Hand-rolled SVG charts in the Sky palette (blue, navy, sky). Series also differ by line style
// (solid vs dashed) + legend + direct end labels, never by color alone.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type Series = { name: string; values: (number | null)[]; dashed?: boolean };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(480);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
};
const shortDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function LineChart({ dates, series, height = 200, min = 0, max, format = (v) => v.toFixed(1), area }: {
  dates: string[]; series: Series[]; height?: number; min?: number; max?: number; format?: (v: number) => string; area?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 36, r: series.length > 1 ? 64 : 14, t: 12, b: 26 };
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const top = max ?? niceMax(Math.max(min + 1e-9, ...all));
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const n = dates.length;
  const x = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => pad.t + ih - ((v - min) / (top - min)) * ih;
  const ticks = [0, 0.5, 1].map((f) => min + f * (top - min));
  const path = (vals: (number | null)[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const xLabels = n > 1 ? [0, Math.floor((n - 1) / 2), n - 1] : [0];
  const lastIdx = (vals: (number | null)[]) => { for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return i; return -1; };

  return (
    <div className="chart" ref={ref}>
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s, si) => (
            <span key={s.name}><svg width="22" height="8"><line x1="1" y1="4" x2="21" y2="4" className={`chart-line s-${si}`} strokeDasharray={s.dashed ? '4 3' : undefined} /></svg>{s.name}</span>
          ))}
        </div>
      )}
      <svg width={width} height={height} role="img" aria-label={series.map((s) => s.name).join(' vs ')}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left - pad.l) / Math.max(1, iw)) * (n - 1));
          setHover(n ? Math.max(0, Math.min(n - 1, i)) : null);
        }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="chart-tick">{format(t)}</text>
          </g>
        ))}
        {xLabels.map((i) => <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="chart-tick">{dates[i] ? shortDate(dates[i]!) : ''}</text>)}
        {area && series[0] && (
          <path d={`${path(series[0].values)}L${x(lastIdx(series[0].values))},${y(min)}L${x(series[0].values.findIndex((v) => v != null))},${y(min)}Z`} className="chart-area" />
        )}
        {series.map((s, si) => <path key={s.name} d={path(s.values)} className={`chart-line s-${si}`} strokeDasharray={s.dashed ? '6 5' : undefined} />)}
        {series.length > 1 && endLabels(series.map((s) => {
          const i = lastIdx(s.values);
          return i < 0 ? null : { name: s.name, x: x(i) + 8, y: y(s.values[i]!) + 4 };
        })).map((l) => <text key={l.name} x={l.x} y={l.y} className="chart-endlabel">{l.name}</text>)}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="chart-cross" />
            {series.map((s, si) => s.values[hover] != null && (
              <circle key={s.name} cx={x(hover)} cy={y(s.values[hover]!)} r={4.5} className={`chart-dot s-${si} ${s.dashed ? 'hollow' : ''}`} />
            ))}
          </g>
        )}
      </svg>
      {hover != null && dates[hover] && (
        <div className="chart-tip" style={{ left: Math.min(width - 150, Math.max(0, x(hover) + 12)), top: 8 }}>
          <b>{shortDate(dates[hover]!)}</b>
          {series.map((s, si) => (
            <span key={s.name}><i className={`s-${si} ${s.dashed ? 'dash' : ''}`} />{s.name}<em>{s.values[hover] == null ? '—' : format(s.values[hover]!)}</em></span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Push direct end labels apart so they never overlap (≥14px). */
function endLabels(ls: ({ name: string; x: number; y: number } | null)[]) {
  const out = ls.filter((l): l is { name: string; x: number; y: number } => !!l).sort((a, b) => a.y - b.y);
  for (let i = 1; i < out.length; i++) if (out[i]!.y - out[i - 1]!.y < 14) out[i]!.y = out[i - 1]!.y + 14;
  return out;
}

export function BarList({ rows, format = (v) => String(v), note }: { rows: { label: string; value: number; extra?: ReactNode }[]; format?: (v: number) => string; note?: ReactNode }) {
  const top = Math.max(1, ...rows.map((r) => r.value));
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="barlist">
      {rows.map((r, i) => (
        <div key={r.label} className={`barlist-row ${hover === i ? 'is-hover' : ''}`} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
          <span className="barlist-label">{r.label}</span>
          <div className="barlist-track"><div className="barlist-fill" style={{ width: `${(r.value / top) * 100}%` }} /></div>
          <span className="barlist-value">{format(r.value)}</span>
          {r.extra && <span className="barlist-extra">{r.extra}</span>}
        </div>
      ))}
      {note}
    </div>
  );
}
