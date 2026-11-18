// 2.5D height (DREAMSY.MD §14.5, slice E7): manifest/scene view, z / height props, z gravity, landing on
// blocks and raised tiles, z-range collision filtering, onGround / groundZ, camera.view and iso camera math.
// The same rules as the C++ engine (engine/src/physics/physics2d.h); run_compare.py diffs the two on
// engine/tests/scenes/z_platforms. engine-web doesn't draw the views.
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game, type Entity } from "../core/index.js";

function pkg(view: string, entities: Record<string, unknown>, script = "") {
  return Package.fromFiles({
    "dreamsy.toml": `format = "0"\nname = "H"\ndimension = "2d"\nview = "${view}"\nentry_scene = "scenes/main.scene.json"\n`,
    "scenes/main.scene.json": JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D", children: Object.keys(entities) }, ...entities } }),
    "scenes/side.scene.json": JSON.stringify({ format: "0", root: "s", view: "side", entities: { s: { type: "Node2D" } } }),
    "scripts/client/main.luau": script,
    "data/tilesets/t.json": JSON.stringify({ tiles: { "#": { color: "#8080ff", solid: true } } }),
  });
}
const steps = (g: Game, n: number) => { for (let i = 0; i < n; i++) g.step(); };
const byId = (g: Game, id: string) => g.world.byId.get(id)!;
const z = (e: Entity) => e.get<number>("z");
const pos = (e: Entity) => e.get<number[]>("position");
const logs = (g: Game) => g.logs.map((l) => l.text);
const teleport = (g: Game, e: Entity, x: number, y: number) => { e.props.position = [x, y]; g.physics!.syncTransform(e); };

const WORLD = {
  hero: { type: "Body2D", props: { position: [40, 100], body: "dynamic", size: [16, 12], height: 24, z: 5 } },
  step: { type: "Body2D", props: { position: [200, 100], size: [40, 40], height: 20 } },
  terrace: { type: "TileMap2D", props: { position: [300, 80], tile_size: 20, tileset: "data/tilesets/t.json", data: "##\n##", height: 40 } },
  wall: { type: "Body2D", props: { position: [100, 300], size: [20, 100], height: 16 } },
};

describe("2.5D height", () => {
  it("falls to the floor, lands on a block and on a raised tile map; onGround / groundZ", async () => {
    const g = await Game.load(pkg("topdown", WORLD));
    const hero = byId(g, "hero"), ph = g.physics!;
    steps(g, 30);
    expect(z(hero)).toBe(0);
    expect(ph.onGround(hero)).toBe(true);
    expect(pos(hero)[1]).toBeCloseTo(100, 5); // topdown: no planar gravity
    hero.props.z = 60; teleport(g, hero, 200, 100);
    steps(g, 60);
    expect(z(hero)).toBe(20);
    expect(ph.groundOf(hero)).toBe(20);
    hero.props.z = 80; teleport(g, hero, 310, 90);
    steps(g, 60);
    expect(z(hero)).toBe(40);
    expect(ph.groundBelow(310, 90, 30)).toBe(0);
    expect(ph.groundBelow(240, 100, 100)).toBe(0);
    hero.props.z_velocity = 300;
    g.step();
    expect(ph.onGround(hero)).toBe(false);
    expect(z(hero)).toBeGreaterThan(40);
  });

  it("z ranges gate collisions: high bodies pass over walls, flat ones are blocked", async () => {
    const g = await Game.load(pkg("oblique", {
      ...WORLD,
      high: { type: "Body2D", props: { position: [40, 280], body: "dynamic", size: [10, 10], height: 8, z: 30, z_gravity_scale: 0 } },
      flat: { type: "Body2D", props: { position: [40, 320], body: "dynamic", size: [10, 10] } },
    }));
    g.physics!.setVelocity(byId(g, "high"), [120, 0]);
    g.physics!.setVelocity(byId(g, "flat"), [120, 0]);
    steps(g, 90);
    expect(pos(byId(g, "high"))[0]).toBeGreaterThan(150);
    expect(pos(byId(g, "flat"))[0]).toBeLessThan(90.5);
  });

  it("scripts read and write z props; camera.view, iso camera math, scene view override", async () => {
    const g = await Game.load(pkg("iso", WORLD, `
      local hero = entity("hero")
      print(camera.view(), hero.z, hero.height, hero.z_gravity_scale, hero.onGround)
      local back = camera.screenToWorld(camera.worldToScreen(vec2(140, 60)))
      print(math.floor(back.x + 0.5), math.floor(back.y + 0.5))
      local d = camera.screenDirToWorld(vec2(1, 0))
      print(math.floor(d.x * 1000 + 0.5) / 1000, math.floor(d.y * 1000 + 0.5) / 1000)
      local ok, err = pcall(function() hero.groundZ = 3 end)
      print(err)
      game.sceneLoaded:connect(function(path) print(path, camera.view()) end)
      loadScene("scenes/side.scene.json")
    `));
    steps(g, 3);
    expect(g.errors).toEqual([]);
    const out = logs(g).join("\n");
    expect(out).toContain("iso\t5\t24\t1\tfalse");
    expect(out).toContain("140\t60");
    expect(out).toContain("0.707\t-0.707");
    expect(out).toContain("groundZ is read-only");
    expect(out).toContain("scenes/side.scene.json\tside");
  });
});

