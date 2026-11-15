// Platform UI theme from dreamsy.toml [ui], with defaults derived from style.palette / style preset.
// DOM-free (core): the renderer styles menus/dialogs with it, scripts read it via ui.theme().
import type { Manifest } from "@dreamsy/format";

export interface Theme {
  primary: string;
  accent: string;
  background: string;
  text: string;
  panel: "pixel" | "rounded" | "sharp" | "outlined";
  font: "pixel" | "rounded" | "bold" | "serif";
  /** CSS font-family stack for `font`. */
  fontFamily: string;
}

/** System font stacks (no downloads; work offline). */
export const FONT_STACKS: Record<Theme["font"], string> = {
  pixel: `"Press Start 2P", "Silkscreen", "VT323", ui-monospace, "SF Mono", Menlo, Consolas, monospace`,
  rounded: `ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", "Arial Rounded MT Bold", system-ui, sans-serif`,
  bold: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
  serif: `ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`,
};

const PRESET_DEFAULTS: Record<string, Omit<Theme, "fontFamily">> = {
  pixel: { primary: "#3b5dc9", accent: "#ffcd75", background: "#1a1c2c", text: "#f4f4f4", panel: "pixel", font: "pixel" },
  blocky: { primary: "#4caf50", accent: "#ffd54f", background: "#263238", text: "#ffffff", panel: "sharp", font: "bold" },
  toon: { primary: "#ff7a45", accent: "#ffd93d", background: "#2b2d6e", text: "#ffffff", panel: "rounded", font: "rounded" },
  clean: { primary: "#3d7eff", accent: "#ffb547", background: "#1d2230", text: "#f5f7fb", panel: "rounded", font: "bold" },
  custom: { primary: "#6c7cff", accent: "#ffc857", background: "#202233", text: "#f5f5f5", panel: "rounded", font: "bold" },
};

export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const lum = (h: string) => { const [r, g, b] = rgb(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
const sat = (h: string) => { const c = rgb(h); const mx = Math.max(...c), mn = Math.min(...c); return mx === 0 ? 0 : (mx - mn) / mx; };

export function resolveTheme(m: Manifest): Theme {
  const base = { ...(PRESET_DEFAULTS[m.style.preset] ?? PRESET_DEFAULTS.clean!) };
  const pal = m.style.palette;
  if (pal && pal.length >= 3) {
    const byLum = [...pal].sort((a, b) => lum(a) - lum(b));
    base.background = byLum[0]!;
    base.text = lum(byLum.at(-1)!) > 0.6 ? byLum.at(-1)! : "#ffffff";
    const vivid = pal.filter((c) => c !== base.background && c !== base.text).sort((a, b) => sat(b) * (0.4 + lum(b)) - sat(a) * (0.4 + lum(a)));
    // primary: a vivid mid-tone (buttons carry text); accent: the brightest vivid color
    base.primary = vivid.find((c) => lum(c) > 0.25 && lum(c) < 0.7) ?? vivid[0] ?? base.primary;
    base.accent = [...vivid].filter((c) => c !== base.primary).sort((a, b) => lum(b) * sat(b) - lum(a) * sat(a))[0] ?? base.accent;
  }
  const ui = m.ui ?? {};
  const t = {
    primary: ui.primary ?? base.primary,
    accent: ui.accent ?? base.accent,
    background: ui.background ?? base.background,
    text: ui.text ?? base.text,
    panel: ui.panel ?? base.panel,
    font: ui.font ?? base.font,
  };
  return { ...t, fontFamily: FONT_STACKS[t.font] };
}

