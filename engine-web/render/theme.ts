// Platform UI theme from dreamsy.toml [ui], with defaults derived from style.palette / style preset.
import { FONT_STACKS, lum, resolveTheme, rgb, type Theme } from "../core/theme.js";
export { FONT_STACKS, resolveTheme, type Theme };

/** "#rrggbb" + alpha → rgba(). */
export function withAlpha(hex: string, a: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Readable text color on top of `bg`. */
export function onColor(bg: string, light: string, dark = "#111111"): string {
  return lum(bg) > 0.6 ? dark : light;
}

/** Panel/button surface CSS for a theme's panel style (shared by the pause menu and dialogs). */
export function panelSurface(t: Theme, bg: string, small: boolean): Partial<CSSStyleDeclaration> {
  switch (t.panel) {
    case "pixel": {
      // stepped pixel border: inner fill + hard outline via box-shadows
      const b = small ? 3 : 4, edge = withAlpha(t.text, 0.95), shade = "rgba(0,0,0,0.45)";
      return {
        background: bg, border: "none", borderRadius: "0", imageRendering: "pixelated",
        boxShadow: `0 -${b}px 0 0 ${edge}, 0 ${b}px 0 0 ${edge}, -${b}px 0 0 0 ${edge}, ${b}px 0 0 0 ${edge}, inset 0 -${b}px 0 0 ${shade}`,
      };
    }
    case "sharp": return { background: bg, border: "none", borderRadius: "0", boxShadow: "0 6px 0 rgba(0,0,0,0.35)" };
    case "outlined": return { background: withAlpha(t.background, 0.6), border: `2px solid ${t.text}`, borderRadius: small ? "10px" : "14px", boxShadow: "none" };
    default: return { background: bg, border: "none", borderRadius: small ? "14px" : "22px", boxShadow: "0 10px 30px rgba(0,0,0,0.35)" };
  }
}
