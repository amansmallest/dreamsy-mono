import { memo, useId } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { ink } from '../theme';

// Pixel-art accents (apps/DESIGN.md "Pixel motifs"): drawn from square cells so they stay crisp.

const SPARKLE = [
  '...#...',
  '...#...',
  '..###..',
  '#######',
  '..###..',
  '...#...',
  '...#...',
];

/** 4-point pixel sparkle: the brand mark. */
export const PixelSparkle = memo(function PixelSparkle({
  size = 14,
  color = ink.accent,
  style,
}: {
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={style}>
      <Svg width={size} height={size} viewBox="0 0 7 7">
        {SPARKLE.flatMap((row, y) =>
          [...row].map((c, x) => (c === '#' ? <Rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={color} /> : null)),
        )}
      </Svg>
    </View>
  );
});

const COIN = [
  '.#####.',
  '##...##',
  '#..#..#',
  '#.###.#',
  '#..#..#',
  '##...##',
  '.#####.',
];

/** Pixel coin with the sparkle stamped in: the currency mark. */
export const PixelCoin = memo(function PixelCoin({
  size = 14,
  color = ink.accent,
  style,
}: {
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={style}>
      <Svg width={size} height={size} viewBox="0 0 7 7">
        {COIN.flatMap((row, y) =>
          [...row].map((c, x) => (c === '#' ? <Rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={color} /> : null)),
        )}
      </Svg>
    </View>
  );
});

const CLOUDS = {
  a: [
    '......####......',
    '....########....',
    '..###########...',
    '.##############.',
    '################',
    '.##############.',
  ],
  b: [
    '....###.....',
    '..#######...',
    '.##########.',
    '############',
    '.##########.',
  ],
  c: [
    '...####..',
    '.#######.',
    '#########',
    '.#######.',
  ],
};

/** One blocky cloud. `cell` = pixel size in points. */
export const PixelCloud = memo(function PixelCloud({
  shape = 'a',
  cell = 5,
  color = ink.card,
  shade = ink.sky,
  style,
}: {
  shape?: keyof typeof CLOUDS;
  cell?: number;
  color?: string;
  /** Bottom-row tint, for a little depth. */
  shade?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const rows = CLOUDS[shape];
  const w = rows[0]!.length;
  const h = rows.length;
  return (
    <View style={style} pointerEvents="none">
      <Svg width={w * cell} height={h * cell} viewBox={`0 0 ${w} ${h}`}>
        {rows.flatMap((row, y) =>
          [...row].map((c, x) =>
            c === '#' ? (
              <Rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={y === h - 1 ? shade : color} />
            ) : null,
          ),
        )}
      </Svg>
    </View>
  );
});

/** Sky gradient with drifting-looking pixel clouds; fills its parent (put it absolutely). */
export function PixelSky({ style, dense }: { style?: StyleProp<ViewStyle>; dense?: boolean }) {
  const id = `sky${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <View style={[{ overflow: 'hidden' }, style]} pointerEvents="none">
      <Svg width="100%" height="100%" style={{ position: 'absolute' }}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={ink.sky} />
            <Stop offset="1" stopColor={ink.wash} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
      <PixelCloud shape="a" cell={6} style={{ position: 'absolute', top: '12%', left: '-6%' }} />
      <PixelCloud shape="c" cell={5} style={{ position: 'absolute', top: '8%', right: '8%' }} />
      <PixelCloud shape="b" cell={6} style={{ position: 'absolute', bottom: '14%', right: '-4%' }} />
      {dense && <PixelCloud shape="c" cell={4} style={{ position: 'absolute', bottom: '30%', left: '18%' }} />}
      {dense && <PixelCloud shape="b" cell={4} style={{ position: 'absolute', top: '40%', left: '55%' }} />}
    </View>
  );
}
