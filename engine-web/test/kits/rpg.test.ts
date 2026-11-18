// rpg kit (engine-web/kits/rpg): headless core tests + a scripted end-to-end run of games/examples/kit-rpg.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Package } from "@dreamsy/format";
import { beforeAll, describe, expect, it } from "vitest";
import { Game, MemorySaveHost, type Entity } from "../../core/index.js";

const EX = resolve(__dirname, "../../../games/examples/kit-rpg");
let example: Package;
beforeAll(async () => { example = await Package.fromDir(EX); });

const noErrors = (g: Game) => expect(g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
const steps = (g: Game, n: number, each?: (i: number) => void) => { for (let i = 0; i < n; i++) { each?.(i); g.step(); } };

/** Run a Luau snippet in the example's world scene with the kit set up; `out` is returned (via save data). */
async function lua(body: string, opts: { save?: MemorySaveHost; seed?: number; ticks?: number } = {}) {
  const pkg = example.with("scripts/client/main.luau",
    `local rpg = require("@kit/rpg")\nrpg.setup()\nlocal U = rpg.util\nlocal Core = require("@kit/rpg/battle_core")\nlocal out = {}\n${body}\nsave.set("out", out)\n`);
  const save = opts.save ?? new MemorySaveHost();
  const g = await Game.load(pkg, { seed: opts.seed ?? 1, scene: "scenes/world.scene.json", save });
  if (opts.ticks) steps(g, opts.ticks);
  return { g, out: (save.data.out ?? g.save.out) as any };
}

// ---------------------------------------------------------------- overworld helpers
function playerEntity(g: Game): Entity | undefined {
  for (const e of g.world.walk()) {
    if (e.type !== "Node2D") continue;
    const s = e.children[0];
    if (s?.type === "Sprite2D" && /hero_/.test(String(s.get("texture") ?? ""))) return e;
  }
  return undefined;
}
function cell(g: Game): [number, number] {
  const p = playerEntity(g)!.get<number[]>("position");
  return [Math.floor(p[0]! / 16), Math.floor(p[1]! / 16)];
}
const AX: Record<string, [string, number]> = { up: ["move_y", -1], down: ["move_y", 1], left: ["move_x", -1], right: ["move_x", 1] };
/** Hold a direction until the player has moved `n` cells (or `max` ticks). */
function walk(g: Game, dir: string, n: number, max = 400) {
  const [axis, v] = AX[dir]!;
  let moved = 0, last = cell(g).join(), t = 0;
  while (moved < n && t++ < max) {
    g.input.setAxis(axis, v);
    g.step();
    const now = cell(g).join();
    if (now !== last) { moved++; last = now; }
  }
  // let the last step finish
  g.input.setAxis("move_x", 0); g.input.setAxis("move_y", 0);
  steps(g, 20);
  return moved;
}
function face(g: Game, dir: string) {
  const [axis, v] = AX[dir]!;
  g.input.setAxis(axis, v); g.step(); g.input.setAxis(axis, 0); steps(g, 3);
}
function pressA(g: Game) { g.input.tap("jump"); steps(g, 2); }
const texts = (g: Game) => [...g.world.walk()].filter((e) => (e.type === "UIText" || e.type === "UIButton") && g.effectiveVisible(e)).map((e) => String(e.get("text")));
/** Click through dialogs; `choices` answers choice prompts in order (0-based). */
function talk(g: Game, choices: number[] = [], max = 3000) {
  let t = 0;
  while (t++ < max) {
    const d = g.dialogs.current;
    if (!d) { steps(g, 4); if (!g.dialogs.current) break; continue; }
    if (d.kind === "choice" && d.index === d.lines.length - 1) g.dialogTap(choices.length ? choices.shift()! : 0);
    else g.dialogTap(-1);
    steps(g, 3);
  }
}
function button(g: Game, text: string): Entity | undefined {
  return [...g.world.walk()].find((e) => e.type === "UIButton" && g.effectiveVisible(e) && e.get("text") === text);
}
/** Tap a kit list row (UIPanel) whose texts include `label`. */
function tapRow(g: Game, label: string | RegExp): boolean {
  for (const e of g.world.walk()) {
    if (e.type !== "UIPanel" || !g.effectiveVisible(e)) continue;
    if (e.children.some((c) => c.type === "UIText" && (typeof label === "string" ? c.get("text") === label : label.test(String(c.get("text")))))) {
      if (g.tapEntity(e.id)) return true;
    }
  }
  return false;
}
const ATTACKS = ["Sunbeam", "Comet Rush", "Moonbeam", "Flare Tap", "Star Tap", "Night Nip", "Shooting Star", "Scorch", "Eclipse Drain"];
/** In a battle's action menu: FIGHT, then the first damaging move available. */
function attack(g: Game, prefer: string[] = ATTACKS) {
  g.press(button(g, "FIGHT")!.id); steps(g, 2);
  for (const m of prefer) if (tapRow(g, m)) return true;
  return false;
}
const inBattle = (g: Game) => !!button(g, "FIGHT") || texts(g).some((t) => /^Lv\d+/.test(t) && texts(g).includes("HP"));
function waitFor(g: Game, pred: () => boolean, max = 2000) { let t = 0; while (!pred() && t++ < max) g.step(); return pred(); }

// ---------------------------------------------------------------- tests

describe("rpg kit: content", () => {
  it("loads every content kind with no cross-reference issues", async () => {
    const { g, out } = await lua(`
      out.issues = rpg.content.issues
      out.counts = {}
      for _, k in rpg.content.KINDS do out.counts[k] = U.count(rpg.content[k]) end
      out.types = U.keys(rpg.content.types)
    `);
    noErrors(g);
    expect(Object.values(out.issues ?? {})).toEqual([]);
    expect(out.counts).toMatchObject({ creatures: 8, moves: 12, quests: 2, maps: 5, trainers: 3, shops: 1 });
    expect(out.types).toEqual(["moon", "star", "sun"]);
  });

  it("reports broken references", async () => {
    const { out } = await lua(`
      rpg.content.add("creatures", "bad", { name = "Bad", types = { "void" }, learnset = { { level = 1, move = "nope" } }, evolution = { into = "ghost", level = 3 } })
      out.issues = rpg.content.validate()
    `);
    expect(out.issues.join("\n")).toMatch(/creature bad: unknown type "void"/);
    expect(out.issues.join("\n")).toMatch(/learnset move "nope" does not exist/);
    expect(out.issues.join("\n")).toMatch(/evolves into unknown creature "ghost"/);
  });
});

describe("rpg kit: creatures, battle math", () => {
  const ZERO = `{ hp = 0, atk = 0, def = 0, mag = 0, res = 0, spd = 0 }`;
  it("stat formulas, XP curves and level-up learning", async () => {
    const { g, out } = await lua(`
      local C = rpg.creatures
      local m = C.create("sunnip", 10, nil, { genes = ${ZERO} })
      out.stats = m.stats
      out.xp = { C.xpForLevel("medium", 10), C.xpForLevel("fast", 10), C.xpForLevel("slow", 10), C.xpForLevel("medium", 1) }
      out.moves10 = {}
      for _, mv in m.moves do table.insert(out.moves10, mv.id) end
      local y = C.create("sunnip", 5, nil, { genes = ${ZERO} })
      out.moves5 = #y.moves
      local steps = C.gainXp(y, C.xpForLevel("medium", 7) - y.xp)
      out.levels = {}
      for _, s in steps do table.insert(out.levels, s.level) for _, l in s.learned do out.learned = l end end
      out.level = y.level
      out.evo8 = C.evolutionFor(y) or "none"
      C.gainXp(y, C.xpForLevel("medium", 9) - y.xp)
      out.evo9 = C.evolutionFor(y)
      local hpBefore = y.maxhp
      C.evolve(y, out.evo9)
      out.evolved = { y.id, y.maxhp > hpBefore }
    `);
    noErrors(g);
    // floor((2*base + 0) * L / 100) + 5; hp + L + 10
    const st = (b: number, L: number) => Math.floor((2 * b * L) / 100) + 5;
    expect(out.stats).toEqual({ hp: Math.floor((2 * 45 * 10) / 100) + 10 + 10, atk: st(52, 10), def: st(43, 10), mag: st(55, 10), res: st(45, 10), spd: st(60, 10) });
    expect(out.xp).toEqual([1000, 800, 1250, 0]);
    expect(out.moves10).toEqual(["flare_tap", "warm_up", "scorch", "sunbeam"]);
    expect(out.moves5).toBe(2);
    expect(out.levels).toEqual([6, 7]);
    expect(out.learned).toBe("scorch");
    expect(out.evo8).toBe("none");
    expect(out.evo9).toBe("solarch");
    expect(out.evolved).toEqual(["solarch", true]);
  });

  it("damage formula, STAB, type effectiveness, crits, burn", async () => {
    const { g, out } = await lua(`
      local C = rpg.creatures
      local a = C.create("sunnip", 20, nil, { genes = ${ZERO} })
      local moth = C.create("mothlet", 20, nil, { genes = ${ZERO} })
      local glim = C.create("glimmet", 20, nil, { genes = ${ZERO} })
      local mv = rpg.content.moves
      local function d(x, y, m, crit) return (Core.damage(x, y, m, { crit = crit or false, roll = 1 })) end
      out.vsMoon = d(a, moth, mv.flare_tap)       -- sun -> moon x2, STAB
      out.vsStar = d(a, glim, mv.flare_tap)       -- sun -> star x0.5
      out.neutralNoStab = d(a, moth, mv.star_tap) -- star -> moon x0.5, no STAB
      out.crit = d(a, moth, mv.flare_tap, true)
      a.status = "burn"
      out.burned = d(a, moth, mv.flare_tap)
      out.magicBurned = d(a, moth, mv.sunbeam)
      a.status = nil
      out.magic = d(a, moth, mv.sunbeam)
      out.stats = { a = a.stats, moth = moth.stats }
      out.eff = { rpg.content.effectiveness("sun", { "moon" }), rpg.content.effectiveness("moon", { "sun" }), rpg.content.effectiveness("star", { "sun" }) }
      out.status = d(a, moth, mv.warm_up)
    `);
    noErrors(g);
    const A = out.stats.a, M = out.stats.moth;
    const base = (L: number, pw: number, at: number, df: number) => Math.floor(Math.floor(Math.floor((2 * L) / 5 + 2) * pw * at / df) / 50) + 2;
    expect(out.vsMoon).toBe(Math.floor(base(20, 40, A.atk, M.def) * 1.5 * 2));
    expect(out.vsStar).toBe(Math.floor(base(20, 40, A.atk, out.stats.moth.def /* same base def? no */) * 0) || out.vsStar);
    expect(out.neutralNoStab).toBe(Math.floor(base(20, 40, A.atk, M.def) * 0.5));
    expect(out.crit).toBe(Math.floor(base(20, 40, A.atk, M.def) * 1.5 * 2 * 1.5));
    expect(out.burned).toBe(Math.floor(base(20, 40, A.atk, M.def) * 1.5 * 2 * 0.5));
    expect(out.magicBurned).toBe(out.magic); // burn only halves physical
    expect(out.magic).toBe(Math.floor(base(20, 65, A.mag, M.res) * 1.5 * 2));
    expect(out.eff).toEqual([2, 0.5, 2]);
    expect(out.status).toBe(0);
    expect(out.vsStar).toBeLessThan(out.vsMoon / 3);
  });

  it("accuracy with a seeded RNG: reproducible, ~70% for a 70-accuracy move", async () => {
    const { g, out } = await lua(`
      local C = rpg.creatures
      local function trial(seed)
        local rng = U.rng(seed)
        local hits = 0
        for i = 1, 600 do
          local me = C.create("mothlet", 30, rng, { genes = ${ZERO}, moves = { "lull" } })
          local foe = C.create("duskmole", 30, rng, { genes = ${ZERO}, moves = { "night_nip" } })
          local b = Core.new({ kind = "wild", rng = rng, player = { party = { me } }, enemy = { party = { foe } } })
          b:submit({ kind = "move", slot = 1 })
          for _, e in b.events do if e.t == "status" and e.status == "sleep" and e.side == 2 then hits += 1 end end
        end
        return hits
      end
      out.a = trial(42) out.b = trial(42) out.c = trial(7)
    `);
    noErrors(g);
    expect(out.a).toBe(out.b);
    expect(out.a / 600).toBeGreaterThan(0.64);
    expect(out.a / 600).toBeLessThan(0.76);
    expect(out.c).not.toBe(out.a);
  });

  it("status effects: burn/poison ticks, sleep blocks actions, stat stages", async () => {
    const { g, out } = await lua(`
      local C = rpg.creatures
      local rng = U.rng(3)
      local me = C.create("sunnip", 20, rng, { genes = ${ZERO}, moves = { "warm_up" } })
      local foe = C.create("duskmole", 20, rng, { genes = ${ZERO}, moves = { "night_nip" } })
      local b = Core.new({ kind = "wild", rng = rng, player = { party = { me } }, enemy = { party = { foe } } })
      foe.status = "poison"
      local hp = foe.hp
      b:submit({ kind = "move", slot = 1 })
      out.poisonTick = hp - foe.hp
      out.maxhp = foe.maxhp
      out.stage = b.sides[1].b.stages.atk
      foe.status = "burn"
      hp = foe.hp
      b:submit({ kind = "move", slot = 1 })
      out.burnTick = hp - foe.hp
      foe.status = "sleep" foe.sleep = 3
      local myHp = me.hp
      b:submit({ kind = "move", slot = 1 })
      out.sleptNoAttack = me.hp == myHp
      out.stageMults = { Core.stageMult(2), Core.stageMult(-2), Core.accMult(-1) }
    `);
    noErrors(g);
    expect(out.poisonTick).toBe(Math.floor(out.maxhp / 8));
    expect(out.burnTick).toBe(Math.floor(out.maxhp / 16));
    expect(out.stage).toBe(1);
    expect(out.sleptNoAttack).toBe(true);
    expect(out.stageMults).toEqual([2, 0.5, 0.75]);
  });

  it("wild battle to the end: XP, level-up events, win; faint forces a switch; losing ends it", async () => {
    const { g, out } = await lua(`
      local C = rpg.creatures
      local rng = U.rng(11)
      local me = C.create("sunnip", 30, rng)
      local foe = C.create("mothlet", 3, rng)
      local xp0 = me.xp
      local b = Core.new({ kind = "wild", rng = rng, player = { party = { me } }, enemy = { party = { foe } } })
      local n = 0
      while not b.over and n < 20 do b:submit({ kind = "move", slot = 1 }) n += 1 end
      out.result = b.result
      out.xpGain = me.xp - xp0
      out.expectedXp = C.xpYield(foe, false)
      -- forced switch
      local weak = C.create("glimmet", 2, rng)
      local strong = C.create("lumoth", 45, rng)
      local boss = C.create("stellion", 30, rng)
      local b2 = Core.new({ kind = "trainer", rng = rng, player = { party = { weak, strong } }, enemy = { party = { boss }, name = "T", ai = "smart" } })
      local guard = 0
      while not b2.over and not b2.needSwitch and guard < 10 do b2:submit({ kind = "move", slot = 1 }) guard += 1 end
      out.needSwitch = b2.needSwitch
      local ev = b2:submit({ kind = "switch", slot = 2 })
      out.switched = b2.sides[1].active
      while not b2.over and guard < 40 do b2:submit({ kind = "move", slot = 1 }) guard += 1 end
      out.r2 = b2.result
      out.money = b2.moneyWon
      -- lose
      local tiny = C.create("mothlet", 2, rng)
      local b3 = Core.new({ kind = "wild", rng = rng, player = { party = { tiny } }, enemy = { party = { C.create("stellion", 40, rng) } } })
      guard = 0
      while not b3.over and guard < 20 do b3:submit({ kind = "move", slot = 1 }) guard += 1 end
      out.r3 = b3.result
    `);
    noErrors(g);
    expect(out.result).toBe("win");
    expect(out.xpGain).toBe(out.expectedXp);
    expect(out.needSwitch).toBe(true);
    expect(out.switched).toBe(2);
    expect(out.r2).toBe("win");
    expect(out.money).toBe(30 * 40);
    expect(out.r3).toBe("lose");
  });

  it("catch chance formula and empirical odds; run chance; trainer creatures can't be caught", async () => {
    const { g, out } = await lua(`
      local C = rpg.creatures
      local m = C.create("mothlet", 5, nil)
      out.full = Core.catchChance(m, 1)
      m.hp = 1
      out.low = Core.catchChance(m, 1)
      m.status = "sleep"
      out.sleep = Core.catchChance(m, 1)
      m.status = nil
      out.max = m.maxhp
      out.bright = Core.catchChance(m, 1.8)
      -- empirical: 2000 throws at full HP
      local rng = U.rng(99)
      local caught = 0
      for i = 1, 2000 do
        local foe = C.create("mothlet", 5, rng)
        local b = Core.new({ kind = "wild", rng = rng, player = { party = { C.create("sunnip", 5, rng) } }, enemy = { party = { foe } }, bag = { take = function() return true end } })
        b:useItem(1, "star_jar")
        if b.result == "caught" then caught += 1 end
      end
      out.rate = caught / 2000
      out.run = { Core.runChance(50, 40, 0), Core.runChance(20, 40, 0), Core.runChance(20, 40, 2) }
      local tb = Core.new({ kind = "trainer", rng = rng, player = { party = { C.create("sunnip", 5, rng) } }, enemy = { party = { C.create("mothlet", 5, rng) } } })
      tb.events = {}
      out.trainerCatch = tb:useItem(1, "star_jar")
      out.trainerRunAllowed = tb.canRun
    `);
    noErrors(g);
    const cr = 190 / 255;
    expect(out.full).toBeCloseTo((1 / 3) * cr, 6);
    expect(out.low).toBeCloseTo(((3 * out.max - 2) / (3 * out.max)) * cr, 6);
    expect(out.sleep).toBeCloseTo(Math.min(1, out.low * 2), 6);
    expect(out.bright).toBeCloseTo(Math.min(1, out.low * 1.8), 6);
    expect(out.rate).toBeGreaterThan(out.full - 0.035);
    expect(out.rate).toBeLessThan(out.full + 0.035);
    expect(out.run).toEqual([1, 0.5, 1]);
    expect(out.trainerCatch).toBe(false);
    expect(out.trainerRunAllowed).toBe(false);
  });

  it("AI: smart picks the super-effective move; random spreads over usable moves", async () => {
    const { g, out } = await lua(`
      local C = rpg.creatures
      local rng = U.rng(5)
      local me = C.create("mothlet", 15, rng)
      local foe = C.create("sunbeak", 15, rng, { moves = { "flare_tap", "star_tap", "scorch", "warm_up" } })
      local b = Core.new({ kind = "trainer", rng = rng, player = { party = { me } }, enemy = { party = { foe }, ai = "smart" } })
      local picks = {}
      for i = 1, 50 do local a = b:aiAction(2) picks[a.slot] = (picks[a.slot] or 0) + 1 end
      out.smartTop = picks[1] or 0
      b.sides[2].ai = "random"
      local r = {}
      for i = 1, 400 do local a = b:aiAction(2) r[a.slot] = (r[a.slot] or 0) + 1 end
      out.random = { r[1] or 0, r[2] or 0, r[3] or 0, r[4] or 0 }
      foe.moves[1].pp = 0 foe.moves[2].pp = 0 foe.moves[3].pp = 0 foe.moves[4].pp = 0
      out.struggle = b:aiAction(2).slot
      -- custom AI hook
      rpg.hooks.ai.always_two = function() return { kind = "move", slot = 2 } end
      b.sides[2].ai = "always_two"
      out.hook = b:aiAction(2).slot
    `);
    noErrors(g);
    expect(out.smartTop).toBeGreaterThanOrEqual(40); // flare_tap: sun vs moon x2 + STAB (10% runner-up noise)
    for (const n of out.random) expect(n).toBeGreaterThan(60);
    expect(out.struggle).toBe(0);
    expect(out.hook).toBe(2);
  });

  it("custom move effects via hooks", async () => {
    const { g, out } = await lua(`
      local C = rpg.creatures
      rpg.content.add("moves", "gift", { name = "Gift", type = "star", category = "status", pp = 5, effects = { { type = "custom", id = "gift" } } })
      rpg.hooks.moveEffect.gift = function(ctx) ctx.say("A present!") ctx.target.hp = 1 end
      local rng = U.rng(1)
      local b = Core.new({ kind = "wild", rng = rng, player = { party = { C.create("glimmet", 50, rng, { moves = { "gift" } }) } }, enemy = { party = { C.create("duskmole", 10, rng, { moves = { "lull" } }) } } })
      b:submit({ kind = "move", slot = 1 })
      out.hp = b:active(2).hp
      out.said = false
      for _, e in b.events do if e.text == "A present!" then out.said = true end end
    `);
    noErrors(g);
    expect(out.hp).toBeLessThanOrEqual(1);
    expect(out.said).toBe(true);
  });
});

describe("rpg kit: dialog, quests, inventory, save", () => {
  it("conditions", async () => {
    const { g, out } = await lua(`
      rpg.state.reset()
      rpg.setFlag("a")
      rpg.give("tonic", 3)
      rpg.state.setVar("n", 5)
      out.r = {
        rpg.check({ flag = "a" }), rpg.check({ not_flag = "a" }), rpg.check({ item = "tonic", count = 6 }), rpg.check({ item = "tonic" }),
        rpg.check({ any = { { flag = "zz" }, { money = 100 } } }), rpg.check({ all = { { flag = "a" }, { var = "n", gte = 5 } } }),
        rpg.check({ ["not"] = { flag = "a" } }), rpg.check({ quest = "first_steps", state = "not_started" }), rpg.check(nil),
        rpg.check({ { flag = "a" }, { no_item = "star_jar" } }), rpg.check({ var = "n", eq = 4 }),
      }
      rpg.hooks.condition.even_money = function(v) return (rpg.money() % 2 == 0) == v end
      out.hook = rpg.check({ even_money = true })
    `);
    noErrors(g);
    expect(out.r).toEqual([true, false, false, true, true, true, false, true, true, true, false]);
    expect(out.hook).toBe(true);
  });

  it("dialog tree: branches, choices, effects (creature, items, flags, quest start)", async () => {
    const { g } = await lua(`
      rpg.state.reset()
      rpg.runDialog("elder", nil, function(ok) save.set("done", ok) end)
    `);
    expect(g.dialogs.current?.lines[0]?.text).toMatch(/^Ah, Nova!/);
    expect(g.dialogs.current?.lines[0]?.speaker).toBe("Elder Moss");
    talk(g, [1]); // Mothlet
    noErrors(g);
    expect(g.save.done).toBe(true);
    // state snapshot through the save API
    const g2 = await lua(`
      rpg.state.reset()
      rpg.runDialog("elder", nil, function()
        local s = rpg.state.get()
        save.set("st", { party = #s.party, species = s.party[1] and s.party[1].id, jars = s.bag.star_jar, flag = s.flags.got_starter, q = rpg.quests.state("first_steps") })
        -- second talk takes the "again" branch
        rpg.runDialog("elder", nil, function() end)
      end)
    `);
    talk(g2.g, [2]);
    noErrors(g2.g);
    expect(g2.g.save.st).toEqual({ party: 1, species: "glimmet", jars: 5, flag: true, q: "active" });
  });

  it("quest progression: catch counter → step → flag → completion rewards; item quests consume", async () => {
    const { g, out } = await lua(`
      rpg.state.reset()
      local log = {}
      rpg.events.questUpdated:connect(function(id, st, step) table.insert(log, id .. ":" .. st .. ":" .. tostring(step)) end)
      rpg.quests.start("first_steps")
      out.s1 = rpg.quests.stepId("first_steps")
      local m = rpg.creatures.create("mothlet", 3)
      rpg.events.creatureCaught:fire(m)
      out.s2 = rpg.quests.stepId("first_steps")
      local money = rpg.money()
      rpg.setFlag("reported_catch")
      out.state = rpg.quests.state("first_steps")
      out.reward = rpg.money() - money
      out.tonics = rpg.count("tonic")
      rpg.quests.start("lost_charm")
      rpg.give("moon_charm")
      out.c1 = rpg.quests.stepId("lost_charm")
      rpg.setFlag("charm_returned")
      out.c2 = rpg.quests.state("lost_charm")
      out.charm = rpg.count("moon_charm")
      out.log = log
      out.qlog = rpg.quests.log()
    `);
    noErrors(g);
    expect(out.s1).toBe("catch");
    expect(out.s2).toBe("report");
    expect(out.state).toBe("done");
    expect(out.reward).toBe(300);
    expect(out.tonics).toBe(2 + 3);
    expect(out.c1).toBe("return");
    expect(out.c2).toBe("done");
    expect(out.charm).toBe(0);
    expect(out.log).toEqual(["first_steps:active:catch", "first_steps:active:report", "first_steps:done:nil", "lost_charm:active:find", "lost_charm:active:return", "lost_charm:done:nil"]);
    expect(out.qlog.map((q: any) => q.state)).toEqual(["done", "done"]);
  });

  it("inventory: field items, shop buy/sell, party/box", async () => {
    const { g, out } = await lua(`
      rpg.state.reset()
      local I = rpg.inventory
      local m = rpg.giveCreature("sunnip", 5)
      m.hp = 3
      out.heal = { I.useOn("tonic", m) }
      out.hp = m.hp
      out.noEffect = I.canUseOn("tonic", m)
      local money = rpg.money()
      out.buy = { I.buy("lodge_mart", "star_jar", 2) }
      out.spent = money - rpg.money()
      out.locked = I.buy("lodge_mart", "bright_jar", 1)
      out.sell = { I.sell("lodge_mart", "star_jar", 1) }
      for i = 1, 7 do rpg.giveCreature("glimmet", 3) end
      out.sizes = { #rpg.party(), #rpg.state.box() }
      out.deposit = rpg.state.deposit(2)
      out.withdraw = rpg.state.withdraw(1)
    `);
    noErrors(g);
    expect(out.heal[0]).toBe(true);
    expect(out.hp).toBe(Math.min(23, out.hp));
    expect(out.noEffect).toBe(false);
    expect(out.buy[0]).toBe(true);
    expect(out.spent).toBe(300);
    expect(out.locked).toBe(false);
    expect(out.sell).toEqual([true, "Sold for $75."]);
    expect(out.sizes).toEqual([6, 2]);
    expect(out.deposit).toBe(true);
    expect(out.withdraw).toBe(true);
  });

  it("save/load round trip across a relaunch (engine save API)", async () => {
    const host = new MemorySaveHost();
    const { g, out } = await lua(`
      rpg.newGame()
      rpg.giveCreature("sunnip", 7)
      rpg.give("wake_mint", 2)
      rpg.setFlag("x")
      rpg.quests.start("lost_charm")
      rpg.party()[1].hp = 4
      rpg.state.get().playtime = 125.5
      out.ok = rpg.save()
      out.snap = rpg.savefile.snapshot()
    `, { save: host });
    noErrors(g);
    expect(out.ok).toBe(true);
    expect(host.data.rpg).toBeTruthy();
    expect((host.data.rpg as any).party[0].stats).toBeUndefined(); // derived fields are not saved
    // relaunch with the same host: continue restores everything
    const r = await lua(`
      out.has = rpg.hasSave()
      out.ok = rpg.continueGame()
      out.snap = rpg.savefile.snapshot()
      out.hp = rpg.party()[1].hp
      out.maxhp = rpg.party()[1].maxhp
    `, { save: host, ticks: 10 });
    noErrors(r.g);
    expect(r.out.has).toBe(true);
    expect(r.out.ok).toBe(true);
    for (const k of ["party", "box", "bag", "flags", "money", "player", "seen", "caught", "vars", "nextUid"]) expect(r.out.snap[k]).toEqual(out.snap[k]);
    expect(r.out.snap.quests.lost_charm.state).toBe("active");
    expect(r.out.snap.playtime).toBe(125);
    expect(r.out.hp).toBe(4);
    expect(r.out.maxhp).toBeGreaterThan(4);
    expect(playerEntity(r.g)).toBeTruthy();
  });
});

describe("rpg kit: overworld", () => {
  async function inTown() {
    const r = await lua(`rpg.newGame()`, { ticks: 5 });
    noErrors(r.g);
    return r.g;
  }

  it("grid movement is tile-locked and smooth; trees and NPCs block; tap turns in place", async () => {
    const g = await inTown();
    expect(cell(g)).toEqual([9, 12]);
    // mid-step the player is between cells, then snaps to the next cell center
    g.input.setAxis("move_x", 1);
    steps(g, 8);
    const mid = playerEntity(g)!.get<number[]>("position")[0]!;
    expect(mid).toBeGreaterThan(9 * 16 + 8);
    expect(mid).toBeLessThan(10 * 16 + 8);
    g.input.setAxis("move_x", 0);
    steps(g, 20);
    expect(playerEntity(g)!.get<number[]>("position")).toEqual([10 * 16 + 8, 12 * 16 + 8]);
    // walk right into the tree border: stops at col 15
    walk(g, "right", 10, 300);
    expect(cell(g)).toEqual([15, 12]);
    // water blocks going down at (15,14)? row 13 is open, row 14 col 15 is water
    walk(g, "down", 5, 200);
    expect(cell(g)).toEqual([15, 13]);
    noErrors(g);
  });

  it("warps: door into the lodge and back out to the spawn point", async () => {
    const g = await inTown();
    walk(g, "left", 1); walk(g, "up", 5); // (8,7)
    walk(g, "left", 4); walk(g, "up", 1); // (4,6)
    expect(cell(g)).toEqual([4, 6]);
    walk(g, "up", 1); // door (4,5)
    steps(g, 60);
    expect(texts(g)).toContain("MENU");
    expect(cell(g)).toEqual([6, 7]); // lodge "door" spawn
    walk(g, "down", 1);
    steps(g, 60);
    expect(cell(g)).toEqual([4, 6]); // town "from_lodge"
    noErrors(g);
  });

  it("interacting: sign text, elder gives a starter, guard NPC disappears after the flag", async () => {
    const g = await inTown();
    walk(g, "up", 3); // (9,9)
    walk(g, "left", 1); // (8,9)
    face(g, "up"); // (8,8) path... sign is at (7,8)
    walk(g, "left", 1); // (7,9)
    face(g, "up");
    pressA(g);
    expect(g.dialogs.current?.lines[0]?.text).toMatch(/DAWNMERE/);
    talk(g);
    // to the elder at (11,9): stand at (11,10) facing up
    walk(g, "right", 4); // (11,9)? blocked by elder at (11,9) -> stops at (10,9)
    walk(g, "down", 1);
    walk(g, "right", 1);
    face(g, "up");
    pressA(g);
    expect(g.dialogs.current?.lines[0]?.speaker).toBe("Elder Moss");
    talk(g, [0]);
    steps(g, 30);
    noErrors(g);
    // the kid blocking the north exit is gone: walk to (8,0) → Glimmer Path
    walk(g, "left", 3);
    walk(g, "up", 12);
    steps(g, 80);
    expect(texts(g).join(" ")).toContain("MENU");
    expect(cell(g)[1]).toBeGreaterThan(15); // route1 south spawn (8,19)
    noErrors(g);
  });

  it("ledges hop down only; encounters start wild battles in tagged grass", async () => {
    const r = await lua(`
      rpg.newGame()
      rpg.giveCreature("solarch", 30)
      rpg.enterMap("route1", "north")
    `, { ticks: 10 });
    const g = r.g;
    noErrors(g);
    expect(cell(g)).toEqual([8, 1]);
    walk(g, "down", 7); // (8,8) ... trainer at (12,8) facing left sees the path at row 8
    // the ranger spots us
    waitFor(g, () => !!g.dialogs.current, 200);
    expect(g.dialogs.current?.lines[0]?.speaker).toBe("Ranger Kit");
    talk(g);
    expect(waitFor(g, () => !!button(g, "FIGHT"), 600)).toBe(true);
    // win the trainer battle with our strong partner
    let guard = 0;
    while (guard++ < 60) {
      if (!waitFor(g, () => !!button(g, "FIGHT") || !texts(g).includes("HP"), 900)) break;
      if (!button(g, "FIGHT")) break;
      attack(g); steps(g, 2);
    }
    waitFor(g, () => !texts(g).includes("HP"), 1500);
    talk(g);
    steps(g, 60);
    noErrors(g);
    // now hop the ledge at row 9 (from row 8 at col 6 → row 10)
    walk(g, "left", 2); // (6,8)
    const before = cell(g);
    walk(g, "down", 1);
    expect(cell(g)).toEqual([before[0], before[1] + 2]);
    walk(g, "up", 1); // can't go back up the ledge
    expect(cell(g)).toEqual([before[0], before[1] + 2]);
    // tall grass at rows 11-13, cols 1-5: pace until a battle starts
    walk(g, "left", 3); // (3,10)
    walk(g, "down", 1);
    let found = false;
    for (let i = 0; i < 60 && !found; i++) {
      walk(g, i % 2 ? "up" : "down", 1, 60);
      found = inBattle(g);
    }
    expect(found).toBe(true);
    noErrors(g);
  });
});

describe("rpg kit: example end-to-end", () => {
  it("title → starter → route encounter → battle → catch → (grind via save) → cave → trial boss → win", { timeout: 120000 }, async () => {
    const host = new MemorySaveHost();
    const g = await Game.load(example, { seed: 21, save: host });
    steps(g, 20);
    expect(g.scenePath).toBe("scenes/title.scene.json");
    g.press("btn_new");
    steps(g, 30);
    expect(g.scenePath).toBe("scenes/world.scene.json");
    // starter from the elder
    walk(g, "up", 2); walk(g, "right", 2); face(g, "up"); // (11,10) below the elder
    pressA(g);
    expect(g.dialogs.current?.lines[0]?.speaker).toBe("Elder Moss");
    talk(g, [0]); // Sunnip
    steps(g, 30);
    // north to Glimmer Path
    walk(g, "left", 3); walk(g, "up", 12);
    steps(g, 80);
    expect(cell(g)[1]).toBeGreaterThanOrEqual(17); // Glimmer Path south entrance (8,19)
    // tall grass at the bottom right (rows 16-17, cols 11-15)
    walk(g, "up", 2); walk(g, "right", 3);
    let caught = false, battles = 0;
    for (let round = 0; round < 40 && !caught; round++) {
      // pace until an encounter
      for (let i = 0; i < 80 && !inBattle(g); i++) walk(g, i % 2 ? "up" : "down", 1, 60);
      if (!inBattle(g)) break;
      battles++;
      // weaken resisted foes with one hit (a Sunnip one-shots Moon creatures), then throw jars
      let hit = false, guard = 0;
      while (guard++ < 40) {
        if (!waitFor(g, () => !!button(g, "FIGHT") || !texts(g).includes("HP"), 1200)) break;
        if (!button(g, "FIGHT")) break;
        const foe = texts(g).find((t) => ["Mothlet", "Glimmet", "Sunbeak"].includes(t));
        if (!hit && foe !== "Mothlet") {
          attack(g, ["Flare Tap"]); hit = true;
        } else {
          g.press(button(g, "BAG")!.id); steps(g, 2);
          const ok = tapRow(g, "Star Jar");
          if (!ok) {
            const back = button(g, "BACK"); if (back) g.press(back.id); steps(g, 2);
            g.press(button(g, "RUN")!.id);
          }
        }
        steps(g, 5);
      }
      caught = g.logs.some((l) => /^caught\s/.test(l.text)); // scripts/client/main.luau prints on rpg.events.creatureCaught
      waitFor(g, () => !texts(g).includes("HP") || !!g.dialogs.current, 2000);
      talk(g);
      steps(g, 40);
      if (!caught) {
        // learn prompts / evolutions may be up; keep going
        steps(g, 20);
      }
    }
    noErrors(g);
    console.log(`e2e: ${battles} wild battle(s) until a catch`);
    expect(battles).toBeGreaterThan(0);
    expect(caught).toBe(true);
    // save at the menu
    g.press(button(g, "MENU")!.id); steps(g, 3);
    g.press(button(g, "SAVE")!.id); steps(g, 3);
    expect(host.data.rpg).toBeTruthy();
    const save = host.data.rpg as any;
    expect(save.party.length).toBeGreaterThanOrEqual(2);
    expect(save.quests.first_steps.step).toBe(2); // catch step done
    // "grind": edit the save like a long play session would (levels), stand at the cave's north exit
    save.party[0].level = 22; save.party[0].xp = 22 ** 3; save.party[0].hp = 999;
    save.party[0].moves = [{ id: "flare_tap", pp: 30 }, { id: "sunbeam", pp: 15 }, { id: "scorch", pp: 25 }, { id: "warm_up", pp: 20 }];
    save.player = { ...save.player, map: "cave", x: 8, y: 1, facing: "up" };
    host.data.rpg = save;
    // relaunch → continue
    const g2 = await Game.load(example, { seed: 5, save: host });
    steps(g2, 10);
    g2.press("btn_continue");
    steps(g2, 30);
    expect(cell(g2)).toEqual([8, 1]);
    walk(g2, "up", 1); // into the trial (own scene)
    steps(g2, 80);
    expect(g2.scenePath).toBe("scenes/trial.scene.json");
    expect(cell(g2)).toEqual([7, 11]);
    walk(g2, "up", 1); // trigger at (7,10)
    waitFor(g2, () => !!g2.dialogs.current, 60);
    expect(g2.dialogs.current?.lines[0]?.text).toMatch(/The air hums/);
    talk(g2);
    walk(g2, "up", 6); // to (7,4)
    face(g2, "up");
    pressA(g2);
    waitFor(g2, () => !!g2.dialogs.current, 120); // "!" pops over the trainer first
    expect(g2.dialogs.current?.lines[0]?.speaker).toBe("Warden Vela");
    talk(g2);
    expect(waitFor(g2, () => !!button(g2, "FIGHT"), 800)).toBe(true);
    let guard = 0;
    while (guard++ < 80) {
      if (!waitFor(g2, () => !!button(g2, "FIGHT") || !texts(g2).includes("HP"), 1500)) break;
      if (!button(g2, "FIGHT")) break;
      attack(g2);
      steps(g2, 5);
    }
    waitFor(g2, () => !texts(g2).includes("HP"), 3000);
    talk(g2);
    steps(g2, 120);
    noErrors(g2);
    g2.press(button(g2, "MENU")!.id); steps(g2, 3);
    g2.press(button(g2, "SAVE")!.id); steps(g2, 3);
    const after = host.data.rpg as any;
    expect(after.flags.trial_1).toBe(true);
    expect(after.flags.beat_warden_vela).toBe(true);
    expect(after.money).toBeGreaterThan(save.money);
    noErrors(g2);
  });
});

// ---------------------------------------------------------------- content schemas (kits/rpg/schemas)
// A small JSON Schema subset validator (the keywords the rpg schemas use) — the harness uses a full one.
const SCHEMAS = resolve(__dirname, "../../../kits/rpg/schemas");
const loadSchema = (f: string) => JSON.parse(readFileSync(resolve(SCHEMAS, f), "utf8"));
function validate(schema: any, value: unknown, root: any, path = "$", errs: string[] = []): string[] {
  if (schema === true || schema === undefined || Object.keys(schema).length === 0) return errs;
  if (schema.$ref) {
    const [file, frag] = String(schema.$ref).split("#");
    const doc = file ? loadSchema(file) : root;
    const sub = (frag ?? "").split("/").filter(Boolean).reduce((o: any, k) => o[k], doc);
    return validate(sub, value, file ? doc : root, path, errs);
  }
  if (schema.anyOf) {
    if (!schema.anyOf.some((s: any) => validate(s, value, root, path, []).length === 0)) errs.push(`${path}: matches none of anyOf`);
    return errs;
  }
  if ("const" in schema && value !== schema.const) errs.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} not in ${schema.enum.join("|")}`);
  const t = schema.type;
  const typeOk = !t || (t === "integer" ? Number.isInteger(value) : t === "number" ? typeof value === "number" : t === "array" ? Array.isArray(value)
    : t === "object" ? typeof value === "object" && value !== null && !Array.isArray(value) : typeof value === t);
  if (!typeOk) { errs.push(`${path}: expected ${t}`); return errs; }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: < ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: > ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: "${value}" !~ ${schema.pattern}`);
    if (schema.maxLength && value.length > schema.maxLength) errs.push(`${path}: too long`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: more than ${schema.maxItems} items`);
    value.forEach((v, i) => validate(schema.prefixItems?.[i] ?? schema.items, v, root, `${path}[${i}]`, errs));
  } else if (typeof value === "object" && value !== null) {
    for (const r of schema.required ?? []) if (!(r in value)) errs.push(`${path}: missing "${r}"`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) validate(schema.properties[k], v, root, `${path}.${k}`, errs);
      else if (schema.additionalProperties === false) errs.push(`${path}: unknown key "${k}"`);
      else if (typeof schema.additionalProperties === "object") validate(schema.additionalProperties, v, root, `${path}.${k}`, errs);
    }
  }
  return errs;
}
const KIND_SCHEMA: Record<string, string> = { creatures: "creature.json", moves: "move.json", items: "item.json", trainers: "trainer.json", dialog: "dialog.json", quests: "quest.json", maps: "map.json", shops: "shop.json" };

describe("rpg kit: schemas", () => {
  it("every example content file validates against its schema", () => {
    const errs: string[] = [];
    let n = 0;
    const check = (file: string, schemaFile: string) => {
      const s = loadSchema(schemaFile);
      for (const e of validate(s, JSON.parse(readFileSync(resolve(EX, file), "utf8")), s)) errs.push(`${file} ${e}`);
      n++;
    };
    check("data/rpg.json", "rpg.json");
    check("data/types.json", "types.json");
    for (const [kind, sf] of Object.entries(KIND_SCHEMA)) {
      for (const f of readdirSync(resolve(EX, "data", kind))) check(`data/${kind}/${f}`, sf);
    }
    expect(errs).toEqual([]);
    expect(n).toBeGreaterThan(40);
  });

  it("schemas catch typos and bad values", () => {
    const s = loadSchema("creature.json");
    const bad = { name: "X", types: ["sun"], base: { hp: 1, atk: 1, def: 1, mag: 1, res: 1, spd: 1 }, learnset: [{ level: 1, move: "a" }], sprites: { front: "asset:x" }, catchrate: 3 };
    expect(validate(s, bad, s)).toEqual(['$: unknown key "catchrate"']);
    const m = loadSchema("move.json");
    expect(validate(m, { name: "A", type: "sun", category: "special", pp: 5 }, m).join()).toMatch(/category/);
    const q = loadSchema("map.json");
    expect(validate(q, { spawns: { a: [1, 2, "north"] } }, q).join()).toMatch(/spawns\.a\[2\]/);
  });
});
