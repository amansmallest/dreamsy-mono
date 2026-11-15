// Dreamsy's ink-on-paper look: cream paper, black ink, chunky outlines, pixel caps for labels.
// One palette (no dark mode): the art direction is a printed sketchbook.

const colors = {
  /** Paper: screen background. */
  bg: '#F3EFE6',
  /** Ink: text, outlines, primary buttons. */
  fg: '#141414',
  muted: '#6F6A60',
  /** Raised paper: cards, inputs. */
  card: '#FBF9F3',
  /** Hairline dividers inside cards (outlines use fg). */
  border: '#D9D3C5',
  accent: '#141414',
  accentFg: '#F3EFE6',
  bubble: '#141414',
  bubbleFg: '#F3EFE6',
  danger: '#B83A26',
  /** Positive state (live dot, sale). */
  ok: '#2F7A45',
  /** Pressed / selected fill on paper. */
  wash: '#E7E1D3',
};

export type Colors = typeof colors;

export function useColors(): Colors {
  return colors;
}

export const ink = colors;

/** Outline weights. */
export const stroke = { thin: 1.5, base: 2, bold: 2.5 } as const;

/** Font families, loaded in app/_layout.tsx. */
export const font = {
  /** Pixel caps: labels, buttons, tabs, small headers. */
  pixel: 'Silkscreen_400Regular',
  pixelBold: 'Silkscreen_700Bold',
  body: 'SpaceGrotesk_400Regular',
  medium: 'SpaceGrotesk_500Medium',
  semibold: 'SpaceGrotesk_600SemiBold',
  bold: 'SpaceGrotesk_700Bold',
} as const;

export const radius = { sm: 10, md: 16, lg: 22, pill: 999 } as const;

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}
