// Kit loader: require("@kit/<kit>[/<sub>]") resolves to engine-web/kits/<kit>/. Uses only its own fake kit
// sources (replacing the real ones for this file) so in-progress kits can't break it.
import { Package } from "@dreamsy/format";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expandKits, Game, kitDependencies } from "../../core/index.js";
import { loadKitSources, setKitSources } from "../../core/kits.js";

const scene = JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } });
const game = (kits: string, script: string) => Package.fromFiles({
  "dreamsy.toml": `format = "0"\nname = "K"\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\n${kits}\n`,
  "scenes/main.scene.json": scene,
  "scripts/client/main.luau": script,
});
const logs = (g: Game) => g.logs.map((l) => l.text);

const FAKE = {
  "kits/rpg/kit.json": JSON.stringify({ requires: ["core"] }),
  "kits/rpg/init.luau": `local util = require("./util")\nlocal core = require("@kit/core")\nlocal M = { loads = 0, core = core.name }\nfunction M.hello(n) return util.greet(n) end\ncount = (count or 0) + 1\nM.loads = count\nreturn M`,
  "kits/rpg/util.luau": `return { greet = function(n) return "hi " .. n .. " " .. tostring(entity == nil) end }`,
  "kits/rpg/battle/init.luau": `return { name = "battle" }`,
  "kits/rpg/battle/moves.luau": `local rpg = require("@kit/rpg")\nreturn { tackle = 10, kitLoads = rpg.loads }`,
  "kits/rpg/sneaky.luau": `return require("../../platformer/init")`,
  "kits/core/kit.json": JSON.stringify({ requires: [] }),
  "kits/core/init.luau": `-- module top level runs as session code: this onTick survives scene changes\nlocal M = { name = "core", ticks = 0 }\nonTick(function() M.ticks += 1 end)\nreturn M`,
  "kits/platformer/init.luau": `return {}`,
  "kits/combat/kit.json": JSON.stringify({ requires: ["procgen"] }),
  "kits/combat/init.luau": `local pg = require("@kit/procgen")\nreturn { roll = pg.roll, bad = function() return require("@kit/platformer") end }`,
  "kits/procgen/init.luau": `return { roll = function() return 4 end }`,
};

describe("kits", () => {
  let saved: Record<string, string>;
  beforeAll(async () => { saved = { ...(await loadKitSources()) }; setKitSources(FAKE, true); });
  afterAll(() => setKitSources(saved, true));

  it("bundles real kits via the glob import", () => {
    expect(Object.keys(saved)).toContain("kits/_template/init.luau");
  });

  it("loads kit modules, submodules, siblings and declared deps, cached per game", async () => {
    expect(kitDependencies()).toEqual({ rpg: ["core"], core: [], combat: ["procgen"] });
    expect(expandKits(["rpg"])).toEqual(["rpg", "core"]);
    const g = await Game.load(game(`kits = ["rpg"]`, `
      local rpg = require("@kit/rpg")
      local again = require("@kit/rpg")
      print(rpg.hello("fox"), rpg == again, rpg.core)
      print(require("@kit/rpg/battle/moves").tackle, require("@kit/rpg/battle/moves").kitLoads)
      print("sub", require("@kit/rpg/battle").name)
      print("core direct", require("@kit/core").name)
      print(pcall(function() return require("@kit/rpg/sneaky") end))
      print(pcall(function() return require("@kit/rpg/nope") end))
      print(pcall(function() return require("@kit/platformer") end))
    `));
    expect(g.errors).toEqual([]);
    expect(g.enabledKits).toEqual(["rpg", "core"]);
    const l = logs(g).join("\n");
    expect(l).toContain("hi fox false\ttrue\tcore");
    expect(l).toContain("10\t1");
    expect(l).toContain("sub\tbattle");
    expect(l).toContain("core direct\tcore");
    expect(l).toMatch(/false\t.*escapes kits\/rpg\//);
    expect(l).toMatch(/false\t.*kit module kits\/rpg\/nope.luau not found/);
    expect(l).toMatch(/false\t.*kit "platformer" is not enabled \(add kits = \["platformer"\]/);
    // the validator saw the dependency map too: no "kit not enabled" warning for @kit/core
    expect(l).not.toMatch(/\[validate\].*core/);
  });

  it("kits require their declared deps (cross-kit); undeclared ones get a kit.json hint", async () => {
    const g = await Game.load(game(`kits = ["combat"]`, `
      local c = require("@kit/combat")
      print("roll", c.roll())
      print(pcall(c.bad))
    `));
    const l = logs(g).join("\n");
    expect(l).toContain("roll\t4");
    expect(l).toMatch(/in kit "combat": kit "platformer" is not enabled \(declare it in kits\/combat\/kit.json "requires"\)/);
  });

  it("a game without the kit in its manifest can't require it", async () => {
    const g = await Game.load(game("", `print(pcall(function() return require("@kit/rpg") end))`));
    expect(logs(g).join("\n")).toMatch(/kit "rpg" is not enabled/);
  });
});
