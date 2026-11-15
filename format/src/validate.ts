import { parse as parseToml } from "smol-toml";
import type { z } from "zod";
import { getType, type EntityTypeDef, type PropDef } from "./catalog.js";
import type { Package } from "./package.js";
import { STYLES } from "./styles.js";
import { MUSIC_PATH_RE, parseMusic, parseSfx, SFX_PATH_RE } from "./audio.js";
import { ANIMS_PATH_RE, parseAnims } from "./anims.js";
import { expandKits, isKit, KIT_REQUIRE_RE, KITS } from "./kits.js";
import { parseTileset, resolveTileMap, TILESET_PATH_RE } from "./tilemap.js";
import {
  ASSET_EXTENSIONS,
  AssetMeta,
  ID_RE,
  Manifest,
  Scene,
  type Entity,
} from "./schema.js";

export interface Issue {
  severity: "error" | "warning";
  /** Stable machine code, e.g. "scene.orphan". */
  code: string;
  message: string;
  /** Package file the issue is in. */
  file?: string;
  /** Entity or asset id, when relevant. */
  id?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: Issue[];
  manifest?: Manifest;
  scenes: Record<string, Scene>;
  assets: Record<string, AssetMeta>;
}

export const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
const TOP_LEVEL = new Set(["dreamsy.toml", "notes.md", "scenes", "scripts", "data", "assets"]);

const zodMessages = (err: z.ZodError) =>
  err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

export function parseManifest(text: string): { manifest?: Manifest; error?: string } {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    return { error: `not valid TOML: ${(e as Error).message}` };
  }
  const r = Manifest.safeParse(raw);
  return r.success ? { manifest: r.data } : { error: zodMessages(r.error) };
}

/**
 * Full static validation. Issues are written to be fed straight back to the model,
 * so messages name the file, the id and what to do.
 */
export function validatePackage(pkg: Package): ValidationResult {
  const issues: Issue[] = [];
  const err = (code: string, message: string, extra: Partial<Issue> = {}) =>
    issues.push({ severity: "error", code, message, ...extra });
  const warn = (code: string, message: string, extra: Partial<Issue> = {}) =>
    issues.push({ severity: "warning", code, message, ...extra });

  if (pkg.size > MAX_PACKAGE_BYTES) err("package.too_large", `package is ${pkg.size} bytes; max ${MAX_PACKAGE_BYTES}`);

  for (const p of pkg.paths()) {
    if (!TOP_LEVEL.has(p.split("/")[0]!)) warn("package.unknown_file", `unexpected file ${p}; it will be ignored`, { file: p });
  }

  // ----- manifest -----
  let manifest: Manifest | undefined;
  const manifestText = pkg.text("dreamsy.toml");
  if (manifestText === undefined) {
    err("manifest.missing", "dreamsy.toml is missing", { file: "dreamsy.toml" });
  } else {
    const r = parseManifest(manifestText);
    if (r.error) err("manifest.invalid", r.error, { file: "dreamsy.toml" });
    manifest = r.manifest;
  }
  if (manifest) {
    if (manifest.players.min > manifest.players.max) err("manifest.players", "players.min must be ≤ players.max", { file: "dreamsy.toml" });
    if (manifest.server.mode === "async" && !manifest.server.deterministic) {
      err("manifest.async_needs_determinism", 'server.mode = "async" requires server.deterministic = true', { file: "dreamsy.toml" });
    }
    if (manifest.players.max > 1 && manifest.server.mode === "none") {
      err("manifest.multiplayer_needs_server", 'players.max > 1 requires server.mode other than "none"', { file: "dreamsy.toml" });
    }
    if (!pkg.has(manifest.entry_scene)) err("manifest.entry_scene", `entry_scene ${manifest.entry_scene} does not exist`, { file: "dreamsy.toml" });
    const style = STYLES[manifest.style.preset];
    if (!style.dimensions.includes(manifest.dimension)) {
      err("manifest.style_dimension", `style "${manifest.style.preset}" supports ${style.dimensions.join("/")} games only`, { file: "dreamsy.toml" });
    }
    if (manifest.style.preset === "custom" && !manifest.style.notes) {
      err("manifest.style_notes", 'style.preset = "custom" requires style.notes', { file: "dreamsy.toml" });
    }
    const seenKits = new Set<string>();
    for (const k of manifest.kits ?? []) {
      if (!isKit(k)) err("manifest.unknown_kit", `kits: unknown kit "${k}" (available: ${KITS.join(", ")})`, { file: "dreamsy.toml" });
      if (seenKits.has(k)) err("manifest.duplicate_kit", `kits: "${k}" is listed twice`, { file: "dreamsy.toml" });
      seenKits.add(k);
    }
    if (manifest.style.grid && manifest.style.preset !== "pixel") {
      warn("manifest.style_grid", "style.grid only applies to the pixel preset", { file: "dreamsy.toml" });
    }
  }

  // ----- assets -----
  const assets: Record<string, AssetMeta> = {};
  const metaFiles = new Set<string>();
  for (const p of pkg.paths("assets/")) {
    const m = p.match(/^assets\/([^/]+)\.meta\.json$/);
    if (!m) continue;
    metaFiles.add(p);
    const id = m[1]!;
    if (!ID_RE.test(id)) { err("asset.bad_id", `asset id "${id}" must be lowercase snake_case`, { file: p, id }); continue; }
    let raw: unknown;
    try { raw = JSON.parse(pkg.text(p)!); } catch (e) { err("asset.meta_json", `not valid JSON: ${(e as Error).message}`, { file: p, id }); continue; }
    const r = AssetMeta.safeParse(raw);
    if (!r.success) { err("asset.meta_invalid", zodMessages(r.error), { file: p, id }); continue; }
    const meta = r.data;
    const ext = meta.file.split(".").pop()!;
    if (!(ASSET_EXTENSIONS[meta.kind] as readonly string[]).includes(ext)) {
      err("asset.bad_extension", `${meta.kind} asset must be one of ${ASSET_EXTENSIONS[meta.kind].join(", ")}; got .${ext}`, { file: p, id });
    }
    if (!pkg.has(`assets/${meta.file}`)) err("asset.file_missing", `assets/${meta.file} referenced by ${p} does not exist`, { file: p, id });
    else if (ext === "svg") {
      const problem = checkSvg(pkg.text(`assets/${meta.file}`)!);
      if (problem) err("asset.svg_unsafe", `assets/${meta.file}: ${problem}`, { file: `assets/${meta.file}`, id });
    }
    assets[id] = meta;
  }
  const storeIds = new Set<string>();
  for (const item of manifest?.store ?? []) {
    if (storeIds.has(item.id)) err("store.duplicate_id", `store item "${item.id}" is defined twice`, { file: "dreamsy.toml", id: item.id });
    storeIds.add(item.id);
    if (item.icon && assets[item.icon.slice(6)]?.kind !== "image") err("store.icon", `store item "${item.id}": icon ${item.icon} is not an image asset`, { file: "dreamsy.toml", id: item.id });
  }
  for (const ref of manifest?.style.references ?? []) {
    if (assets[ref]?.kind !== "image") err("manifest.style_reference", `style.references: "${ref}" is not an image asset`, { file: "dreamsy.toml", id: ref });
  }
  const referencedAssetFiles = new Set(Object.values(assets).map((a) => `assets/${a.file}`));
  for (const p of pkg.paths("assets/")) {
    if (!metaFiles.has(p) && !referencedAssetFiles.has(p)) warn("asset.no_meta", `${p} has no .meta.json and can't be referenced`, { file: p });
  }

  // ----- scripts -----
  for (const p of pkg.paths("scripts/")) {
    if (!/^scripts\/(client|server|shared)\/[a-z0-9_\-/]+\.luau$/.test(p)) {
      err("script.bad_path", `${p}: scripts must be scripts/{client,server,shared}/<name>.luau (lowercase)`, { file: p });
    }
  }

  // ----- data (tilesets, level grids) -----
  for (const p of pkg.paths("data/")) {
    if (p.startsWith("data/tilesets/")) {
      if (!TILESET_PATH_RE.test(p)) { err("tileset.bad_path", `${p}: tilesets must be data/tilesets/<name>.json (lowercase)`, { file: p }); continue; }
      const t = parseTileset(pkg.text(p)!);
      for (const m of t.errors) err("tileset.invalid", m, { file: p });
      for (const m of t.warnings) warn("tileset.warning", m, { file: p });
      for (const [ch, def] of Object.entries(t.tileset?.tiles ?? {})) {
        if (!def.sprite) continue;
        const id = def.sprite.slice(6);
        if (!assets[id]) err("tileset.sprite_missing", `tile "${ch}": asset "${id}" does not exist (needs assets/${id}.meta.json)`, { file: p, id });
        else if (assets[id]!.kind !== "image") err("tileset.sprite_kind", `tile "${ch}": "${id}" is a ${assets[id]!.kind} asset, not an image`, { file: p, id });
      }
    } else if (p.startsWith("data/sfx/")) {
      if (!SFX_PATH_RE.test(p)) { err("sfx.bad_path", `${p}: sound effects must be data/sfx/<id>.json (lowercase_snake id)`, { file: p }); continue; }
      for (const m of parseSfx(pkg.text(p)!).errors) err("sfx.invalid", m, { file: p });
    } else if (p.startsWith("data/music/")) {
      if (!MUSIC_PATH_RE.test(p)) { err("music.bad_path", `${p}: music must be data/music/<id>.json (lowercase_snake id)`, { file: p }); continue; }
      for (const m of parseMusic(pkg.text(p)!).errors) err("music.invalid", m, { file: p });
    } else if (p.startsWith("data/anims/")) {
      if (!ANIMS_PATH_RE.test(p)) { err("anims.bad_path", `${p}: animation sets must be data/anims/<name>.json (lowercase_snake)`, { file: p }); continue; }
      const r = parseAnims(pkg.text(p)!);
      for (const m of r.errors) err("anims.invalid", m, { file: p });
      for (const [name, a] of Object.entries(r.value ?? {})) {
        for (const f of a.frames) {
          const id = f.slice(6);
          if (!assets[id]) err("anims.frame_missing", `"${name}": frame asset "${id}" does not exist (needs assets/${id}.meta.json)`, { file: p, id });
          else if (assets[id]!.kind !== "image") err("anims.frame_kind", `"${name}": "${id}" is a ${assets[id]!.kind} asset, not an image`, { file: p, id });
        }
      }
    } else if (p.endsWith(".txt") && !/^data\/[a-z0-9_\-/]+\.txt$/.test(p)) {
      warn("data.bad_text_path", `${p}: text data files must be data/<dir>/<name>.txt (lowercase)`, { file: p });
    }
  }

  // ----- scenes -----
  const scenes: Record<string, Scene> = {};
  const idOwner = new Map<string, string>(); // entity id → scene file
  for (const p of pkg.paths("scenes/")) {
    if (!p.endsWith(".scene.json")) { warn("scene.unknown_file", `${p} is not a .scene.json file`, { file: p }); continue; }
    let raw: unknown;
    try { raw = JSON.parse(pkg.text(p)!); } catch (e) { err("scene.json", `not valid JSON: ${(e as Error).message}`, { file: p }); continue; }
    const r = Scene.safeParse(raw);
    if (!r.success) { err("scene.invalid", zodMessages(r.error), { file: p }); continue; }
    scenes[p] = r.data;
    for (const id of Object.keys(r.data.entities)) {
      const prev = idOwner.get(id);
      if (prev) err("entity.duplicate_id", `id "${id}" is used in both ${prev} and ${p}; ids must be unique across the package`, { file: p, id });
      else idOwner.set(id, p);
    }
  }

  for (const [file, scene] of Object.entries(scenes)) {
    validateScene(file, scene, { manifest, assets, pkg, err, warn });
  }

  // literal loadScene("...") targets must exist
  for (const p of pkg.paths("scripts/")) {
    if (!p.endsWith(".luau")) continue;
    for (const m of pkg.text(p)!.matchAll(/\bloadScene\s*\(\s*["']([^"']*)["']/g)) {
      const target = m[1]!;
      if (pkg.has(target) && target.startsWith("scenes/") && target.endsWith(".scene.json")) continue;
      const guess = `scenes/${target.replace(/^scenes\//, "").replace(/\.scene\.json$/, "")}.scene.json`;
      err("script.scene_missing", `${p}: loadScene("${target}") — no such scene${pkg.has(guess) ? `; did you mean "${guess}"?` : ` (scenes are "scenes/<name>.scene.json")`}`, { file: p });
    }
  }

  // literal require("@kit/<kit>[/<sub>]") must name a kit listed in dreamsy.toml kits
  for (const p of pkg.paths("scripts/")) {
    if (!p.endsWith(".luau")) continue;
    for (const m of pkg.text(p)!.matchAll(/\brequire\s*\(\s*["'](@[^"']*)["']/g)) {
      const km = KIT_REQUIRE_RE.exec(m[1]!);
      if (!km) { err("script.bad_kit_require", `${p}: require("${m[1]}") — kit modules are required as "@kit/<kit>" or "@kit/<kit>/<module>"`, { file: p }); continue; }
      const kit = km[1]!;
      if (!isKit(kit)) err("script.unknown_kit", `${p}: require("${m[1]}") — no kit "${kit}" (available: ${KITS.join(", ")})`, { file: p });
      else if (!expandKits(manifest?.kits ?? []).includes(kit)) err("script.kit_not_enabled", `${p}: require("${m[1]}") — add "${kit}" to dreamsy.toml: kits = [${[...(manifest?.kits ?? []), kit].map((x) => `"${x}"`).join(", ")}]`, { file: p });
    }
  }

  // literal sfx.play("id") / music.play("id") targets must exist
  for (const p of pkg.paths("scripts/")) {
    if (!p.endsWith(".luau")) continue;
    for (const m of pkg.text(p)!.matchAll(/\b(sfx|music)\.play\s*\(\s*["']([^"']*)["']/g)) {
      const file = `data/${m[1]}/${m[2]}.json`;
      if (!pkg.has(file)) err(`script.${m[1]}_missing`, `${p}: ${m[1]}.play("${m[2]}") — ${file} does not exist`, { file: p });
    }
  }

  if (manifest && scenes[manifest.entry_scene]) {
    const entry = scenes[manifest.entry_scene]!;
    const types = Object.values(entry.entities).map((e) => e.type);
    const camera = manifest.dimension === "2d" ? "Camera2D" : "Camera3D";
    // screen-only scenes (menus, card games built from UI) don't need a camera
    const hasWorld = types.some((t) => { const d = getType(t); return !!d && d.dimension !== "any"; });
    if (!types.includes(camera) && hasWorld) warn("scene.no_camera", `entry scene has no ${camera}; a default camera will be used`, { file: manifest.entry_scene });
    if (manifest.avatar.enabled && !types.some((t) => t.startsWith("SpawnPoint"))) {
      err("scene.no_spawn", "avatar.enabled requires a SpawnPoint2D/SpawnPoint3D in the entry scene", { file: manifest.entry_scene });
    }
  }

  return { ok: !issues.some((i) => i.severity === "error"), issues, manifest, scenes, assets };
}

interface SceneCtx {
  manifest?: Manifest;
  assets: Record<string, AssetMeta>;
  pkg: Package;
  err: (code: string, message: string, extra?: Partial<Issue>) => void;
  warn: (code: string, message: string, extra?: Partial<Issue>) => void;
}

function validateScene(file: string, scene: Scene, ctx: SceneCtx) {
  const { err, warn } = ctx;
  const ents = scene.entities;

  if (!ents[scene.root]) {
    err("scene.root_missing", `root "${scene.root}" is not an entity in this scene`, { file });
    return;
  }

  // tree integrity: each non-root entity has exactly one parent; no cycles; all reachable
  const parentOf = new Map<string, string>();
  for (const [id, e] of Object.entries(ents)) {
    const seen = new Set<string>();
    for (const c of e.children ?? []) {
      if (seen.has(c)) err("scene.duplicate_child", `"${id}" lists child "${c}" twice`, { file, id });
      seen.add(c);
      if (!ents[c]) { err("scene.missing_child", `"${id}" lists child "${c}", which does not exist`, { file, id }); continue; }
      if (c === scene.root) { err("scene.root_as_child", `root "${c}" cannot be a child of "${id}"`, { file, id }); continue; }
      const prev = parentOf.get(c);
      if (prev) err("scene.multiple_parents", `"${c}" is a child of both "${prev}" and "${id}"`, { file, id: c });
      else parentOf.set(c, id);
    }
  }
  const reachable = new Set<string>();
  const stack = [scene.root];
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const c of ents[id]?.children ?? []) if (ents[c] && parentOf.get(c) === id) stack.push(c);
  }
  for (const id of Object.keys(ents)) {
    if (!reachable.has(id)) err("scene.orphan", `"${id}" is not reachable from root "${scene.root}" (add it to a parent's children, or remove it)`, { file, id });
  }

  for (const [id, e] of Object.entries(ents)) {
    if (!ID_RE.test(id)) err("entity.bad_id", `id "${id}" must be lowercase snake_case, start with a letter, ≤64 chars`, { file, id });
    validateEntity(file, id, e, scene, ctx);
  }
}

function validateEntity(file: string, id: string, e: Entity, scene: Scene, ctx: SceneCtx) {
  const { err, warn, manifest } = ctx;
  const def = getType(e.type);
  if (!def) { err("entity.unknown_type", `"${id}" has unknown type "${e.type}"`, { file, id }); return; }
  if (manifest && def.dimension !== "any" && def.dimension !== manifest.dimension) {
    err("entity.wrong_dimension", `"${id}" is ${e.type} (${def.dimension}) but the game is ${manifest.dimension}`, { file, id });
  }
  if (!def.container && e.children?.length) err("entity.not_container", `${e.type} "${id}" cannot have children`, { file, id });

  for (const [key, value] of Object.entries(e.props ?? {})) {
    const prop = def.props[key];
    if (!prop) {
      err("prop.unknown", `"${id}" (${e.type}) has no prop "${key}". Valid: ${Object.keys(def.props).join(", ")}`, { file, id });
      continue;
    }
    const problem = checkProp(prop, value, scene, ctx);
    if (problem) err("prop.invalid", `"${id}".${key}: ${problem}`, { file, id });
  }

  for (const s of e.scripts ?? []) {
    if (!ctx.pkg.has(s)) err("entity.script_missing", `"${id}" attaches ${s}, which does not exist`, { file, id });
  }
  if (e.type === "TileMap2D") {
    const tileset = typeof e.props?.tileset === "string" ? e.props.tileset : "";
    const data = typeof e.props?.data === "string" ? e.props.data : "";
    const r = resolveTileMap(ctx.pkg, tileset, data);
    for (const m of r.errors) err("tilemap.invalid", `"${id}": ${m}`, { file, id });
    for (const m of r.warnings) warn("tilemap.warning", `"${id}": ${m}`, { file, id });
  }
  if (e.type === "Sprite2D" && (e.props?.anims || e.props?.anim)) {
    const path = typeof e.props?.anims === "string" ? e.props.anims : "";
    const anim = typeof e.props?.anim === "string" ? e.props.anim : "";
    if (!path) { if (anim) err("anims.missing", `"${id}": anim "${anim}" is set but anims is empty (set anims = "data/anims/<name>.json")`, { file, id }); }
    else if (!ANIMS_PATH_RE.test(path)) err("anims.bad_ref", `"${id}".anims: expected "data/anims/<name>.json", got "${path}"`, { file, id });
    else if (!ctx.pkg.has(path)) err("anims.missing", `"${id}".anims: ${path} does not exist`, { file, id });
    else if (anim) {
      const set = parseAnims(ctx.pkg.text(path)!).value ?? {};
      if (!set[anim]) err("anims.unknown", `"${id}".anim: "${anim}" is not in ${path} (has: ${Object.keys(set).join(", ") || "nothing"})`, { file, id });
    }
  }
  if ("layer" in def.props) {
    const declared = manifest?.physics?.layers ?? [];
    const names: [string, string[]][] = [
      ["layer", typeof e.props?.layer === "string" && e.props.layer ? [e.props.layer.trim()] : []],
      ["mask", typeof e.props?.mask === "string" ? e.props.mask.split(",").map((x) => x.trim()).filter(Boolean) : []],
    ];
    for (const [key, list] of names) {
      for (const n of list) {
        if (!declared.includes(n)) err("physics.unknown_layer", `"${id}".${key}: layer "${n}" is not declared (add it to dreamsy.toml [physics] layers = [${[...declared, n].map((x) => `"${x}"`).join(", ")}])`, { file, id });
      }
    }
  }
  if (e.type === "Mesh3D" && e.props?.mesh && e.props?.texture) {
    warn("prop.ignored", `"${id}": texture is ignored when mesh is set`, { file, id });
  }
}

export const MAX_SVG_BYTES = 256 * 1024;

/**
 * SVG sprites are model-written text. Allow plain drawing only: no scripts, event handlers,
 * external references, foreignObject or embedded HTML. Returns a problem or null.
 */
export function checkSvg(svg: string): string | null {
  if (svg.length > MAX_SVG_BYTES) return `larger than ${MAX_SVG_BYTES / 1024}KB`;
  if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg)) return "must start with <svg";
  if (!/viewBox\s*=/.test(svg)) return "needs a viewBox";
  if (/<script|<foreignObject|<iframe|<object|<embed|<!ENTITY/i.test(svg)) return "contains a disallowed element";
  if (/\son[a-z]+\s*=/i.test(svg)) return "contains an event handler attribute";
  if (/(href|src)\s*=\s*["'](?!#|data:image\/)/i.test(svg)) return "references an external resource (only #ids and data:image are allowed)";
  if (/url\(\s*["']?(?!#)/i.test(svg)) return "url() may only reference #ids";
  return null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const COLOR_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Returns a problem description, or null when valid. */
export function checkProp(prop: PropDef, v: unknown, scene: Scene, ctx: Pick<SceneCtx, "assets">): string | null {
  const t = prop.type;
  switch (t.kind) {
    case "number":
    case "int":
      if (!isNum(v)) return `expected a ${t.kind}, got ${JSON.stringify(v)}`;
      if (t.kind === "int" && !Number.isInteger(v)) return `expected an integer, got ${v}`;
      if (t.min !== undefined && v < t.min) return `must be ≥ ${t.min}`;
      if (t.max !== undefined && v > t.max) return `must be ≤ ${t.max}`;
      return null;
    case "bool":
      return typeof v === "boolean" ? null : `expected true/false, got ${JSON.stringify(v)}`;
    case "string":
      if (typeof v !== "string") return `expected a string, got ${JSON.stringify(v)}`;
      return t.maxLength !== undefined && v.length > t.maxLength ? `longer than ${t.maxLength} chars` : null;
    case "vec2":
      return Array.isArray(v) && v.length === 2 && v.every(isNum) ? null : `expected [x, y], got ${JSON.stringify(v)}`;
    case "vec3":
      return Array.isArray(v) && v.length === 3 && v.every(isNum) ? null : `expected [x, y, z], got ${JSON.stringify(v)}`;
    case "color":
      return typeof v === "string" && COLOR_RE.test(v) ? null : `expected "#rrggbb" or "#rrggbbaa", got ${JSON.stringify(v)}`;
    case "enum":
      return typeof v === "string" && t.values.includes(v) ? null : `expected one of ${t.values.join(" | ")}, got ${JSON.stringify(v)}`;
    case "asset": {
      if (typeof v !== "string" || !v.startsWith("asset:")) return `expected "asset:<id>", got ${JSON.stringify(v)}`;
      const meta = ctx.assets[v.slice(6)];
      if (!meta) return `asset "${v.slice(6)}" does not exist (needs assets/${v.slice(6)}.meta.json)`;
      return meta.kind === t.assetKind ? null : `expected a ${t.assetKind} asset, "${v.slice(6)}" is ${meta.kind}`;
    }
    case "entity":
      if (typeof v !== "string") return `expected an entity id, got ${JSON.stringify(v)}`;
      return scene.entities[v] ? null : `entity "${v}" does not exist in this scene`;
  }
}

export type { EntityTypeDef };
