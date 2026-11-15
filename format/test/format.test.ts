import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyOps,
  OpError,
  Package,
  parseOps,
  validatePackage,
  parseSfx,
  parseMusic,
  songOrder,
  noteFreq,
  parseAnims,
  referenceSize,
  orientationOf,
  KITS,
  registerKitDependencies,
  expandKits,
  kitDependencyMap,
  type Op,
} from "../src/index.js";

const example = (name: string) =>
  Package.fromDir(fileURLToPath(new URL(`../../games/examples/${name}`, import.meta.url)));

const codes = (pkg: Package) => validatePackage(pkg).issues.filter((i) => i.severity === "error").map((i) => i.code);

const MANIFEST = `format = "0"
name = "T"
dimension = "2d"
entry_scene = "scenes/main.scene.json"
`;

/** Smallest valid package, built with ops from nothing. */
function minimal(): Package {
  return applyOps(Package.fromFiles({ "dreamsy.toml": MANIFEST }), [
    { op: "add_scene", scene: "scenes/main.scene.json", root: { id: "world", type: "Node2D" } },
  ]);
}

describe("examples", () => {
  it.each(["coin-dash", "block-tower", "tile-quest", "feature-demo"])("%s is valid and round-trips through zip deterministically", async (name) => {
    const pkg = await example(name);
    const r = validatePackage(pkg);
    expect(r.issues).toEqual([]);
    const zip = pkg.toZip();
    expect(Package.fromZip(zip).toZip()).toEqual(zip);
  });
});

describe("validator", () => {
  it("minimal package is valid", () => {
    expect(codes(minimal())).toEqual([]);
  });

  it("catches tree problems", () => {
    const scene = {
      format: "0",
      root: "world",
      entities: {
        world: { type: "Node2D", children: ["a", "ghost"] },
        a: { type: "Node2D", children: ["b"] },
        b: { type: "Node2D", children: ["a"] },
        lost: { type: "Node2D" },
        cam: { type: "Camera2D", children: ["lost"] },
      },
    };
    const c = codes(Package.fromFiles({ "dreamsy.toml": MANIFEST, "scenes/main.scene.json": JSON.stringify(scene) }));
    expect(c).toContain("scene.missing_child"); // ghost
    expect(c).toContain("scene.multiple_parents"); // a under world and b
    expect(c).toContain("scene.orphan"); // cam
    expect(c).toContain("entity.not_container"); // Camera2D with children
  });

  it("checks prop types, assets and entity refs", () => {
    const pkg = applyOps(minimal(), [
      { op: "add_entity", parent: "world", id: "s", type: "Sprite2D", props: { position: [1], texture: "asset:nope", modulate: "red" } },
      { op: "add_entity", parent: "world", id: "c", type: "Camera2D", props: { follow: "missing", zoom: 0 } },
      { op: "add_entity", parent: "world", id: "x", type: "Sprite2D", props: { colour: "#fff" } },
      { op: "add_entity", parent: "world", id: "m", type: "Mesh3D" },
    ]);
    const issues = validatePackage(pkg).issues.filter((i) => i.severity === "error");
    const msgs = issues.map((i) => i.message).join("\n");
    expect(msgs).toMatch(/"s"\.position: expected \[x, y\]/);
    expect(msgs).toMatch(/asset "nope" does not exist/);
    expect(msgs).toMatch(/"s"\.modulate: expected "#rrggbb"/);
    expect(msgs).toMatch(/entity "missing" does not exist/);
    expect(msgs).toMatch(/zoom: must be ≥ 0.05/);
    expect(msgs).toMatch(/no prop "colour". Valid: .*modulate/);
    expect(issues.map((i) => i.code)).toContain("entity.wrong_dimension");
  });

  it("manifest rules: async needs determinism, multiplayer needs server, style fits dimension", () => {
    const m = (extra: string) => codes(minimal().with("dreamsy.toml", MANIFEST + extra));
    expect(m('[server]\nmode = "async"\n')).toContain("manifest.async_needs_determinism");
    expect(m("[players]\nmax = 4\n")).toContain("manifest.multiplayer_needs_server");
    expect(m('[style]\npreset = "custom"\n')).toContain("manifest.style_notes");
    expect(codes(minimal().with("dreamsy.toml", MANIFEST.replace('"2d"', '"3d"') + '[style]\npreset = "pixel"\n'))).toContain("manifest.style_dimension");
    expect(m('unknown_key = 1\n')).toContain("manifest.invalid");
  });

  it("entity ids are unique across scenes", () => {
    const pkg = applyOps(minimal(), [{ op: "add_scene", scene: "scenes/b.scene.json", root: { id: "other", type: "Node2D" } }]);
    // force a duplicate by writing the file directly
    const dup = pkg.with("scenes/b.scene.json", JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } }));
    expect(codes(dup)).toContain("entity.duplicate_id");
  });

  it("script paths and attachments", () => {
    const pkg = applyOps(minimal(), [
      { op: "add_entity", parent: "world", id: "p", type: "Node2D", scripts: ["scripts/client/p.luau"] },
    ]).with("scripts/Bad Name.luau", "");
    const c = codes(pkg);
    expect(c).toContain("entity.script_missing");
    expect(c).toContain("script.bad_path");
  });
});

describe("ops", () => {
  it("add / set / move / remove keep the tree consistent", () => {
    let pkg = applyOps(minimal(), [
      { op: "add_entity", parent: "world", id: "a", type: "Node2D" },
      { op: "add_entity", parent: "world", id: "b", type: "Node2D" },
      { op: "add_entity", parent: "a", id: "a1", type: "Sprite2D", props: { size: [8, 8] } },
      { op: "add_entity", parent: "world", id: "first", type: "Node2D", index: 0 },
      { op: "set_props", id: "a1", props: { modulate: "#ff0000", size: null } },
      { op: "move_entity", id: "a1", parent: "b" },
    ]);
    const scene = JSON.parse(pkg.text("scenes/main.scene.json")!);
    expect(scene.entities.world.children).toEqual(["first", "a", "b"]);
    expect(scene.entities.a.children).toBeUndefined();
    expect(scene.entities.b.children).toEqual(["a1"]);
    expect(scene.entities.a1.props).toEqual({ modulate: "#ff0000" });

    pkg = applyOps(pkg, [{ op: "remove_entity", id: "b" }]);
    const after = JSON.parse(pkg.text("scenes/main.scene.json")!);
    expect(Object.keys(after.entities).sort()).toEqual(["a", "first", "world"]);
    expect(codes(pkg)).toEqual([]);
  });

  it("is all-or-nothing and reports the failing op index", () => {
    const base = minimal();
    let err: unknown;
    try {
      applyOps(base, [
        { op: "add_entity", parent: "world", id: "a", type: "Node2D" },
        { op: "add_entity", parent: "world", id: "a", type: "Node2D" },
      ]);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(OpError);
    expect((err as OpError).index).toBe(1);
    expect((err as OpError).message).toMatch(/already exists/);
    expect(JSON.parse(base.text("scenes/main.scene.json")!).entities.a).toBeUndefined();
  });

  it("refuses cycles and cross-scene moves", () => {
    const pkg = applyOps(minimal(), [
      { op: "add_entity", parent: "world", id: "a", type: "Node2D" },
      { op: "add_entity", parent: "a", id: "b", type: "Node2D" },
      { op: "add_scene", scene: "scenes/other.scene.json", root: { id: "other", type: "Node2D" } },
    ]);
    expect(() => applyOps(pkg, [{ op: "move_entity", id: "a", parent: "b" }])).toThrow(/own descendant/);
    expect(() => applyOps(pkg, [{ op: "move_entity", id: "a", parent: "other" }])).toThrow(/different scenes/);
    expect(() => applyOps(pkg, [{ op: "remove_entity", id: "world" }])).toThrow(/scene root/);
  });

  it("files: write, exact single-match edit, delete", () => {
    let pkg = applyOps(minimal(), [{ op: "write_file", path: "scripts/client/a.luau", content: "local x = 1\nlocal y = 1\n" }]);
    expect(() => applyOps(pkg, [{ op: "edit_file", path: "scripts/client/a.luau", old: "= 1", new: "= 2" }])).toThrow(/more than once/);
    expect(() => applyOps(pkg, [{ op: "edit_file", path: "scripts/client/a.luau", old: "zzz", new: "" }])).toThrow(/not found/);
    pkg = applyOps(pkg, [{ op: "edit_file", path: "scripts/client/a.luau", old: "local y = 1", new: "local y = 2" }]);
    expect(pkg.text("scripts/client/a.luau")).toBe("local x = 1\nlocal y = 2\n");
    pkg = applyOps(pkg, [{ op: "delete_file", path: "scripts/client/a.luau" }]);
    expect(pkg.has("scripts/client/a.luau")).toBe(false);
  });

  it("assets come from blobs; replacing an asset drops the old file", () => {
    const meta = (file: string) => ({ kind: "image" as const, file, source: { model: "gemini", prompt: "a cat" } });
    let pkg = applyOps(minimal(), [{ op: "put_asset", id: "cat", blob: "b1", meta: meta("cat.png") }], { b1: new Uint8Array([1]) });
    pkg = applyOps(pkg, [
      { op: "add_entity", parent: "world", id: "s", type: "Sprite2D", props: { texture: "asset:cat" } },
    ]);
    expect(codes(pkg)).toEqual([]);
    pkg = applyOps(pkg, [{ op: "put_asset", id: "cat", blob: "b2", meta: meta("cat.webp") }], { b2: new Uint8Array([2]) });
    expect(pkg.has("assets/cat.png")).toBe(false);
    expect(pkg.has("assets/cat.webp")).toBe(true);
    expect(() => applyOps(pkg, [{ op: "put_asset", id: "dog", blob: "missing", meta: meta("dog.png") }])).toThrow(/not provided/);
    pkg = applyOps(pkg, [{ op: "remove_asset", id: "cat" }]);
    expect(codes(pkg)).toContain("prop.invalid"); // dangling asset ref is caught by validation
  });

  it("set_manifest edits nested keys", () => {
    const pkg = applyOps(minimal(), [
      { op: "set_manifest", key: "style.preset", value: "pixel" },
      { op: "set_manifest", key: "style.grid", value: 16 },
      { op: "set_manifest", key: "name", value: "Renamed" },
    ]);
    const r = validatePackage(pkg);
    expect(r.manifest?.style).toMatchObject({ preset: "pixel", grid: 16 });
    expect(r.manifest?.name).toBe("Renamed");
  });

  it("parseOps rejects malformed model output with an index", () => {
    expect(() => parseOps([{ op: "add_entity", parent: "world", id: "Bad Id", type: "Node2D" }])).toThrow(/op #0/);
    expect(() => parseOps([{ op: "set_props", id: "a", props: {} }, { op: "teleport" }])).toThrow(/op #1/);
    expect(() => parseOps([{ op: "write_file", path: "../etc/passwd", content: "" }])).toThrow();
    const ok: Op[] = parseOps([{ op: "remove_entity", id: "a" }]);
    expect(ok).toHaveLength(1);
  });
});

describe("svg sprites", () => {
  const meta = { kind: "image" as const, file: "hero.svg", source: { model: "claude-opus-5-5" } };
  const put = (svg: string) => applyOps(minimal(), [{ op: "put_asset", id: "hero", blob: "b", meta }], { b: new TextEncoder().encode(svg) });
  it("accepts plain drawing", () => {
    expect(codes(put('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect x="2" y="2" width="4" height="4" fill="#f80"/><circle cx="8" cy="8" r="3" fill="url(#g)"/></svg>'))).toEqual([]);
  });
  it.each([
    ['<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>', "disallowed element"],
    ['<svg viewBox="0 0 1 1"><rect onclick="x()"/></svg>', "event handler"],
    ['<svg viewBox="0 0 1 1"><image href="https://evil.example/x.png"/></svg>', "external resource"],
    ['<svg width="16"><rect/></svg>', "viewBox"],
    ["<div>no</div>", "must start with <svg"],
  ])("rejects %s", (svg, msg) => {
    const r = validatePackage(put(svg));
    expect(r.issues.find((i) => i.code === "asset.svg_unsafe")?.message).toMatch(msg);
  });
});

describe("store items", () => {
  it("validates items, ids and icons", () => {
    const ok = minimal().with("dreamsy.toml", MANIFEST + '[[store]]\nid = "vip"\nkind = "pass"\nname = "VIP"\nprice = 100\n\n[[store]]\nid = "gems_50"\nkind = "consumable"\nname = "50 gems"\nprice = 20\n');
    const r = validatePackage(ok);
    expect(r.ok).toBe(true);
    expect(r.manifest?.store.map((i) => i.id)).toEqual(["vip", "gems_50"]);
    const dup = minimal().with("dreamsy.toml", MANIFEST + '[[store]]\nid = "vip"\nkind = "pass"\nname = "A"\nprice = 1\n\n[[store]]\nid = "vip"\nkind = "pass"\nname = "B"\nprice = 2\n');
    expect(codes(dup)).toContain("store.duplicate_id");
    const badIcon = minimal().with("dreamsy.toml", MANIFEST + '[[store]]\nid = "vip"\nkind = "pass"\nname = "A"\nprice = 1\nicon = "asset:nope"\n');
    expect(codes(badIcon)).toContain("store.icon");
    expect(codes(minimal().with("dreamsy.toml", MANIFEST + '[[store]]\nid = "vip"\nkind = "pass"\nname = "A"\nprice = 0\n'))).toContain("manifest.invalid");
  });
});

describe("TileMap2D + scenes", () => {
  const TILESET = JSON.stringify({ tiles: { "#": { sprite: "asset:dirt", solid: true }, "^": { color: "#ffffff", tags: ["spike"] }, ".": {} } });
  const DIRT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#853"/></svg>`;
  const base = () =>
    minimal()
      .with("assets/dirt.svg", DIRT)
      .with("assets/dirt.meta.json", JSON.stringify({ kind: "image", file: "dirt.svg" }))
      .with("data/tilesets/world.json", TILESET);
  const withMap = (props: Record<string, unknown>, pkg = base()) =>
    applyOps(pkg, [{ op: "add_entity", parent: "world", id: "map", type: "TileMap2D", props: { tileset: "data/tilesets/world.json", ...props } }]);
  const msgs = (pkg: Package) => validatePackage(pkg).issues.filter((i) => i.severity === "error").map((i) => `${i.code}: ${i.message}`);

  it("accepts inline grids and file: grids; short rows pad", () => {
    expect(msgs(withMap({ data: "....\n.^\n####" }))).toEqual([]);
    const pkg = applyOps(base(), [{ op: "write_file", path: "data/levels/one.txt", content: "......\n..^...\n######\n" }]);
    expect(msgs(withMap({ data: "file:data/levels/one.txt" }, pkg))).toEqual([]);
  });

  it("reports unknown chars with line/column, missing files and bad paths", () => {
    expect(msgs(withMap({ data: "..\n#X#" })).join("\n")).toMatch(/character "X" \(first at line 2, column 2\) is not defined in data\/tilesets\/world\.json/);
    expect(msgs(withMap({ data: "file:data/levels/nope.txt" })).join("\n")).toMatch(/level file data\/levels\/nope\.txt does not exist/);
    expect(msgs(withMap({ data: "file:levels/x.txt" })).join("\n")).toMatch(/must be "file:data\/levels\/<name>\.txt"/);
    expect(msgs(withMap({ data: "#", tileset: "data/tilesets/missing.json" })).join("\n")).toMatch(/tileset data\/tilesets\/missing\.json does not exist/);
    expect(msgs(withMap({ data: "#", tileset: "tiles.json" })).join("\n")).toMatch(/must be "data\/tilesets\/<name>\.json"/);
  });

  it("checks tileset files: JSON, schema, single-char keys, sprite assets", () => {
    const bad = (t: unknown) => msgs(base().with("data/tilesets/world.json", typeof t === "string" ? t : JSON.stringify(t))).join("\n");
    expect(bad("{ nope")).toMatch(/tileset.invalid: not valid JSON/);
    expect(bad({ tiles: { ab: { solid: true } } })).toMatch(/tile key "ab" must be exactly one printable ASCII character/);
    expect(bad({ tiles: { "#": { sprite: "asset:ghost" } } })).toMatch(/tile "#": asset "ghost" does not exist/);
    expect(bad({ tiles: { "#": { solid: "yes" } } })).toMatch(/tiles\.#\.solid/);
    expect(bad({ tiles: { "#": { solid: true, bounce: 1 } } })).toMatch(/bounce/);
  });

  it("enforces the size limit", () => {
    const row = "#".repeat(1025);
    expect(msgs(withMap({ data: row })).join("\n")).toMatch(/grid is 1025×1 tiles; max 1024×256/);
    const tall = Array.from({ length: 257 }, () => "#").join("\n");
    const pkg = base().with("data/levels/tall.txt", tall);
    expect(msgs(withMap({ data: "file:data/levels/tall.txt" }, pkg)).join("\n")).toMatch(/1×257 tiles/);
  });

  it("ops: data/levels/*.txt and data/tilesets/*.json are writable text; other data/**/*.txt too", () => {
    expect(() => parseOps([{ op: "write_file", path: "data/levels/a.txt", content: "#" }])).not.toThrow();
    expect(() => parseOps([{ op: "write_file", path: "data/tilesets/a.json", content: "{}" }])).not.toThrow();
    expect(() => parseOps([{ op: "edit_file", path: "data/levels/sub/b.txt", old: "#", new: "." }])).not.toThrow();
    expect(() => parseOps([{ op: "write_file", path: "data/notes.txt", content: "x" }])).not.toThrow(); // any data/**/*.txt
    expect(() => parseOps([{ op: "write_file", path: "scripts/client/a.txt", content: "x" }])).toThrow(OpError);
  });

  it("literal loadScene targets must exist", () => {
    const pkg = base().with("scripts/client/go.luau", `loadScene("scenes/main.scene.json")\nloadScene("level_2")`);
    const m = msgs(pkg);
    expect(m.filter((x) => x.startsWith("script.scene_missing"))).toHaveLength(1);
    expect(m.join("\n")).toMatch(/loadScene\("level_2"\) — no such scene/);
    const fixed = applyOps(pkg, [{ op: "add_scene", scene: "scenes/level_2.scene.json", root: { id: "l2", type: "Node2D" } }]);
    expect(msgs(fixed).join("\n")).toMatch(/did you mean "scenes\/level_2\.scene\.json"/);
  });
});

describe("audio data + [ui]", () => {
  const msgs = (pkg: Package) => validatePackage(pkg).issues.filter((i) => i.severity === "error").map((i) => `${i.code}: ${i.message}`).join("\n");

  it("sfx: defaults, ranges, length, bad paths", () => {
    expect(parseSfx(`{"wave":"noise","freq":800}`)).toMatchObject({ errors: [], value: { wave: "noise", freq: 800, attack: 0, sustain: 0.1, decay: 0.2, slide: 0, duty: 0.5, volume: 0.5 } });
    expect(parseSfx(`{"freq":5}`).errors.join()).toMatch(/freq/);
    expect(parseSfx(`{"wave":"pulse"}`).errors.join()).toMatch(/wave/);
    expect(parseSfx(`{"slide":9}`).errors.join()).toMatch(/slide/);
    expect(parseSfx(`{"sustain":2,"decay":3,"attack":1}`).errors.join()).toMatch(/max 5s/);
    expect(parseSfx(`{"pitch":1}`).errors.join()).toMatch(/pitch/); // unknown key
    expect(msgs(minimal().with("data/sfx/Jump.json", "{}"))).toMatch(/sfx.bad_path/);
    expect(msgs(minimal().with("data/sfx/jump.json", `{"volume":2}`))).toMatch(/sfx.invalid: volume/);
  });

  it("music: notes as array or string, patterns, order, channel limit", () => {
    const ok = parseMusic(JSON.stringify({ bpm: 120, steps: 4, channels: [{ notes: "C4 - E4 . G#3 Bb2 - ." }, { wave: "noise", notes: ["C2", ".", "C8", ".", "C2", ".", "C8", "."] }], order: [0, 1, 1] }));
    expect(ok.errors).toEqual([]);
    expect(ok.value!.channels[0]!.notes).toEqual(["C4", "-", "E4", ".", "G#3", "Bb2", "-", "."]);
    expect(songOrder(ok.value!)).toEqual([0, 1, 1]);
    expect(noteFreq("A4")).toBeCloseTo(440);
    expect(noteFreq("C4")).toBeCloseTo(261.63, 1);
    expect(parseMusic(JSON.stringify({ steps: 4, channels: [{ notes: "C4 - H4 ." }] })).errors.join()).toMatch(/bad note "H4"/);
    expect(parseMusic(JSON.stringify({ steps: 4, channels: [{ notes: "C9 - - ." }] })).errors.join()).toMatch(/bad note "C9"/);
    expect(parseMusic(JSON.stringify({ steps: 4, channels: [{ notes: "C4 - ." }] })).errors.join()).toMatch(/multiple of steps/);
    expect(parseMusic(JSON.stringify({ steps: 4, channels: [{ notes: "C4 - - ." }], order: [0, 1] })).errors.join()).toMatch(/pattern 1 does not exist/);
    expect(parseMusic(JSON.stringify({ bpm: 300, channels: [{ notes: "C4" }] })).errors.join()).toMatch(/bpm/);
    const five = Array.from({ length: 5 }, () => ({ notes: "C4" }));
    expect(parseMusic(JSON.stringify({ steps: 1, channels: five })).errors.join()).toMatch(/channels/);
  });

  it("validator: literal sfx.play / music.play ids must exist; [ui] is checked", () => {
    const pkg = minimal().with("scripts/client/a.luau", `sfx.play("jump") music.play("theme", { fade = 1 })`);
    const m = msgs(pkg);
    expect(m).toMatch(/sfx\.play\("jump"\) — data\/sfx\/jump\.json does not exist/);
    expect(m).toMatch(/music\.play\("theme"\) — data\/music\/theme\.json does not exist/);
    const fixed = pkg.with("data/sfx/jump.json", "{}").with("data/music/theme.json", JSON.stringify({ channels: [{ notes: Array(16).fill(".") }] }));
    expect(msgs(fixed)).toBe("");
    expect(msgs(minimal().with("dreamsy.toml", MANIFEST + `[ui]\npanel = "pixel"\nfont = "serif"\nprimary = "#112233"\n`))).toBe("");
    expect(msgs(minimal().with("dreamsy.toml", MANIFEST + `[ui]\npanel = "fancy"\n`))).toMatch(/manifest.invalid: ui.panel/);
    expect(() => parseOps([{ op: "write_file", path: "data/sfx/jump.json", content: "{}" }, { op: "edit_file", path: "data/music/theme.json", old: "a", new: "b" }])).not.toThrow();
  });
});

describe("engine v3: orientation, layers, anims, particles, text", () => {
  const msgs = (pkg: Package) => validatePackage(pkg).issues.filter((i) => i.severity === "error").map((i) => `${i.code}: ${i.message}`).join("\n");
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>`;
  const withAsset = (p: Package, id: string) => p.with(`assets/${id}.svg`, SVG).with(`assets/${id}.meta.json`, JSON.stringify({ kind: "image", file: `${id}.svg` }));
  const scene = (entities: Record<string, unknown>) => JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D", children: Object.keys(entities) }, ...entities } });

  it("orientation is optional and portrait/landscape only; referenceSize follows it", () => {
    expect(msgs(minimal().with("dreamsy.toml", MANIFEST + `orientation = "portrait"\n`))).toBe("");
    expect(msgs(minimal().with("dreamsy.toml", MANIFEST + `orientation = "sideways"\n`))).toMatch(/manifest.invalid: orientation/);
    expect(referenceSize({})).toEqual([1280, 720]);
    expect(referenceSize({ orientation: "portrait" })).toEqual([720, 1280]);
    expect(orientationOf({})).toBe("landscape");
  });

  it("collision layers: declared names only, ≤16, unique", () => {
    const base = minimal().with("dreamsy.toml", MANIFEST + `[physics]\nlayers = ["player", "world"]\n`);
    const ok = base.with("scenes/main.scene.json", scene({ p: { type: "Body2D", props: { layer: "player", mask: "world, player" } }, z: { type: "Area2D", props: { mask: "player" } } }));
    expect(msgs(ok)).toBe("");
    const bad = base.with("scenes/main.scene.json", scene({ p: { type: "Body2D", props: { layer: "hero", mask: "world,lava" } } }));
    const m = msgs(bad);
    expect(m).toMatch(/physics.unknown_layer: "p".layer: layer "hero" is not declared/);
    expect(m).toMatch(/"p".mask: layer "lava"/);
    const many = Array.from({ length: 17 }, (_, i) => `"l${i}"`).join(", ");
    expect(msgs(minimal().with("dreamsy.toml", MANIFEST + `[physics]\nlayers = [${many}]\n`))).toMatch(/at most 16/);
    expect(msgs(minimal().with("dreamsy.toml", MANIFEST + `[physics]\nlayers = ["a", "a"]\n`))).toMatch(/unique/);
  });

  it("anims: data/anims/<name>.json with image frames; Sprite2D anims/anim refs checked", () => {
    let p = withAsset(withAsset(minimal(), "run_1"), "run_2");
    p = p.with("data/anims/fox.json", JSON.stringify({ run: { frames: ["asset:run_1", "asset:run_2"], fps: 12 }, hit: { frames: ["asset:run_1"], loop: false, next: "run" } }));
    expect(parseAnims(p.text("data/anims/fox.json")!).value!.run!.loop).toBe(true);
    const ok = p.with("scenes/main.scene.json", scene({ s: { type: "Sprite2D", props: { anims: "data/anims/fox.json", anim: "run", auto_flip: true } } }));
    expect(msgs(ok)).toBe("");
    expect(msgs(ok.with("scenes/main.scene.json", scene({ s: { type: "Sprite2D", props: { anims: "data/anims/fox.json", anim: "fly" } } })))).toMatch(/"s".anim: "fly" is not in data\/anims\/fox.json \(has: run, hit\)/);
    expect(msgs(ok.with("scenes/main.scene.json", scene({ s: { type: "Sprite2D", props: { anims: "data/anims/cat.json" } } })))).toMatch(/data\/anims\/cat.json does not exist/);
    const bad = msgs(p.with("data/anims/fox.json", JSON.stringify({ run: { frames: ["asset:nope"] }, hit: { frames: ["asset:run_1"], next: "zzz" } })));
    expect(bad).toMatch(/frame asset "nope" does not exist/);
    expect(bad).toMatch(/no animation "zzz"/);
    expect(msgs(p.with("data/anims/fox.json", JSON.stringify({ run: { frames: [], fps: 99 } })))).toMatch(/anims.invalid/);
    expect(() => parseOps([{ op: "write_file", path: "data/anims/fox.json", content: "{}" }])).not.toThrow();
  });

  it("Particles2D, camera limits and text style props are in the catalog", () => {
    const ok = minimal().with("scenes/main.scene.json", scene({
      fx: { type: "Particles2D", props: { rate: 40, gravity: [0, 300], start_color: "#ffcc00", end_color: "#ff000000", shape: "circle" } },
      cam: { type: "Camera2D", props: { smoothing: 0.6, deadzone: [80, 40], limit_min: [0, 0], limit_max: [3000, 720] } },
      t: { type: "Text2D", props: { text: "Hi", font: "rounded", outline: "#000000", outline_size: 3, shadow: "#00000088" } },
      u: { type: "UIText", props: { text: "Score", font: "pixel", outline_size: 2, outline: "#1a1c2c" } },
    }));
    expect(msgs(ok)).toBe("");
    expect(msgs(ok.with("scenes/main.scene.json", scene({ fx: { type: "Particles2D", props: { rate: -1, shape: "star" } } })))).toMatch(/"fx".rate: must be ≥ 0[\s\S]*"fx".shape/);
    expect(msgs(ok.with("scenes/main.scene.json", scene({ t: { type: "Text2D", props: { font: "comic" } } })))).toMatch(/"t".font/);
  });
});

describe("kits", () => {
  const msgs = (pkg: Package) => validatePackage(pkg).issues.filter((i) => i.severity === "error").map((i) => `${i.code}: ${i.message}`).join("\n");
  it("manifest kits must be shipped kits; require(\"@kit/…\") needs the kit enabled", () => {
    expect(KITS).toContain("rpg");
    const withKits = (k: string) => minimal().with("dreamsy.toml", MANIFEST + `kits = [${k}]\n`);
    expect(msgs(withKits(`"rpg"`).with("scripts/client/a.luau", `local rpg = require("@kit/rpg")\nlocal b = require("@kit/rpg/battle")`))).toBe("");
    expect(msgs(withKits(`"pokemon"`))).toMatch(/manifest.unknown_kit: kits: unknown kit "pokemon"/);
    expect(msgs(withKits(`"rpg", "rpg"`))).toMatch(/listed twice/);
    expect(msgs(minimal().with("scripts/client/a.luau", `local p = require("@kit/platformer")`))).toMatch(/script.kit_not_enabled[\s\S]*kits = \["platformer"\]/);
    expect(msgs(withKits(`"rpg"`).with("scripts/client/a.luau", `require("@kit/zelda")`))).toMatch(/no kit "zelda"/);
    expect(msgs(withKits(`"rpg"`).with("scripts/client/a.luau", `require("@kits/rpg")`))).toMatch(/script.bad_kit_require/);
  });
});

describe("kit dependencies + UI props", () => {
  const msgs = (pkg: Package) => validatePackage(pkg).issues.filter((i) => i.severity === "error").map((i) => `${i.code}: ${i.message}`).join("\n");
  it("requiring a dependency of a listed kit is accepted once the dependency map is registered", () => {
    const p = minimal().with("dreamsy.toml", MANIFEST + `kits = ["rpg"]\n`).with("scripts/client/a.luau", `local core = require("@kit/core")`);
    registerKitDependencies({});
    expect(msgs(p)).toMatch(/kit_not_enabled/);
    registerKitDependencies({ rpg: ["core", "progression"], progression: ["core"] });
    expect(msgs(p)).toBe("");
    expect(expandKits(["rpg"])).toEqual(["rpg", "core", "progression"]);
    expect(kitDependencyMap().rpg).toEqual(["core", "progression"]);
    registerKitDependencies({});
  });

  it("UIPanel scroll/input_transparent, UIButton icon, UI scale validate", () => {
    const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>`;
    const p = minimal().with("assets/star.svg", SVG).with("assets/star.meta.json", JSON.stringify({ kind: "image", file: "star.svg" }))
      .with("scenes/main.scene.json", JSON.stringify({ format: "0", root: "world", entities: {
        world: { type: "Node2D", children: ["list"] },
        list: { type: "UIPanel", props: { scroll: true, input_transparent: false, scale: [1, 1] }, children: ["b"] },
        b: { type: "UIButton", props: { icon: "asset:star", icon_position: "top", icon_size: 48, scale: [1.1, 1.1] } },
      } }));
    expect(msgs(p)).toBe("");
  });
});

describe("data text files", () => {
  it("data/**/*.txt (rooms, chunks) validate without warnings and are editable by ops", () => {
    const p = minimal().with("data/rooms/start.txt", "#..#\n").with("data/chunks/forest/a.txt", "....\n");
    expect(validatePackage(p).issues.filter((i) => i.file?.startsWith("data/"))).toEqual([]);
    expect(() => parseOps([{ op: "write_file", path: "data/rooms/b.txt", content: "#" }, { op: "edit_file", path: "data/chunks/forest/a.txt", old: "..", new: "##" }])).not.toThrow();
  });
});
