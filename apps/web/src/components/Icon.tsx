import type { CSSProperties, ReactNode, SVGProps } from 'react';

const P: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  image: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5zM4 16l4.5-4.5 4 4 2.5-2.5L20 18M15.5 9.5h.01',
  phone: 'M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM11 18h2',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 8v4l3 2',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6l1-7z',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  refresh: 'M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4',
  maximize: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  minimize: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  stop: 'M8 8h8v8H8z',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  star: 'M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7L12 3z',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  compare: 'M12 3v18M5 7h4M5 12h4M5 17h4M15 7h4M15 12h4M15 17h4',
  alert: 'M12 4l9 16H3l9-16zM12 10v4M12 17h.01',
  play: 'M8 5.5v13l10.5-6.5z',
  heart: 'M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z',
  remix: 'M6 4v5a5 5 0 0 0 5 5h7M15 10.5l3.5 3.5-3.5 3.5',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0V4zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c1-3.5 3.3-5 6-5s5 1.5 6 5M16 4.5a3.5 3.5 0 0 1 0 6.5M18 15c1.5.6 2.5 2.2 3 5',
  share: 'M12 15V4M8 8l4-4 4 4M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5',
  coin: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 0 0 4 0',
  trash:'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      <path d={P[name]} />
    </svg>
  );
}

/** Rows of a pixel grid → one crisp path per fill key (horizontal runs merged). */
function pixelPaths(rows: string[]) {
  const out: Record<string, string> = {};
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x]!;
      if (c === '.') { x++; continue; }
      let w = 1;
      while (row[x + w] === c) w++;
      out[c] = (out[c] ?? '') + `M${x} ${y}h${w}v1h-${w}z`;
      x += w;
    }
  });
  return out;
}

const SPARKLE = pixelPaths(['...#...', '...#...', '..###..', '#######', '..###..', '...#...', '...#...'])['#']!;

/** Four-point sparkle on a 7×7 pixel grid — the brand mark. */
export function Sparkle({ size = 14, className, style }: { size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 7 7" className={className} style={style} shapeRendering="crispEdges" aria-hidden>
      <path d={SPARKLE} fill="currentColor" />
    </svg>
  );
}

const CLOUDS = {
  a: pixelPaths([
    '.......xxxx.........',
    '.....xxxxxxxx.......',
    '...xxxxxxxxxxx.xxx..',
    '..xxxxxxxxxxxxxxxxx.',
    '.xxxxxxxxxxxxxxxxxxx',
    'xxxxxxxxxxxxxxxxxxxx',
    '.ssssssssssssssssss.',
  ]),
  b: pixelPaths([
    '....xxxx....',
    '..xxxxxxxx..',
    '.xxxxxxxxxxx',
    'xxxxxxxxxxxx',
    '.ssssssssss.',
  ]),
  c: pixelPaths([
    '..........xxxx..........',
    '...xxx..xxxxxxxx........',
    '..xxxxxxxxxxxxxxxx.xxx..',
    '.xxxxxxxxxxxxxxxxxxxxxx.',
    'xxxxxxxxxxxxxxxxxxxxxxxx',
    '.ssssssssssssssssssssss.',
  ]),
};
const CLOUD_SIZE = { a: [20, 7], b: [12, 5], c: [24, 6] } as const;
type CloudVariant = keyof typeof CLOUDS;

/** Blocky cloud made of square pixels: body in --cloud, underside in --cloud-shade. */
export function PixelCloud({ variant = 'a', px = 5, className = '', style }: { variant?: CloudVariant; px?: number; className?: string; style?: CSSProperties }) {
  const [w, h] = CLOUD_SIZE[variant];
  const p = CLOUDS[variant];
  return (
    <svg width={w * px} height={h * px} viewBox={`0 0 ${w} ${h}`} className={`pixel-cloud ${className}`} style={style} shapeRendering="crispEdges" aria-hidden>
      <path d={p.x} className="pc-body" />
      <path d={p.s} className="pc-shade" />
    </svg>
  );
}

type CloudSpot = [variant: CloudVariant, left: string, top: string, px: number];
const SKIES: Record<string, { clouds: CloudSpot[]; sparks: [left: string, top: string, size: number][] }> = {
  hero: {
    clouds: [['a', '66%', '12%', 7], ['b', '87%', '44%', 5], ['c', '70%', '66%', 5], ['b', '93%', '80%', 3]],
    sparks: [['93%', '15%', 12], ['62%', '46%', 8]],
  },
  panel: {
    clouds: [['a', '48%', '11%', 9], ['b', '8%', '25%', 6], ['c', '34%', '38%', 6], ['b', '76%', '55%', 4]],
    sparks: [['86%', '7%', 14], ['16%', '48%', 9], ['88%', '38%', 8]],
  },
  strip: { clouds: [['b', '40%', '12%', 3], ['a', '57%', '48%', 3], ['b', '68%', '-6%', 2]], sparks: [] },
  card: { clouds: [['a', '60%', '10%', 4], ['b', '80%', '44%', 3]], sparks: [['90%', '76%', 8]] },
  empty: { clouds: [['a', '2%', '34%', 4], ['b', '58%', '4%', 3], ['b', '64%', '64%', 3]], sparks: [['44%', '6%', 8]] },
};
export type SkyPreset = keyof typeof SKIES;

/** The one gradient (sky → mist) with slowly drifting pixel clouds; children render on top. */
export function PixelSky({ preset = 'hero', className = '', children }: { preset?: SkyPreset; className?: string; children?: ReactNode }) {
  const sky = SKIES[preset]!;
  return (
    <div className={`pixel-sky sky-${preset} ${className}`}>
      <div className="pixel-sky-art" aria-hidden>
        {sky.clouds.map(([v, left, top, px], i) => (
          <PixelCloud key={i} variant={v} px={px} className="drift" style={{ left, top, animationDelay: `${-i * 9}s`, animationDuration: `${28 + i * 7}s` }} />
        ))}
        {sky.sparks.map(([left, top, s], i) => <Sparkle key={i} size={s} className="sky-spark" style={{ left, top, animationDelay: `${i * 1.3}s` }} />)}
      </div>
      {children}
    </div>
  );
}
