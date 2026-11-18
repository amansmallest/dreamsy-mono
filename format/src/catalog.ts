/**
 * Entity type catalog: the node types a scene may use and their typed props.
 * Single source of truth for the validator (TS), the engine loader (C++, via catalog.json),
 * and the harness prompt (Claude reads it to know what it can build).
 */

export type AssetKind = "image" | "mesh" | "audio" | "font";

export type PropType =
  | { kind: "number"; min?: number; max?: number }
  | { kind: "int"; min?: number; max?: number }
  | { kind: "bool" }
  | { kind: "string"; maxLength?: number }
  | { kind: "vec2" }
  | { kind: "vec3" }
  | { kind: "color" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "asset"; assetKind: AssetKind }
  | { kind: "entity" };

export interface PropDef {
  type: PropType;
  /** Omitted = optional with no value (e.g. an unset texture). */
  default?: unknown;
  doc: string;
}

export type Dimension = "2d" | "3d" | "any";

export interface EntityTypeDef {
  dimension: Dimension;
  doc: string;
  props: Record<string, PropDef>;
  /** Can this entity have children? */
  container: boolean;
}

// ---------- prop helpers ----------

const num = (d: number, doc: string, min?: number, max?: number): PropDef => ({ type: { kind: "number", min, max }, default: d, doc });
const int = (d: number, doc: string, min?: number, max?: number): PropDef => ({ type: { kind: "int", min, max }, default: d, doc });
const bool = (d: boolean, doc: string): PropDef => ({ type: { kind: "bool" }, default: d, doc });
const str = (d: string, doc: string, maxLength = 2000): PropDef => ({ type: { kind: "string", maxLength }, default: d, doc });
const vec2 = (d: [number, number], doc: string): PropDef => ({ type: { kind: "vec2" }, default: d, doc });
const vec3 = (d: [number, number, number], doc: string): PropDef => ({ type: { kind: "vec3" }, default: d, doc });
const color = (d: string, doc: string): PropDef => ({ type: { kind: "color" }, default: d, doc });
const oneOf = <T extends string>(values: readonly T[], d: T, doc: string): PropDef => ({ type: { kind: "enum", values }, default: d, doc });
const asset = (assetKind: AssetKind, doc: string): PropDef => ({ type: { kind: "asset", assetKind }, doc });
const entity = (doc: string): PropDef => ({ type: { kind: "entity" }, doc });

const BODY_KINDS = ["static", "dynamic", "kinematic"] as const;
const ANCHORS = ["top_left", "top", "top_right", "left", "center", "right", "bottom_left", "bottom", "bottom_right"] as const;

// ---------- shared prop groups ----------

const base = {
  visible: bool(true, "Rendered and processed when true."),
};

const transform2d = {
  ...base,
  position: vec2([0, 0], "Pixels, relative to parent. +y is down."),
  rotation: num(0, "Degrees, clockwise."),
  scale: vec2([1, 1], "Scale factor."),
  z_index: int(0, "Draw order; higher draws on top.", -4096, 4096),
};

const transform3d = {
  ...base,
  position: vec3([0, 0, 0], "Meters, relative to parent. +y is up."),
  rotation: vec3([0, 0, 0], "Euler degrees (x, y, z)."),
  scale: vec3([1, 1, 1], "Scale factor."),
};

/**
 * 2.5D height (DREAMSY.MD §14.5). Appended after each type's other props so existing prop indices stay put.
 * The world is still 2D (x, y on the ground; +y is down / toward the viewer); `z` lifts things off the ground.
 */
const elevation = {
  z: num(0, "2.5D: height above the ground in px (+ = up), relative to the parent. Drawn raised in topdown/oblique/iso views (with a drop shadow); physics moves it for dynamic/kinematic Body2D (gravity, jumps, landing)."),
  height: num(0, "2.5D: vertical extent in px. Body2D/Area2D/TileMap2D: only things whose z ranges overlap collide (0 = flat: collides with everything); static bodies with a height are platforms others can land on. Sprite2D: > 0 draws a solid block this tall (top face = texture/color, shaded sides) in topdown/oblique/iso; TileMap2D: every tile draws as such a block and solid tiles are platforms (raised terrain).", 0),
};
const zMotion = {
  z_velocity: num(0, "2.5D: vertical speed in px/s (+ = up). Set it to jump (e.g. 420); physics applies z gravity (980 px/s² × z_gravity_scale) and zeroes it on landing.", -100000, 100000),
  z_gravity_scale: num(1, "2.5D: multiplier on z gravity (0 = floats at its z)."),
};

const physics = {
  mass: num(1, "kg (dynamic only).", 0.001),
  friction: num(0.5, "0..1.", 0, 1),
  bounce: num(0, "Restitution 0..1.", 0, 1),
  gravity_scale: num(1, "Multiplier on world gravity."),
  lock_rotation: bool(false, "Prevent physics from rotating the body."),
};

const layers = {
  layer: str("", 'Collision layer name from dreamsy.toml [physics] layers (e.g. "player"). "" = on every layer.', 32),
  mask: str("", 'Comma-separated layers this collides with / detects (e.g. "world,enemy"). "" = every layer.', 600),
};

const FONTS = ["default", "pixel", "rounded", "bold", "serif"] as const;
const textStyle = {
  font: oneOf(FONTS, "default", 'Font family; "default" = the game\'s [ui] font (from the style preset).'),
  outline: color("#00000000", "Outline color (set outline_size too)."),
  outline_size: int(0, "Outline thickness in pixels (0 = none). 2-4 makes text readable on busy backgrounds.", 0, 16),
  shadow: color("#00000000", "Drop shadow color (transparent = none)."),
  shadow_offset: vec2([2, 2], "Drop shadow offset in pixels."),
};

const emissive = {
  emissive: bool(false, "Drawn above Lighting2D darkness at full brightness (glowing eyes, lamps, UI-like world text)."),
};
const BLENDS = ["normal", "add"] as const;
const blend = {
  blend: oneOf(BLENDS, "normal", '"add" = additive (glows, fire, light beams, fake night lights): brightens what is behind.'),
};

const ui = {
  ...base,
  anchor: oneOf(ANCHORS, "top_left", "Screen anchor (top-level UI stays inside the phone safe area: notch, home bar)."),
  offset: vec2([0, 0], "Pixels from the anchor."),
  size: vec2([200, 48], "Pixels."),
  z_index: int(0, "Draw order among UI.", -4096, 4096),
  scale: vec2([1, 1], "Visual scale around the center (tween it to pop/bounce UI; layout size is unchanged)."),
};

// ---------- catalog ----------

export const CATALOG = {
  Folder: {
    dimension: "any", container: true,
    doc: "Groups entities. No transform.",
    props: { ...base },
  },

  // ----- 2D -----
  Node2D: {
    dimension: "2d", container: true,
    doc: "Empty 2D transform. Use to group and move children together.",
    props: { ...transform2d, ...elevation },
  },
  Sprite2D: {
    dimension: "2d", container: true,
    doc: "Draws an image. Without a texture draws a solid rect of `size` in `modulate`.",
    props: {
      ...transform2d,
      texture: asset("image", "Image asset."),
      size: vec2([32, 32], "Displayed size in pixels (texture is scaled to fit)."),
      modulate: color("#ffffff", "Tint."),
      flip_h: bool(false, "Mirror horizontally."),
      flip_v: bool(false, "Mirror vertically."),
      anims: str("", 'Animation set, "data/anims/<name>.json" (frame lists). Play with e:play("run").', 200),
      anim: str("", "Animation playing (set to start one at spawn; e:play() changes it).", 64),
      auto_flip: bool(false, "Face the direction of horizontal movement (sets flip_h from the velocity of this sprite or its Body2D parent). Art should face right."),
      color: { type: { kind: "color" }, doc: "Alias of `modulate` (handy for untextured solid rects); setting it sets modulate." },
      ...emissive,
      ...blend,
      ...elevation,
      anchor: oneOf(["center", "bottom"], "center", 'Which point of the image sits on `position`: "center", or "bottom" (bottom-center: the feet). 2.5D views: use "bottom" for things that stand on the ground (characters, trees, coins) so they stand on their position and their drop shadow sits under their feet.'),
    },
  },
  Body2D: {
    dimension: "2d", container: true,
    doc: "Physics body. Put Sprite2D children on it for visuals.",
    props: {
      ...transform2d,
      body: oneOf(BODY_KINDS, "static", "static = walls/floors, dynamic = simulated, kinematic = moved by script."),
      shape: oneOf(["rect", "circle", "capsule"], "rect", "Collision shape."),
      size: vec2([32, 32], "rect: w,h. circle: x = diameter. capsule: w,h."),
      ...physics,
      ...layers,
      ...elevation,
      ...zMotion,
    },
  },
  Area2D: {
    dimension: "2d", container: true,
    doc: "Trigger zone: reports overlaps, no collision response.",
    props: { ...transform2d, shape: oneOf(["rect", "circle"], "rect", "Shape."), size: vec2([32, 32], "Size."), ...layers, ...elevation },
  },
  Camera2D: {
    dimension: "2d", container: false,
    doc: "2D camera. The `current` one renders.",
    props: {
      ...transform2d,
      zoom: num(1, "Zoom factor.", 0.05, 20),
      follow: entity("Entity to follow."),
      current: bool(true, "Active camera."),
      smoothing: num(0, "Follow smoothing: 0 = locked to the target, 0.5 = soft, 0.9 = very floaty.", 0, 0.99),
      deadzone: vec2([0, 0], "Box (world px, w,h) around the view center the target can move in without the camera moving."),
      limit_min: { type: { kind: "vec2" }, doc: "World top-left corner the view may not go past (unset = no limit)." },
      limit_max: { type: { kind: "vec2" }, doc: "World bottom-right corner the view may not go past (unset = no limit)." },
    },
  },
  Text2D: {
    dimension: "2d", container: false,
    doc: "Text placed in the world.",
    props: { ...transform2d, text: str("", "Text."), font_size: int(16, "Pixels.", 4, 256), color: color("#ffffff", "Color."), align: oneOf(["left", "center", "right"], "center", "Horizontal anchor: center = text centered on position, left = text starts at position, right = text ends at position. Vertically centered on position."), ...textStyle, ...emissive, ...elevation },
  },
  TileMap2D: {
    dimension: "2d", container: false,
    doc: "A grid of tiles (a level) drawn and collided as one entity. `position` is the top-left corner of tile (0,0).",
    props: {
      ...transform2d,
      tile_size: int(16, "Tile width and height in pixels.", 1, 256),
      tileset: str("", 'Tileset file, "data/tilesets/<name>.json".', 200),
      data: str("", 'The grid: rows of tile characters joined by "\\n" (top row first), or "file:data/levels/<name>.txt".', 65536),
      collision: bool(true, "Solid tiles block bodies."),
      ...layers,
      ...elevation,
    },
  },
  Particles2D: {
    dimension: "2d", container: false,
    doc: "Particle emitter (dust, sparks, explosions, trails). Emits `rate`/s while `emitting`; e:burst(n) emits n at once. Particles move in world space.",
    props: {
      ...transform2d,
      emitting: bool(true, "Emit continuously at `rate`."),
      rate: num(20, "Particles per second while emitting.", 0, 1000),
      lifetime: num(1, "Seconds each particle lives.", 0.05, 10),
      lifetime_random: num(0.3, "0..1: random fraction shaved off each lifetime.", 0, 1),
      direction: num(-90, "Emit direction in degrees (0 = right, -90 = up, 90 = down)."),
      spread: num(45, "Cone width in degrees around `direction` (360 = all around).", 0, 360),
      speed: num(120, "Initial speed (px/s).", 0, 5000),
      speed_random: num(0.3, "0..1: random fraction of speed removed per particle.", 0, 1),
      gravity: vec2([0, 0], "Acceleration (px/s²), e.g. [0, 600] to fall."),
      damping: num(0, "Velocity drag per second (0 = none).", 0, 50),
      start_color: color("#ffffff", "Color at birth."),
      end_color: color("#ffffff00", "Color at death (fades between)."),
      start_size: num(8, "Size at birth (px).", 0, 512),
      end_size: num(2, "Size at death (px).", 0, 512),
      shape: oneOf(["square", "circle"], "square", "Shape when there is no texture."),
      texture: asset("image", "Optional particle image (tinted by the color)."),
      emission_size: vec2([0, 0], "Spawn area (w,h px) around the emitter; [0,0] = a point."),
      max_particles: int(256, "Cap on live particles.", 1, 4096),
      ...emissive,
      ...blend,
    },
  },
  Light2D: {
    dimension: "2d", container: false,
    doc: "Point light for dark scenes (needs a Lighting2D in the scene). Child of the player = a torch that follows. Up to 64 lit at once (nearest to the view).",
    props: {
      ...transform2d,
      radius: num(160, "Reach in pixels (light is 0 at the edge).", 1, 4096),
      color: color("#ffe2a8", "Light color."),
      energy: num(1, "Brightness multiplier (0 = off; >1 burns out to full brightness sooner).", 0, 8),
      falloff: num(2, "Edge softness: 1 = linear, 2 = soft (default), 4 = tight bright core.", 0.1, 8),
      flicker: num(0, "0..1 random brightness flicker (torches 0.15, candles 0.3).", 0, 1),
      flicker_speed: num(8, "Flicker rate (Hz-ish).", 0, 60),
      enabled: bool(true, "Lit when true (tween `energy` to fade instead of popping)."),
    },
  },
  Lighting2D: {
    dimension: "2d", container: false,
    doc: "Scene darkness: everything (except `emissive` things and UI) is darkened toward `ambient`; Light2Ds cut holes. One per scene.",
    props: {
      ...base,
      ambient: color("#0b0d1a", "Color of unlit areas (deep blue night, black cave, red alarm)."),
      darkness: num(0.85, "0 = no darkening, 1 = unlit areas are exactly `ambient`.", 0, 1),
      vignette: num(0, "0..1 darker screen edges.", 0, 1),
    },
  },
  SpawnPoint2D: {
    dimension: "2d", container: false,
    doc: "Where player avatars spawn.",
    props: { ...transform2d },
  },

  // ----- 3D -----
  Node3D: {
    dimension: "3d", container: true,
    doc: "Empty 3D transform.",
    props: { ...transform3d },
  },
  Mesh3D: {
    dimension: "3d", container: true,
    doc: "Visible geometry: a mesh asset, or a primitive when `mesh` is unset.",
    props: {
      ...transform3d,
      mesh: asset("mesh", "glTF mesh asset. Overrides `primitive`."),
      primitive: oneOf(["box", "sphere", "capsule", "cylinder", "plane"], "box", "Used when `mesh` is unset."),
      size: vec3([1, 1, 1], "Primitive size in meters."),
      color: color("#cccccc", "Albedo for primitives / tint for meshes."),
      texture: asset("image", "Albedo texture for primitives."),
      cast_shadow: bool(true, "Casts shadows."),
    },
  },
  Body3D: {
    dimension: "3d", container: true,
    doc: "Physics body. Put Mesh3D children on it for visuals.",
    props: {
      ...transform3d,
      body: oneOf(BODY_KINDS, "static", "static / dynamic / kinematic."),
      shape: oneOf(["box", "sphere", "capsule", "cylinder"], "box", "Collision shape."),
      size: vec3([1, 1, 1], "Shape size in meters."),
      ...physics,
    },
  },
  Area3D: {
    dimension: "3d", container: true,
    doc: "Trigger volume.",
    props: { ...transform3d, shape: oneOf(["box", "sphere"], "box", "Shape."), size: vec3([1, 1, 1], "Size.") },
  },
  Camera3D: {
    dimension: "3d", container: false,
    doc: "3D camera. The `current` one renders.",
    props: { ...transform3d, fov: num(70, "Vertical FOV degrees.", 10, 170), follow: entity("Entity to follow."), current: bool(true, "Active camera.") },
  },
  Light3D: {
    dimension: "3d", container: false,
    doc: "Light source.",
    props: {
      ...transform3d,
      kind: oneOf(["directional", "point", "spot"], "directional", "Light type."),
      color: color("#ffffff", "Color."),
      energy: num(1, "Intensity.", 0, 100),
      range: num(10, "Meters (point/spot).", 0),
      shadows: bool(true, "Casts shadows."),
    },
  },
  Environment3D: {
    dimension: "3d", container: false,
    doc: "Sky, ambient light and fog. One per scene.",
    props: {
      ...base,
      sky_color: color("#87ceeb", "Sky."),
      ground_color: color("#6b8e23", "Horizon/ground."),
      ambient_energy: num(0.5, "Ambient light.", 0, 10),
      fog: bool(false, "Enable fog."),
    },
  },
  SpawnPoint3D: {
    dimension: "3d", container: false,
    doc: "Where player avatars spawn.",
    props: { ...transform3d },
  },

  // ----- any -----
  Sound: {
    dimension: "any", container: false,
    doc: "Audio player. Spatial if under a 2D/3D transform and `spatial` is true.",
    props: { ...base, sound: asset("audio", "Audio asset."), volume_db: num(0, "Volume.", -80, 24), autoplay: bool(false, "Play on start."), loop: bool(false, "Loop."), spatial: bool(false, "Positional audio.") },
  },
  UIText: {
    dimension: "any", container: false,
    doc: "Screen-space text (HUD).",
    props: { ...ui, text: str("", "Text."), font_size: int(24, "Pixels.", 4, 256), color: color("#ffffff", "Color."), align: oneOf(["left", "center", "right"], "left", "Alignment."),
      valign: oneOf(["top", "center", "bottom"], "center", "Vertical alignment inside `size`."), ...textStyle, input_transparent: bool(true, "Taps pass through to what is behind (UIText never takes taps).") },
  },
  UIButton: {
    dimension: "any", container: false,
    doc: "Screen-space button; scripts listen for presses.",
    props: {
      ...ui, text: str("Button", "Label (empty = icon only)."), font_size: int(24, "Pixels.", 4, 256), color: color("#ffffff", "Text color."), background: color("#333333cc", "Fill."), font: textStyle.font,
      icon: asset("image", "Optional icon image shown with the label."),
      icon_size: int(0, "Icon size in pixels (0 = 70% of the button height, or 45% with icon_position top).", 0, 512),
      icon_position: oneOf(["left", "top"], "left", "Icon left of the label, or above it."),
    },
  },
  UIPanel: {
    dimension: "any", container: true,
    doc: "Screen-space rectangle; parent for other UI.",
    props: {
      ...ui, background: color("#000000aa", "Fill."), image: asset("image", "Optional background image."),
      input_transparent: bool(false, "Taps pass through the panel itself (its buttons still work) — for HUD frames over the play area."),
      scroll: bool(false, "Vertical scrolling list: clips children; drag/flick on touch, mouse wheel on desktop. Content height = lowest child (use layout = \"stack\" to stack children automatically)."),
      layout: oneOf(["none", "stack"], "none", 'stack = children placed top to bottom in order (their offset.y adds extra space, anchor picks left/center/right); none = each child uses its own anchor + offset.'),
      gap: int(12, "Space between stacked children (layout = stack).", 0, 1000),
      padding: int(0, "Inset of stacked children from the panel's top (layout = stack).", 0, 1000),
      tint: color("#ffffff", "Multiplies `image` (recolor one panel image)."),
      radius: int(-1, "Corner radius in pixels (-1 = from the [ui] panel style).", -1, 1000),
      clip: bool(false, "Clip children to the panel (scroll panels always clip)."),
    },
  },
} satisfies Record<string, EntityTypeDef>;

export type EntityType = keyof typeof CATALOG;
export const ENTITY_TYPES = Object.keys(CATALOG) as EntityType[];

export function getType(name: string): EntityTypeDef | undefined {
  return (CATALOG as Record<string, EntityTypeDef>)[name];
}
