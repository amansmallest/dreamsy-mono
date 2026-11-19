// deckbuilder kit: effect language, piles/shuffle determinism, intents, statuses, energy/X-cost,
// rewards, map connectivity, a full seeded bot run, the balance sim and the example package (Lanternfall)
// end to end. Port of engine-web/test/kits/deckbuilder.test.ts (same numbers and thresholds).
#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kExample = "games/examples/kit-deckbuilder";

// TS lua(): runs a Luau body with the example's data/ files (not its scripts) and the kit set up.
// The body fills `out`, which is saved; battle(o) builds a Battle with test defaults.
LuauRun lua(const std::string& body, double budget_ms = 20000) {
  LuauOptions o;
  o.kits = {"deckbuilder"};
  o.base = read_dir(kExample);
  // The example's scenes attach its scripts, which run_luau drops: leave the scenes out too so the
  // package validates (TS Package.fromFiles only warns). Only data/ matters here.
  for (const std::string& p : paths_with(o.base, "scenes/")) o.base.erase(p);
  o.budget_ms = budget(budget_ms);  // TS budgetMs (scaled under the sanitizers)
  LuauRun r = run_luau(R"LUA(
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
)LUA" + body + "\nsave.set(\"out\", out)\n",
                       o);
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
  return r;
}

bool has_str(const std::vector<std::string>& v, std::string_view s) {
  for (const std::string& x : v)
    if (x == s) return true;
  return false;
}

}  // namespace

TEST_SUITE("kit deckbuilder") {

// ---------------------------------------------------------------- effects + battle

TEST_CASE("deckbuilder: effects + battle: every effect verb works and auto text is generated") {
  LuauRun r = lua(R"LUA(
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
  )LUA");
  J o = r.out();
  CHECK(o["dmg"].num() == 6);
  CHECK(o["hits"].num() == 6);
  CHECK(o["all"].dump() == "[83,95]");
  CHECK(o["block"].num() == 7);
  CHECK(o["draw"].num() == 2);
  CHECK(o["energy"].num() == 2);
  CHECK(o["heal"].num() == 35);
  CHECK(o["lose"].num() == 32);
  CHECK(o["vuln"].num() == 2);
  CHECK(o["weakAll"].dump() == "[1,1]");
  CHECK(o["str"].num() == 2);
  CHECK(o["dbl"].num() == 4);
  CHECK(o["removed"].b());
  CHECK(o["discard"].num() == 1);
  CHECK(o["exhaust"].num() == 1);
  CHECK(o["add"].num() == 2);
  CHECK(o["upgraded"].b());
  CHECK(o["x"].num() == 4);      // 3 * vulnerable 1.5 = 4.5 -> 4
  CHECK(o["xhits"].num() == 9);  // 2 * 1.5 = 3 per hit, 3 hits
  CHECK(o["var"].num() == 9);
  CHECK(o["killed"].b());
  CHECK(o["condNo"].num() == 100);
  CHECK(o["condYes"].num() == 30);
  CHECK(o["text"].str() == "Deal 8 damage. Apply 2 Vulnerable.");
  CHECK(o["textUp"].str() == "Deal 11 damage. Apply 2 Vulnerable.");
  CHECK(o["wild"].str() == "Deal 6 damage X+1 times.");
  CHECK(o["bad"].b());
}

TEST_CASE("deckbuilder: effects + battle: piles, shuffles and draws are deterministic per seed; retain/ethereal/exhaust/power") {
  LuauRun r = lua(R"LUA(
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
  )LUA");
  J o = r.out();
  CHECK(o["same"].b());
  CHECK(o["diff"].b());
  CHECK(o["h1"].num() == 2);
  CHECK(o["h2"].num() == 2);
  CHECK(o["total"].num() == 3);
  CHECK(o["exhaustPile"].dump() == R"(["ember_toss"])");
  CHECK(o["powers"].num() == 1);
  CHECK(o["str"].num() == 2);
  CHECK(has_str(o["afterHand"].strs(), "flicker"));   // retained
  CHECK(has_str(o["afterExhaust"].strs(), "ash"));    // ethereal
}

TEST_CASE("deckbuilder: effects + battle: energy, X-cost, unplayable and costs") {
  LuauRun r = lua(R"LUA(
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
  )LUA");
  J o = r.out();
  CHECK(o["e0"].num() == 3);
  CHECK(o["e1"].num() == 4);
  CHECK(o["e2"].num() == 0);
  CHECK(o["wildDmg"].num() == 24);
  CHECK(o["noEnergy"].str() == "energy");
  CHECK(o["e3"].num() == 3);
}

TEST_CASE("deckbuilder: effects + battle: intents follow patterns and show modified damage; statuses tick") {
  LuauRun r = lua(R"LUA(
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
  )LUA");
  J o = r.out();
  CHECK(o["cycle"].dump() == R"(["clamp","shell","clamp","shell","clamp"])");
  CHECK(o["seq"].dump() == R"(["resonate","toll","ring","sink","toll","ring"])");
  CHECK(o["base"].num() == 6);
  CHECK(o["str"].num() == 8);
  CHECK(o["weak"].num() == 6);  // 8 * 0.75
  CHECK(o["vuln"].num() == 9);  // 8 * 0.75 * 1.5
  CHECK(o["artifact0"].num() == 2);
  CHECK(o["blocked"].is_null());
  CHECK(o["poisonDmg"].num() == 5);
  CHECK(o["poisonLeft"].num() == 4);
  CHECK(o["ritualStr"].num() == 1);
  CHECK(o["regenLeft"].num() == 1);
  CHECK(o["frailDex"].num() == 7);
  CHECK(o["thorns"].num() == 4);
}

TEST_CASE("deckbuilder: effects + battle: custom statuses (data/deckbuilder.json ember) and relic triggers") {
  LuauRun r = lua(R"LUA(
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
      out.charge = b.energy
      local hp2 = b.enemies[2].hp
      b:endTurn()
      out.ember = hp2 - b.enemies[2].hp >= 2
  )LUA");
  J o = r.out();
  CHECK(o["compass"].num() == 8);
  CHECK(o["flask"].num() == 1);
  CHECK(o["lantern"].num() == 5);  // deck is only 5 cards: draw 5 + 2 capped by the deck
  CHECK(o["ember"].b());
}

// ---------------------------------------------------------------- runs

TEST_CASE("deckbuilder: runs: map generation: connected, non-crossing, rules hold over many seeds") {
  LuauRun r = lua(R"LUA(
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
  )LUA");
  J o = r.out();
  CHECK(o["bad"].str() == "");
  CHECK(o["same"].b());
  CHECK(o["counts"]["elite"].num() > 0);
  CHECK(o["counts"]["shop"].num() > 0);
  CHECK(o["counts"]["event"].num() > 0);
}

TEST_CASE("deckbuilder: runs: rewards, shop, rest, events, removal, upgrades, treasure") {
  LuauRun r = lua(R"LUA(
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
  )LUA");
  J o = r.out();
  CHECK(o["deck0"].num() == 10);
  CHECK(o["relics0"].dump() == R"(["ember_heart"])");
  CHECK(o["state1"].str() == "battle");
  CHECK(o["cards"].num() == 3);
  CHECK(o["uniq"].num() == 3);
  CHECK(o["gold"].num() >= 10);
  CHECK(o["goldOnce"].b());
  CHECK(o["deck1"].num() == 11);
  CHECK(o["cardOnce"].b());
  CHECK(o["state2"].str() == "map");
  CHECK(o["shopCards"].num() == 5);
  CHECK(o["shopRelics"].num() >= 1);
  CHECK(o["bought"].b());
  CHECK(o["boughtRelic"].b());
  CHECK(o["removed"].b());
  CHECK(o["deckAfterRemove"].b());
  CHECK(o["removeOnce"].b());
  CHECK(o["healed"].num() == 32);  // 10 + 30% of 72 (22)
  CHECK(o["upgraded"].b());
  CHECK(o["treasure"].b());
  CHECK(o["relicTaken"].b());
  CHECK(o["choices"].num() >= 2);
  CHECK(o["afterEvent"].str() == "map");
  CHECK(o["maxHp"].num() == 5);
  CHECK(o["dreadRemoved"].b());
  CHECK(o["bossRelics"].dump() == R"(["bell_shard"])");
  // new Set(rarities) == {"rare"}: non-empty and every one is rare
  std::vector<std::string> rarities = o["bossCardRarities"].strs();
  CHECK(!rarities.empty());
  for (const std::string& rr : rarities) CHECK(rr == "rare");
  CHECK(o["wonAfterBoss"].str() == "won");  // single-act example: boss ends the run
}

TEST_CASE("deckbuilder: runs: a full seeded bot run is deterministic; mid-run save/restore via core.save") {
  LuauRun r = lua(R"LUA(
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
  )LUA");
  J o = r.out();
  CHECK(o["same"].b());
  CHECK((o["state"].str() == "won" || o["state"].str() == "lost"));
  CHECK(o["floor"].num() > 3);
  CHECK(o["fights"].num() > 2);
  CHECK(o["restored"].b());
  CHECK(o["choicesSame"].b());
  CHECK(o["metaRuns"].num() == 1);
  CHECK(o["metaXp"].b());
}

// ---------------------------------------------------------------- example (Lanternfall)

TEST_CASE("deckbuilder example (Lanternfall): balance sim: win rate, floors, turns per fight, deck power curve" *
          doctest::test_suite("slow")) {
  LuauRun r = lua(R"LUA(
      local rep = DB.sim({ seeds = 60 })
      print(Bot.format(rep))
      out.winRate = rep.winRate
      out.avgFloor = rep.avgFloor
      out.avgTurns = rep.avgTurns
      out.first = rep.power[1].power
      out.last = rep.power[#rep.power].power
  )LUA",
                  60000);
  MESSAGE(join(r.logs));
  J o = r.out();
  CHECK(o["winRate"].num() > 0.25);
  CHECK(o["winRate"].num() < 0.9);
  CHECK(o["avgTurns"].num() > 2.5);
  CHECK(o["last"].num() > o["first"].num());
}

TEST_CASE("deckbuilder example: every UI screen renders headless with zero script errors" *
          doctest::test_suite("slow")) {
  lua(R"LUA(
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
  )LUA");
}

TEST_CASE("deckbuilder example: plays end-to-end headless with zero script errors (title, map, battle taps, end turn)" *
          doctest::test_suite("slow")) {
  std::vector<TimelineStep> timeline;
  auto tap = [&](double t, double x, double y) {
    TimelineStep s;
    s.t = t;
    s.tap = std::make_pair(x, y);
    timeline.push_back(s);
  };
  tap(1, 360, 868);
  double t = 2;
  for (int round = 0; round < 12; ++round) {
    for (int c = 0; c < 7; ++c) tap(t += 0.15, 90 + c * 90, 1180);  // map row 1
    for (int k = 0; k < 6; ++k) {
      tap(t += 0.3, 215 + (k % 3) * 140, 1140);  // a card
      tap(t += 0.3, 360, 420);                   // an enemy
      tap(t += 0.3, 215 + (k % 3) * 140, 1080);  // tap again (untargeted)
    }
    tap(t += 0.3, 620, 892);   // end turn
    tap(t += 1.5, 360, 1175);  // continue on rewards
  }
  PlaytestReport r = simulate(read_dir(kExample), timeline, t + 3);
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
  CHECK(r.music.size() > 0);
}

}  // TEST_SUITE

