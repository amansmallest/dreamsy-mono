// Dreamsy "Sky" (apps/DESIGN.md): warm off-white, white surfaces, one confident blue, pastel sky,
// hairlines instead of outlines, pixel art only as an accent. Light only on mobile.

const colors = {
  /** App background. */
  bg: '#EFEFED',
  /** Cards, sheets, inputs, tab bar. */
  card: '#FFFFFF',
  /** Primary text and icons. */
  fg: '#141414',
  /** Display headings, selected states, dark buttons. */
  navy: '#0D2A66',
  /** The accent: primary buttons, links, progress, active states. */
  accent: '#4C8DE8',
  /** Text on accent / navy. */
  accentFg: '#FFFFFF',
  /** Pastel fills: avatar backgrounds, chips, pixel clouds. */
  sky: '#A8CBF5',
  /** Faint blue wash: selected rows, skeletons, empty states. */
  wash: '#DCE8FA',
  muted: '#6B6F76',
  faint: '#A3A6AB',
  /** 1px hairlines. */
  border: '#E3E3DF',
  ok: '#2E9D6A',
  danger: '#E0533D',
};

export type Colors = typeof colors;

export function useColors(): Colors {
  return colors;
}

/** The palette (named for history: screens import `ink`). */
export const ink = colors;

export const hairline = 1;

/** Font families, loaded in app/_layout.tsx. */
export const font = {
  /** Silkscreen: tiny uppercase badges only (LIVE, NEW, v3). */
  pixel: 'Silkscreen_400Regular',
  display: 'InterTight_800ExtraBold',
  displayBold: 'InterTight_700Bold',
  body: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
} as const;

export const radius = { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 } as const;

/** The one soft shadow, for floating things (sheets, toasts, FAB). */
export const floating = {
  shadowColor: '#0D2A66',
  shadowOpacity: 0.1,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 8 },
  elevation: 6,
} as const;

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}
