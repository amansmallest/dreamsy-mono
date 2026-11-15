// deckbuilder kit: effect language, piles/shuffle determinism, intents, statuses, energy/X-cost, rewards,
// map connectivity, a full seeded bot run, the balance sim and the example package end-to-end.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Package } from "@dreamsy/format";
import { Game, MemorySaveHost } from "../../core/index.js";
import { simulate } from "../../tools/playtest.js";

const EXAMPLE = resolve(__dirname, "../../../games/examples/kit-deckbuilder");

function exampleFiles(): Record<string, Uint8Array | string> {
  const files: Record<string, Uint8Array | string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(EXAMPLE, p).split("\\").join("/")] = readFileSync(p);
    }
  };
  walk(EXAMPLE);
  return files;
}

const scene = JSON.stringify({ format: "0", root: "root", entities: { root: { type: "Node2D" } } });

/** Runs a Luau body with the example's data/ files (no scripts) and the kit set up. `out` is saved and returned. */
async function lua(body: string, opts: { budgetMs?: number } = {}) {
  const files = exampleFiles();
  for (const p of Object.keys(files)) if (/^scripts\//.test(p)) delete files[p];
  files["scenes/main.scene.json"] = scene;
  files["dreamsy.toml"] = `format = "0"\nname = "db test"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/main.scene.json"\nkits = ["deckbuilder"]\n[style]\npreset = "clean"\n`;
  files["scripts/client/main.luau"] = `
local DB = require("@kit/deckbuilder")
local C = DB.setup({ events = false })
local E, Battle, Run, Map, Bot = DB.effects, DB.Battle, DB.Run, DB.Map, DB.bot
local out = {}
local function battle(o)
  o = o or {}
  local deck = {}
  for _, id in o.deck or { "jab" } do table.insert(deck, { id = id }) end
  local b = Battle.new({ C = C, seed = o.seed or 1, deck = deck, enemies = o.enemies or { "bilge_rat" },
    player = { hp = o.hp or 50, energy = o.energy or 3, draw = o.draw or 5 }, relics = o.relics })
  return b
end
${body}
save.set("out", out)
`;
  const host = new MemorySaveHost();
  const g = await Game.load(Package.fromFiles(files), { seed: 1, save: host, budgetMs: opts.budgetMs ?? 20000 } as any);
  g.step();
  const errors = g.errors.map((e) => `${e.script}:${e.line ?? "?"}: ${e.message}`);
  const logs = g.logs.map((l) => l.text);
  if (errors.length) console.log(errors);
  expect(errors).toEqual([]);
  return { out: host.data.out as any, logs };
}

describe("deckbuilder kit: effects + battle", () => {
  it("every effect verb works and auto text is generated", async () => {
    const { out } = await lua(`
      local b = battle({ deck = { "jab", "jab", "jab", "jab", "jab", "brace", "brace", "brace" }, enemies = { "brass_crab", "bilge_rat" } }):start()
      local e1, e2 = b.enemies[1], b.enemies[2]
      local p = b.player
      local function run(list, tgt, x) E.run(list, { b = b, src = p, tgt = tgt, x = x }) end
      e1.hp, e1.maxHp, e2.hp, e2.maxHp = 100, 100, 100, 100
      run({ "damage 6" }, e1) out.dmg = 100 - e1.hp
      run({ "damage 2 x3" }, e1) out.hits = 94 - e1.hp
      run({ "damage 5 all" }) out.all = { e1.hp, e2.hp }
      run({ "block 7" }) out.block = p.block
      local h = #b.hand run({ "draw 2" }) out.draw = #b.hand - h
      local en = b.energy run({ "energy 2" }) out.energy = b.energy - en
      p.hp = 30 run({ "heal 5" }) out.heal = p.hp
      run({ "lose_hp 3" }) out.lose = p.hp
      run({ "apply vulnerable 2" }, e1) out.vuln = e1.statuses.vulnerable
      run({ "apply weak 1 all" }) out.weakAll = { e1.statuses.weak, e2.statuses.weak }
      run({ "apply strength 2 self" }) out.str = p.statuses.strength
      run({ "double strength self" }) out.dbl = p.statuses.strength
      run({ "remove strength" }) out.removed = p.statuses.strength == nil
      h = #b.hand run({ "discard 1" }) out.discard = h - #b.hand
      h = #b.hand run({ "exhaust 1" }) out.exhaust = #b.exhausted
      run({ "add ash hand 2" }) local ash = 0 for _, c in b.hand do if c.id == "ash" then ash += 1 end end out.add = ash
      run({ "add jab hand" }) run({ "upgrade hand" }) local up = 0 for _, c in b.hand do if c.up then up += 1 end end out.upgraded = up > 0
      e1.hp = 100 run({ "damage X" }, e1, 3) out.x = 100 - e1.hp
      e1.hp = 100 run({ "damage 2 xX+1" }, e1, 2) out.xhits = 100 - e1.hp
      p.block = 9 e1.hp = 100 e1.statuses = {} run({ "damage $block" }, e1) out.var = 100 - e1.hp
      e1.hp = 5 local ctx = { b = b, src = p, tgt = e1 } E.run({ "damage 9", "if killed then energy 1" }, ctx) out.killed = ctx.killed == true
      e2.hp = 100 e2.statuses = {} E.run({ "if target.hp < 50% then damage 10" }, { b = b, src = p, tgt = e2 }) out.condNo = e2.hp
      e2.hp = 40 E.run({ "if target.hp < 50% then damage 10" }, { b = b, src = p, tgt = e2 }) out.condYes = e2.hp
      out.text = DB.card("flare").text
      out.textUp = DB.card("flare", true).text
      out.wild = DB.card("wildfire", true).text
      out.bad = pcall(E.parse, "explode 3") == false
    `);
    expect(out.dmg).toBe(6);
    expect(out.hits).toBe(6);
    expect(out.all).toEqual([83, 95]);
    expect(out.block).toBe(7);
    expect(out.draw).toBe(2);
    expect(out.energy).toBe(2);
    expect(out.heal).toBe(35);
    expect(out.lose).toBe(32);
    expect(out.vuln).toBe(2);
    expect(out.weakAll).toEqual([1, 1]);
    expect(out.str).toBe(2);
    expect(out.dbl).toBe(4);
    expect(out.removed).toBe(true);
    expect(out.discard).toBe(1);
    expect(out.exhaust).toBe(1);
    expect(out.add).toBe(2);
    expect(out.upgraded).toBe(true);
    expect(out.x).toBe(4); // 3 * vulnerable 1.5 = 4.5 -> 4
    expect(out.xhits).toBe(9); // 2 * 1.5 = 3 per hit, 3 hits
    expect(out.var).toBe(9);
    expect(out.killed).toBe(true);
    expect(out.condNo).toBe(100);
    expect(out.condYes).toBe(30);
    expect(out.text).toBe("Deal 8 damage. Apply 2 Vulnerable.");
    expect(out.textUp).toBe("Deal 11 damage. Apply 2 Vulnerable.");
    expect(out.wild).toBe("Deal 6 damage X+1 times.");
    expect(out.bad).toBe(true);
  });

  it("piles, shuffles and draws are deterministic per seed; retain/ethereal/exhaust/power", async () => {
    const { out } = await lua(`
      local deck = { "jab", "brace", "flare", "twin_sparks", "smolder", "wick_trim", "lantern_guard", "backdraft", "steady_flame", "iron_lamp", "flicker", "ash" }
      local function sig(seed)
        local b = battle({ seed = seed, deck = deck, enemies = { "drowned_bell" }, hp = 999 }):start()
        local parts = {}
        for t = 1, 4 do
          table.insert(parts, table.concat(b:piles().hand, ","))
          b:endTurn()
        end
        return table.concat(parts, "|")
      end
      out.same = sig(7) == sig(7)
      out.diff = sig(7) ~= sig(8)
      -- reshuffle: draw everything
      local b = battle({ deck = { "jab", "jab", "brace" }, draw = 2, enemies = { "drowned_bell" }, hp = 999 }):start()
      out.h1 = #b.hand
      b:endTurn()
      out.h2 = #b.hand
      out.total = #b.hand + #b.drawPile + #b.discard
      -- retain + ethereal + exhaust + power
      local b2 = battle({ deck = { "flicker", "ash", "ember_toss", "forge_heart" }, enemies = { "drowned_bell" }, hp = 999 }):start()
      for i, c in b2.hand do if c.id == "ember_toss" then b2:play(i, 1) break end end
      for i, c in b2.hand do if c.id == "forge_heart" then b2:play(i) break end end
      out.exhaustPile = b2:piles().exhaust
      out.powers = #b2.powers
      out.str = b2.player.statuses.strength
      b2:endTurn()
      local ids = b2:piles()
      out.afterHand = ids.hand
      out.afterExhaust = ids.exhaust
      out.ashUnplayable = select(2, (function() for i, c in b2.hand do if c.id == "ash" then return b2:canPlay(i) end end return true, "none" end)())
    `);
    expect(out.same).toBe(true);
    expect(out.diff).toBe(true);
    expect(out.h1).toBe(2);
    expect(out.h2).toBe(2);
    expect(out.total).toBe(3);
    expect(out.exhaustPile).toEqual(["ember_toss"]);
    expect(out.powers).toBe(1);
    expect(out.str).toBe(2);
    expect(out.afterHand).toContain("flicker"); // retained
    expect(out.afterExhaust).toContain("ash"); // ethereal
  });

  it("energy, X-cost, unplayable and costs", async () => {
    const { out } = await lua(`
      local b = battle({ deck = { "wildfire", "flare", "bellows", "jab", "jab" }, enemies = { "drowned_bell" } }):start()
      b.enemies[1].hp = 500 b.enemies[1].maxHp = 500 b.enemies[1].statuses = {}
      local function idx(id) for i, c in b.hand do if c.id == id then return i end end end
      out.e0 = b.energy
      b:play(idx("bellows")) out.e1 = b.energy           -- 3 - 1 + 2 = 4
      local before = b.enemies[1].hp
      b:play(idx("wildfire"), 1) out.e2 = b.energy        -- X = 4 -> 0
      out.wildDmg = before - b.enemies[1].hp              -- 6 x4 = 24
      local ok, why = b:play(idx("flare"), 1) out.noEnergy = why
      b:endTurn() out.e3 = b.energy
    `);
    expect(out.e0).toBe(3);
    expect(out.e1).toBe(4);
    expect(out.e2).toBe(0);
    expect(out.wildDmg).toBe(24);
    expect(out.noEnergy).toBe("energy");
    expect(out.e3).toBe(3);
  });

  it("intents follow patterns and show modified damage; statuses tick", async () => {
    const { out } = await lua(`
      local b = battle({ deck = { "brace", "brace", "brace", "brace", "brace" }, enemies = { "brass_crab" }, hp = 200 }):start()
      local e = b.enemies[1]
      local moves = {}
      for t = 1, 5 do table.insert(moves, e.intent.move) b:endTurn() end
      out.cycle = moves
      -- sequence then cycle (boss)
      local bb = battle({ deck = { "brace" }, enemies = { "drowned_bell" }, hp = 999 }):start()
      local seq = {}
      for t = 1, 6 do table.insert(seq, bb.enemies[1].intent.move) bb:endTurn() end
      out.seq = seq
      -- intent damage with weak / vulnerable / strength
      local b2 = battle({ deck = { "brace" }, enemies = { "bilge_rat" }, hp = 200, seed = 3 }):start()
      local r = b2.enemies[1]
      r.intent = { move = "bite", kind = "attack" } b2:refreshIntent(r)
      out.base = r.intent.damage
      b2:applyStatus(r, "strength", 2) b2:refreshIntent(r) out.str = r.intent.damage
      b2:applyStatus(r, "weak", 1) b2:refreshIntent(r) out.weak = r.intent.damage
      b2:applyStatus(b2.player, "vulnerable", 1) b2:refreshIntent(r) out.vuln = r.intent.damage
      out.kind = BattleKind
      -- poison ticks + decays, metallicize, regen, ritual, artifact, thorns, frail, dexterity
      local b3 = battle({ deck = { "brace", "brace", "brace", "brace", "brace" }, enemies = { "drowned_bell" }, hp = 200 }):start()
      local boss = b3.enemies[1]
      out.artifact0 = boss.statuses.artifact
      b3:applyStatus(boss, "poison", 5) out.blocked = boss.statuses.poison  -- negated by artifact
      boss.statuses = {}
      b3:applyStatus(boss, "poison", 5)
      local hp = boss.hp
      b3:endTurn()
      out.poisonDmg = hp - boss.hp
      out.poisonLeft = boss.statuses.poison
      local p = b3.player
      p.statuses = { metallicize = 3, regen = 2, ritual = 1 }
      p.hp = 100 p.block = 0
      b3.hand = {}
      b3:endTurn()
      out.ritualStr = p.statuses.strength
      out.regenLeft = p.statuses.regen
      p.statuses = { dexterity = 2, frail = 1 }
      p.block = 0
      E.run({ "block 8" }, { b = b3, src = p })
      out.frailDex = p.block                           -- (8+2)*0.75 = 7
      local b4 = battle({ deck = { "jab" }, enemies = { "iron_diver" }, hp = 100 }):start()
      local hp0 = b4.player.hp
      E.run({ "damage 3 x2" }, { b = b4, src = b4.player, tgt = b4.enemies[1] })
      out.thorns = hp0 - b4.player.hp                  -- 2 thorns x2 hits
    `.replace("out.kind = BattleKind", ""));
    expect(out.cycle).toEqual(["clamp", "shell", "clamp", "shell", "clamp"]);
    expect(out.seq).toEqual(["resonate", "toll", "ring", "sink", "toll", "ring"]);
    expect(out.base).toBe(6);
    expect(out.str).toBe(8);
    expect(out.weak).toBe(6); // 8 * 0.75
    expect(out.vuln).toBe(9); // 8 * 0.75 * 1.5
    expect(out.artifact0).toBe(2);
    expect(out.blocked).toBeUndefined();
    expect(out.poisonDmg).toBe(5);
    expect(out.poisonLeft).toBe(4);
    expect(out.ritualStr).toBe(1);
    expect(out.regenLeft).toBe(1);
    expect(out.frailDex).toBe(7);
    expect(out.thorns).toBe(4);
  });

  it("custom statuses (data/deckbuilder.json ember) and relic triggers", async () => {
    const { out } = await lua(`
      local b = battle({ deck = { "tinder_box", "jab", "jab", "jab", "jab" }, enemies = { "bilge_rat", "lantern_moth" }, relics = { "brass_compass", "oil_flask", "moth_lantern", "tide_charm" }, hp = 100 }):start()
      out.compass = b.player.block
      out.flask = b.player.statuses.strength
      out.lantern = #b.hand
      for _, e in b.enemies do e.hp, e.maxHp = 60, 60 end
      for i, c in b.hand do if c.id == "tinder_box" then b:play(i) break end end
      out.energyBefore = b.energy
      local n = 0
      while n < 3 do
        local played = false
        for i, c in b.hand do if c.id == "jab" and b:canPlay(i) then b:play(i, 1) played = true n += 1 break end end
        if not played then break end
      end
      out.charge = b.energy   -- 3 -1 (tinder) -2 (jabs, energy ran out at 2?) +1 on 3rd attack
      local hp2 = b.enemies[2].hp
      b:endTurn()
      out.ember = hp2 - b.enemies[2].hp >= 2
    `);
    expect(out.compass).toBe(8);
    expect(out.flask).toBe(1);
    expect(out.lantern).toBe(5); // deck is only 5 cards: draw 5 + 2 capped by the deck
    expect(out.ember).toBe(true);
  });
});

describe("deckbuilder kit: runs", () => {
  it("map generation: connected, non-crossing, rules hold over many seeds", async () => {
    const { out } = await lua(`
      local bad = {}
      local counts = {}
      for seed = 1, 150 do
        local m = Map.generate({ seed = seed, rows = 12, cols = 7, paths = 6 })
        local r = Map.check(m)
        if not r.ok then table.insert(bad, seed .. ":" .. table.concat(r.problems, ",")) end
        for id, n in m.nodes do
          counts[n.type] = (counts[n.type] or 0) + 1
          if n.row == 1 and n.type ~= "fight" then table.insert(bad, "row1 " .. seed) end
          if n.row == 12 and n.type ~= "rest" then table.insert(bad, "prerest " .. seed) end
          if n.type == "elite" and n.row < 5 then table.insert(bad, "early elite " .. seed) end
          if n.type == "treasure" and n.row ~= 7 then table.insert(bad, "treasure " .. seed) end
        end
        if #m.starts < 2 then table.insert(bad, "starts " .. seed) end
      end
      out.bad = table.concat(bad, ";")
      out.counts = counts
      local a = Map.generate({ seed = 5 }) local b = Map.generate({ seed = 5 })
      out.same = table.concat(a.order, ",") == table.concat(b.order, ",") and a.nodes[a.order[5]].type == b.nodes[b.order[5]].type
    `);
    expect(out.bad).toBe("");
    expect(out.same).toBe(true);
    expect(out.counts.elite).toBeGreaterThan(0);
    expect(out.counts.shop).toBeGreaterThan(0);
    expect(out.counts.event).toBeGreaterThan(0);
  });

  it("rewards, shop, rest, events, removal, upgrades, treasure", async () => {
    const { out } = await lua(`
      local run = Run.new({ C = C, character = "wick", seed = 11 })
      out.deck0 = #run.deck
      out.relics0 = table.clone(run.relics)
      -- fight node
      run:go(run:choices()[1])
      out.state1 = run.state
      Bot.fight(run.battle)
      run:afterBattle()
      local rw = run.rewards
      out.cards = #rw.cards
      local uniq = {} for _, c in rw.cards do uniq[c] = true end
      local nu = 0 for _ in uniq do nu += 1 end
      out.uniq = nu
      local g = run.gold
      run:takeGold() out.gold = run.gold - g
      out.goldOnce = run:takeGold() == false
      run:takeCard(2) out.deck1 = #run.deck
      out.cardOnce = run:takeCard(1) == false
      run:leave() out.state2 = run.state
      -- forced nodes
      run.state = "map"
      run.node = { type = "shop", row = 3, id = "x" }
      run:enter({ id = "shop_t", type = "shop", row = 3, col = 1, next = {} })
      out.shopCards = #run.shop.cards
      out.shopRelics = #run.shop.relics
      run.gold = 1000
      out.bought = run:buyCard(1)
      out.boughtRelic = run:buyRelic(1)
      local d = #run.deck
      out.removed = run:buyRemoval()
      out.deckAfterRemove = #run.deck == d - 1
      out.removeOnce = run:buyRemoval() == false
      run:leave()
      run:enter({ id = "rest_t", type = "rest", row = 6, col = 1, next = {} })
      run.hp = 10
      run:rest("heal") out.healed = run.hp
      run:enter({ id = "rest_u", type = "rest", row = 6, col = 1, next = {} })
      local ui = nil for i, c in run.deck do if c.id == "jab" then ui = i break end end
      run:rest("upgrade", ui) out.upgraded = run.deck[ui].up
      run:enter({ id = "tr", type = "treasure", row = 7, col = 1, next = {} })
      out.treasure = run.rewards.relic ~= nil
      local nr = #run.relics run:takeRelic() out.relicTaken = #run.relics == nr + 1
      run:leave()
      run:enter({ id = "ev", type = "event", row = 4, col = 1, next = {} })
      out.event = run.event.id
      local ch = run:eventChoices()
      out.choices = #ch
      run.gold = 10
      if run.event.id == "peddler" then out.locked = ch[1].locked end
      run:eventChoose(#ch)
      out.afterEvent = run.state
      -- event effects (run-level verbs)
      local hp, mx = run.hp, run.maxHp
      E.run({ "max_hp 5", "gold 7", "relic random", "card random", "add dread deck", "upgrade_deck 1", "remove_card 1" }, { run = run })
      out.maxHp = run.maxHp - mx
      local dread = false for _, c in run.deck do if c.id == "dread" then dread = true end end
      out.dreadRemoved = not dread  -- remove_card removes the worst card (the curse)
      -- boss rewards
      local r2 = Run.new({ C = C, character = "wick", seed = 3 })
      r2.node = { type = "boss", row = 13, id = "boss" }
      r2.pos = "boss"
      r2.battle = { state = "won", turn = 5, player = { hp = 40, maxHp = 72 }, enemies = {} }
      r2:afterBattle()
      out.bossRelics = r2.rewards.bossRelics
      out.bossCardRarities = (function() local t = {} for _, id in r2.rewards.cards do table.insert(t, C.cards[id].rarity) end return t end)()
      r2:takeRelic(1)
      r2:leave()
      out.wonAfterBoss = r2.state
    `);
    expect(out.deck0).toBe(10);
    expect(out.relics0).toEqual(["ember_heart"]);
    expect(out.state1).toBe("battle");
    expect(out.cards).toBe(3);
    expect(out.uniq).toBe(3);
    expect(out.gold).toBeGreaterThanOrEqual(10);
    expect(out.goldOnce).toBe(true);
    expect(out.deck1).toBe(11);
    expect(out.cardOnce).toBe(true);
    expect(out.state2).toBe("map");
    expect(out.shopCards).toBe(5);
    expect(out.shopRelics).toBeGreaterThanOrEqual(1);
    expect(out.bought).toBe(true);
    expect(out.boughtRelic).toBe(true);
    expect(out.removed).toBe(true);
    expect(out.deckAfterRemove).toBe(true);
    expect(out.removeOnce).toBe(true);
    expect(out.healed).toBe(32); // 10 + 30% of 72 (22)
    expect(out.upgraded).toBe(true);
    expect(out.treasure).toBe(true);
    expect(out.relicTaken).toBe(true);
    expect(out.choices).toBeGreaterThanOrEqual(2);
    expect(out.afterEvent).toBe("map");
    expect(out.maxHp).toBe(5);
    expect(out.dreadRemoved).toBe(true);
    expect(out.bossRelics).toEqual(["bell_shard"]);
    expect(new Set(out.bossCardRarities)).toEqual(new Set(["rare"]));
    expect(out.wonAfterBoss).toBe("won"); // single-act example: boss ends the run
  });

  it("a full seeded bot run is deterministic; mid-run save/restore via core.save", async () => {
    const { out } = await lua(`
      local function play(seed)
        local run = Run.new({ C = C, character = "wick", seed = seed })
        Bot.playRun(run)
        local deck = {} for _, c in run.deck do table.insert(deck, c.id .. (if c.up then "+" else "")) end
        return run.state .. "|" .. run.floor .. "|" .. run.hp .. "|" .. run.gold .. "|" .. table.concat(deck, ","), run
      end
      local a, ra = play(21)
      local b2 = play(21)
      out.same = a == b2
      out.state = ra.state
      out.floor = ra.floor
      out.fights = #ra.stats.turnsPerFight
      -- save/restore mid-run through core.save
      local Core = require("@kit/core")
      local run = DB.newRun({ character = "wick", seed = 99 })
      for _ = 1, 6 do Bot.step(run) end
      while run.state ~= "map" do Bot.step(run) end
      local snap = { floor = run.floor, hp = run.hp, gold = run.gold, deck = #run.deck, pos = run.pos, relics = #run.relics }
      Core.save.save("t")
      DB.current = nil
      Core.save.load("t")
      local r2 = DB.current
      out.restored = r2 ~= nil and r2.floor == snap.floor and r2.hp == snap.hp and r2.gold == snap.gold and #r2.deck == snap.deck and r2.pos == snap.pos and #r2.relics == snap.relics
      out.choicesSame = table.concat(r2:choices(), ",") == table.concat(run:choices(), ",")
      -- meta
      local m0 = DB.meta.get().runs
      Bot.playRun(r2)
      DB.meta.record(r2)
      out.metaRuns = DB.meta.get().runs - m0
      out.metaXp = DB.meta.get().xp > 0
    `);
    expect(out.same).toBe(true);
    expect(["won", "lost"]).toContain(out.state);
    expect(out.floor).toBeGreaterThan(3);
    expect(out.fights).toBeGreaterThan(2);
    expect(out.restored).toBe(true);
    expect(out.choicesSame).toBe(true);
    expect(out.metaRuns).toBe(1);
    expect(out.metaXp).toBe(true);
  });
});

describe("deckbuilder kit: example (Lanternfall)", () => {
  it("balance sim: win rate, floors, turns per fight, deck power curve", async () => {
    const { out, logs } = await lua(`
      local rep = DB.sim({ seeds = 60 })
      print(Bot.format(rep))
      out.winRate = rep.winRate
      out.avgFloor = rep.avgFloor
      out.avgTurns = rep.avgTurns
      out.first = rep.power[1].power
      out.last = rep.power[#rep.power].power
    `, { budgetMs: 60000 });
    console.log(logs.join("\n"));
    expect(out.winRate).toBeGreaterThan(0.25);
    expect(out.winRate).toBeLessThan(0.9);
    expect(out.avgTurns).toBeGreaterThan(2.5);
    expect(out.last).toBeGreaterThan(out.first);
  });

  it("every UI screen renders headless with zero script errors", async () => {
    await lua(`
      local UI = DB.ui
      UI.title({ title = "T", canContinue = true, onStart = function() end, onContinue = function() end, meta = "x" })
      local seen = {}
      for seed = 1, 4 do
        local run = DB.newRun({ character = "wick", seed = seed })
        for _ = 1, 200 do
          local st = run.state
          seen[st] = true
          if st == "map" then UI.map(run, {})
          elseif st == "battle" then
            UI.battle(run, run.battle, {})
            local b = run.battle
            -- play the first playable card through the UI path's API, then let the bot finish
            for i = 1, #b.hand do if b:canPlay(i) then b:play(i, 1) break end end
          elseif st == "reward" then UI.rewards(run, {})
          elseif st == "shop" then UI.shop(run, {}) UI.deck(run, { title = "Remove?", onPick = function() end })
          elseif st == "rest" then UI.rest(run, {}) UI.deck(run, { preview = "upgrade", filter = function(c) return true end, onPick = function() end })
          elseif st == "event" then UI.event(run, {})
          else UI.ending(run, { onAgain = function() end }) break end
          if not Bot.step(run) then UI.ending(run, { onAgain = function() end }) break end
        end
      end
      local n = 0 for _ in seen do n += 1 end
      out.screens = n
    `);
  });

  it("plays end-to-end headless with zero script errors (title, map, battle taps, end turn)", async () => {
    const pkg = Package.fromFiles(exampleFiles());
    const timeline: { t: number; tap: [number, number] }[] = [{ t: 1, tap: [360, 868] }];
    let t = 2;
    for (let round = 0; round < 12; round++) {
      for (let c = 0; c < 7; c++) timeline.push({ t: (t += 0.15), tap: [90 + c * 90, 1180] }); // map row 1
      for (let k = 0; k < 6; k++) {
        timeline.push({ t: (t += 0.3), tap: [215 + (k % 3) * 140, 1140] }); // a card
        timeline.push({ t: (t += 0.3), tap: [360, 420] }); // an enemy
        timeline.push({ t: (t += 0.3), tap: [215 + (k % 3) * 140, 1080] }); // tap again (untargeted)
      }
      timeline.push({ t: (t += 0.3), tap: [620, 892] }); // end turn
      timeline.push({ t: (t += 1.5), tap: [360, 1175] }); // continue on rewards
    }
    const r = await simulate(pkg, timeline, t + 3);
    if (r.errors.length) console.log(r.errors);
    expect(r.loadError).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.audio.music.length).toBeGreaterThan(0);
  });
});
