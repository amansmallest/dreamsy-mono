/**
 * Art style presets. A game picks one in dreamsy.toml `[style]`; it drives three things:
 *  - harness: how Claude builds (e.g. blocky = primitives first, no image-to-3D)
 *  - asset pipeline: the style prompt appended to every image / 3D generation
 *  - engine: render hints (texture filtering, pixel snap, base resolution, shading)
 */

export type StylePreset = "pixel" | "blocky" | "clean" | "toon" | "custom";

export interface StyleDef {
  dimensions: ("2d" | "3d")[];
  /** Shown to users when picking a style. */
  label: string;
  /** Guidance for the harness (Claude): how to build in this style. */
  build: string;
  /** Appended to every asset-generation prompt. */
  assetPrompt: string;
  /** Engine render hints. */
  render: {
    textureFilter: "nearest" | "linear";
    pixelSnap: boolean;
    /** Internal render resolution for 2D (upscaled to screen). null = native. */
    baseResolution: [number, number] | null;
    shading: "unshaded" | "flat" | "toon" | "standard";
    outline: boolean;
  };
  /** Prefer engine primitives (Mesh3D primitive / solid Sprite2D) over generated assets. */
  primitivesFirst: boolean;
}

export const STYLES: Record<StylePreset, StyleDef> = {
  pixel: {
    dimensions: ["2d"],
    label: "Pixel art",
    build:
      "Retro pixel art. Design on a 16px (or 32px) grid; positions and sizes are multiples of it. " +
      "Small limited palette (≤16 colors, use style.palette if set). Sprites are tiny and readable; " +
      "animate with few frames. Base resolution is low and upscaled.",
    assetPrompt:
      "pixel art, crisp hard pixel edges, no anti-aliasing, no blur, limited color palette, " +
      "transparent background, single centered subject, orthographic side or 3/4 view, game sprite",
    render: { textureFilter: "nearest", pixelSnap: true, baseResolution: [320, 180], shading: "unshaded", outline: false },
    primitivesFirst: false,
  },
  blocky: {
    dimensions: ["2d", "3d"],
    label: "Blocky",
    build:
      "Chunky block/voxel look. Build the world and most props from primitives (box, cylinder, sphere) " +
      "with flat colors; compose characters from boxes. Use generated meshes only for hero objects. " +
      "Bright saturated palette, 1-unit grid.",
    assetPrompt:
      "blocky voxel style, chunky cube shapes, flat saturated colors, simple, low detail, toy-like, " +
      "plain background, single centered subject",
    render: { textureFilter: "nearest", pixelSnap: false, baseResolution: null, shading: "flat", outline: false },
    primitivesFirst: true,
  },
  clean: {
    dimensions: ["2d", "3d"],
    label: "Clean",
    build:
      "Minimal flat-vector look. Simple geometric shapes, generous whitespace, soft palette of 3–5 colors, " +
      "no texture noise. Readability over detail. In 3D: smooth low-poly with solid materials.",
    assetPrompt:
      "clean flat vector illustration, simple geometric shapes, smooth edges, soft limited palette, " +
      "minimal detail, no texture, no outlines, plain background, single centered subject",
    render: { textureFilter: "linear", pixelSnap: false, baseResolution: null, shading: "flat", outline: false },
    primitivesFirst: true,
  },
  toon: {
    dimensions: ["2d", "3d"],
    label: "Toon",
    build:
      "Cel-shaded cartoon. Exaggerated proportions, bold silhouettes, dark outlines, 2–3 tone shading. " +
      "Generated meshes for characters and key props; primitives for terrain blocks.",
    assetPrompt:
      "cartoon style, cel shading, bold dark outlines, exaggerated proportions, vibrant colors, " +
      "plain background, single centered subject",
    render: { textureFilter: "linear", pixelSnap: false, baseResolution: null, shading: "toon", outline: true },
    primitivesFirst: false,
  },
  custom: {
    dimensions: ["2d", "3d"],
    label: "Custom",
    build: "Follow style.notes and the reference images exactly; keep every asset consistent with them.",
    assetPrompt: "",
    render: { textureFilter: "linear", pixelSnap: false, baseResolution: null, shading: "standard", outline: false },
    primitivesFirst: false,
  },
};

export const STYLE_PRESETS = Object.keys(STYLES) as StylePreset[];
