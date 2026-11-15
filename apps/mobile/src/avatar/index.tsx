import { memo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, Line, Path, Rect } from 'react-native-svg';
import { ink } from '../theme';

// Ink avatars: a bust drawn from a handful of parts. Stored on the user as { part: index }
// (PATCH /v1/me avatar); users without one get a stable avatar derived from their id.

export const AVATAR_PARTS = {
  hat: ['None', 'Knight', 'Wizard', 'Crown', 'Beanie', 'Cat ears', 'Horns', 'Cap'],
  head: ['Round', 'Square', 'Tall', 'Wide'],
  eyes: ['Dots', 'Happy', 'Wide', 'Sleepy', 'Sparkle', 'Wink'],
  mouth: ['Smile', 'Grin', 'Oh', 'Flat', 'Cat', 'Tongue'],
  extra: ['None', 'Blush', 'Mustache', 'Beard', 'Glasses', 'Bandage'],
  body: ['Tunic', 'Shirt', 'Stripes', 'Hoodie', 'Armor'],
} as const;

export type AvatarPart = keyof typeof AVATAR_PARTS;
export type AvatarConfig = Record<AvatarPart, number>;
export const PART_ORDER: AvatarPart[] = ['hat', 'head', 'eyes', 'mouth', 'extra', 'body'];

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** A stable avatar for a seed (user id) — what people see before they make their own. */
export function avatarFromSeed(seed: string): AvatarConfig {
  const out = {} as AvatarConfig;
  for (const p of PART_ORDER) out[p] = hash(`${seed}:${p}`) % AVATAR_PARTS[p].length;
  return out;
}

export function randomAvatar(): AvatarConfig {
  return avatarFromSeed(String(Math.random()));
}

/** Stored avatar (possibly partial / out of range from an older app) -> valid config. */
export function normalizeAvatar(raw: Record<string, number> | null | undefined, seed: string): AvatarConfig {
  const base = avatarFromSeed(seed);
  if (!raw) return base;
  for (const p of PART_ORDER) {
    const v = raw[p];
    if (Number.isInteger(v) && v! >= 0 && v! < AVATAR_PARTS[p].length) base[p] = v!;
  }
  return base;
}

const S = 3.5; // stroke width in the 100-unit box
const line = { stroke: ink.fg, strokeWidth: S, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const paper = { ...line, fill: ink.card };
const solid = { ...line, fill: ink.fg };
const SHOULDERS = 'M12 104 C14 82 30 72 50 72 C70 72 86 82 88 104 Z';

function Body({ v }: { v: number }) {
  switch (v) {
    case 0:
      return (
        <G>
          <Path d={SHOULDERS} {...solid} />
          <Path d="M41 72 L50 84 L59 72 Z" {...paper} />
        </G>
      );
    case 1:
      return (
        <G>
          <Path d={SHOULDERS} {...paper} />
          <Path d="M42 73 L50 81 L58 73" {...line} fill="none" />
          <Circle cx={50} cy={89} r={1.8} fill={ink.fg} />
          <Circle cx={50} cy={97} r={1.8} fill={ink.fg} />
        </G>
      );
    case 2:
      return (
        <G>
          <Path d={SHOULDERS} {...paper} />
          <Line x1={26} y1={81} x2={74} y2={81} {...line} />
          <Line x1={20} y1={89} x2={80} y2={89} {...line} />
          <Line x1={16} y1={97} x2={84} y2={97} {...line} />
        </G>
      );
    case 3:
      return (
        <G>
          <Path d={SHOULDERS} {...paper} />
          <Path d="M44 76 L42 92 M56 76 L58 92" {...line} />
          <Circle cx={42} cy={93} r={2} fill={ink.fg} />
          <Circle cx={58} cy={93} r={2} fill={ink.fg} />
        </G>
      );
    default:
      return (
        <G>
          <Path d={SHOULDERS} {...paper} />
          <Path d="M50 76 L50 104" {...line} />
          <Ellipse cx={22} cy={86} rx={11} ry={8} {...solid} />
          <Ellipse cx={78} cy={86} rx={11} ry={8} {...solid} />
          <Circle cx={40} cy={90} r={1.8} fill={ink.fg} />
          <Circle cx={60} cy={90} r={1.8} fill={ink.fg} />
        </G>
      );
  }
}

/** Drawn behind the head (hood). */
function BehindHead({ body }: { body: number }) {
  if (body !== 3) return null;
  return <Path d="M22 74 C18 44 28 18 50 18 C72 18 82 44 78 74 Z" {...solid} />;
}

function Head({ v }: { v: number }) {
  switch (v) {
    case 1:
      return <Rect x={28} y={24} width={44} height={44} rx={14} {...paper} />;
    case 2:
      return <Ellipse cx={50} cy={46} rx={19} ry={23} {...paper} />;
    case 3:
      return <Ellipse cx={50} cy={47} rx={24} ry={21} {...paper} />;
    default:
      return <Circle cx={50} cy={46} r={22} {...paper} />;
  }
}

function Eye({ x, v }: { x: number; v: number }) {
  const y = 44;
  switch (v) {
    case 1:
      return <Path d={`M${x - 4} ${y + 2} Q${x} ${y - 4} ${x + 4} ${y + 2}`} {...line} fill="none" />;
    case 2:
      return (
        <G>
          <Circle cx={x} cy={y} r={5.5} {...paper} strokeWidth={2.5} />
          <Circle cx={x + 1} cy={y + 1} r={2.4} fill={ink.fg} />
        </G>
      );
    case 3:
      return <Path d={`M${x - 4.5} ${y} Q${x} ${y + 3.5} ${x + 4.5} ${y}`} {...line} fill="none" />;
    case 4:
      return (
        <Path
          d={`M${x} ${y - 5.5} Q${x + 1} ${y - 1} ${x + 5.5} ${y} Q${x + 1} ${y + 1} ${x} ${y + 5.5} Q${x - 1} ${y + 1} ${x - 5.5} ${y} Q${x - 1} ${y - 1} ${x} ${y - 5.5} Z`}
          fill={ink.fg}
        />
      );
    default:
      return <Circle cx={x} cy={y} r={3} fill={ink.fg} />;
  }
}

function Eyes({ v }: { v: number }) {
  if (v === 5) {
    return (
      <G>
        <Circle cx={41} cy={44} r={3} fill={ink.fg} />
        <Path d="M54.5 45 Q59 41 63.5 45" {...line} fill="none" />
      </G>
    );
  }
  return (
    <G>
      <Eye x={41} v={v} />
      <Eye x={59} v={v} />
    </G>
  );
}

function Mouth({ v }: { v: number }) {
  switch (v) {
    case 1:
      return <Path d="M42 54 L58 54 Q57 63 50 63 Q43 63 42 54 Z" {...solid} strokeWidth={2.5} />;
    case 2:
      return <Ellipse cx={50} cy={57} rx={3.5} ry={4} {...solid} strokeWidth={2} />;
    case 3:
      return <Line x1={44} y1={57} x2={56} y2={57} {...line} />;
    case 4:
      return <Path d="M43 55 Q46.5 59 50 55 Q53.5 59 57 55" {...line} fill="none" />;
    case 5:
      return (
        <G>
          <Path d="M53 56 L53 61 Q55.5 64 58 61 L58 56" {...paper} strokeWidth={2.5} />
          <Path d="M43 55 Q50 60 59 54" {...line} fill="none" />
        </G>
      );
    default:
      return <Path d="M43 55 Q50 62 57 55" {...line} fill="none" />;
  }
}

function Extra({ v }: { v: number }) {
  switch (v) {
    case 1:
      return (
        <G {...line} strokeWidth={2}>
          <Path d="M32 51 L34 47 M35 52 L37 48 M38 53 L40 49" />
          <Path d="M60 49 L62 53 M63 48 L65 52 M66 47 L68 51" />
        </G>
      );
    case 2:
      return <Path d="M50 52 C46 49 40 50 38 55 C42 53 46 54 50 53 C54 54 58 53 62 55 C60 50 54 49 50 52 Z" {...solid} strokeWidth={2} />;
    case 3:
      return <Path d="M29 50 C30 66 40 76 50 76 C60 76 70 66 71 50 C66 58 60 60 56 54 L44 54 C40 60 34 58 29 50 Z" {...solid} strokeWidth={2.5} />;
    case 4:
      return (
        <G>
          <Circle cx={41} cy={44} r={7.5} {...line} fill="none" strokeWidth={3} />
          <Circle cx={59} cy={44} r={7.5} {...line} fill="none" strokeWidth={3} />
          <Line x1={48.5} y1={44} x2={51.5} y2={44} {...line} strokeWidth={3} />
        </G>
      );
    case 5:
      return (
        <G>
          <Rect x={56} y={47} width={14} height={7} rx={2} transform="rotate(-20 63 50.5)" {...paper} strokeWidth={2.5} />
          <Path d="M61 49 L61 53 M65 48 L65 52" stroke={ink.fg} strokeWidth={1.5} transform="rotate(-20 63 50.5)" />
        </G>
      );
    default:
      return null;
  }
}

function Hat({ v, head }: { v: number; head: number }) {
  const top = head === 2 ? 23 : 24;
  switch (v) {
    case 1:
      // Knight: helmet over the upper face, visor slit, plume.
      return (
        <G>
          <Path d="M50 18 C56 6 70 4 78 10 C70 10 62 14 58 20 Z" {...solid} strokeWidth={2.5} />
          <Path d="M25 52 L25 34 C25 22 36 16 50 16 C64 16 75 22 75 34 L75 52 Z" {...paper} />
          <Rect x={31} y={37} width={38} height={7} rx={2} fill={ink.fg} />
          <Line x1={50} y1={44} x2={50} y2={52} {...line} strokeWidth={3} />
          <Circle cx={30} cy={48} r={1.6} fill={ink.fg} />
          <Circle cx={70} cy={48} r={1.6} fill={ink.fg} />
        </G>
      );
    case 2:
      return (
        <G>
          <Path d="M28 32 L60 0 L72 32 Z" {...solid} />
          <Ellipse cx={50} cy={32} rx={29} ry={5} {...paper} />
          <Path d="M55 13 Q56 18 61 19 Q56 20 55 25 Q54 20 49 19 Q54 18 55 13 Z" fill={ink.card} />
        </G>
      );
    case 3:
      return (
        <G>
          <Path d={`M32 ${top + 7} L31 10 L41 19 L50 6 L59 19 L69 10 L68 ${top + 7} Z`} {...paper} />
          <Circle cx={50} cy={20} r={2.4} fill={ink.fg} />
          <Line x1={33} y1={top + 1} x2={67} y2={top + 1} {...line} strokeWidth={2.5} />
        </G>
      );
    case 4:
      return (
        <G>
          <Path d="M27 36 C27 12 73 12 73 36 Z" {...solid} />
          <Rect x={25} y={30} width={50} height={9} rx={4.5} {...paper} />
          <Circle cx={50} cy={11} r={5.5} {...paper} />
        </G>
      );
    case 5:
      return (
        <G>
          <Path d="M30 34 L27 10 L45 25 Z" {...paper} />
          <Path d="M70 34 L73 10 L55 25 Z" {...paper} />
          <Path d="M31 26 L30 17 L37 23 Z M69 26 L70 17 L63 23 Z" fill={ink.fg} />
        </G>
      );
    case 6:
      return (
        <G>
          <Path d="M29 31 C20 30 13 22 14 8 C19 18 24 21 33 23 Z" {...paper} />
          <Path d="M71 31 C80 30 87 22 86 8 C81 18 76 21 67 23 Z" {...paper} />
          <Path d="M27 38 C27 14 73 14 73 38 Z" {...solid} />
          <Line x1={27} y1={36} x2={73} y2={36} {...line} />
        </G>
      );
    case 7:
      return (
        <G>
          <Path d="M50 33 L86 33 C86 39 72 40 62 38 Z" {...solid} strokeWidth={2.5} />
          <Path d="M27 36 C27 13 73 13 73 36 Z" {...solid} />
          <Circle cx={50} cy={15} r={2.5} fill={ink.card} />
        </G>
      );
    default:
      return <Path d={`M44 ${top + 2} C45 ${top - 6} 52 ${top - 6} 50 ${top} C54 ${top - 6} 61 ${top - 4} 57 ${top + 3}`} {...line} fill="none" />;
  }
}

/** The bust in a 100x100 box. */
function Bust({ a }: { a: AvatarConfig }) {
  return (
    <G>
      <BehindHead body={a.body} />
      <Body v={a.body} />
      <Head v={a.head} />
      <Eyes v={a.eyes} />
      <Mouth v={a.mouth} />
      <Extra v={a.extra} />
      <Hat v={a.hat} head={a.head} />
    </G>
  );
}

export type InkAvatarProps = {
  /** Stored avatar parts; null/undefined = derived from seed. */
  avatar?: Record<string, number> | null;
  /** Usually the user id; also keys the clip path. */
  seed: string;
  size?: number;
  /** Circle badge with an outline (lists, headers). false = bare figure (heroes). */
  framed?: boolean;
  style?: StyleProp<ViewStyle>;
};

export const InkAvatar = memo(function InkAvatar({ avatar, seed, size = 36, framed = true, style }: InkAvatarProps) {
  const a = normalizeAvatar(avatar, seed);
  if (!framed) {
    return (
      <View style={style}>
        <Svg width={size} height={size} viewBox="0 0 100 104">
          <Bust a={a} />
        </Svg>
      </View>
    );
  }
  const clip = `clip-${seed.replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <View style={style}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
          <ClipPath id={clip}>
            <Circle cx={50} cy={50} r={50} />
          </ClipPath>
        </Defs>
        <Circle cx={50} cy={50} r={50} fill={ink.sky} />
        <G clipPath={`url(#${clip})`}>
          <G transform="translate(6 12) scale(0.88)">
            <Bust a={a} />
          </G>
        </G>
      </Svg>
    </View>
  );
});
