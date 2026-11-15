import type { SVGProps } from 'react';

const P: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
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
  stop: 'M7 7h10v10H7z',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  star: 'M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7L12 3z',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  compare: 'M12 3v18M5 7h4M5 12h4M5 17h4M15 7h4M15 12h4M15 17h4',
  alert: 'M12 4l9 16H3l9-16zM12 10v4M12 17h.01',
  play: 'M8 5v14l11-7z',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      <path d={P[name]} />
    </svg>
  );
}

/** Hand-drawn four-point sparkle (slightly wobbly on purpose). */
export function Sparkle({ size = 14, className, filled = true, style }: { size?: number; className?: string; filled?: boolean; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style} aria-hidden>
      <path d="M12.2 1.5c.5 5.6 3.6 9.2 10.3 10.4-6.4 1.1-9.6 4.8-10.6 10.6-.9-5.9-4.3-9.4-10.4-10.4 6.2-1.3 9.8-4.9 10.7-10.6z"
        fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 0.6 : 1.8} strokeLinejoin="round" />
    </svg>
  );
}

/** Scattered doodle sparkles for empty space. */
export function Doodles({ variant = 'a' }: { variant?: 'a' | 'b' | 'c' }) {
  const spots: Record<string, [number, number, number, boolean][]> = {
    a: [[6, 12, 22, true], [14, 70, 12, false], [88, 18, 16, false], [93, 60, 26, true], [78, 88, 11, true]],
    b: [[4, 30, 14, false], [96, 22, 20, true], [90, 78, 12, false]],
    c: [[10, 20, 18, true], [85, 30, 12, false], [20, 80, 10, false], [75, 75, 22, true]],
  };
  return (
    <div className="doodles" aria-hidden>
      {spots[variant]!.map(([x, y, s, f], i) => (
        <Sparkle key={i} size={s} filled={f} className="doodle" style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${i * 0.7}s` }} />
      ))}
    </div>
  );
}
