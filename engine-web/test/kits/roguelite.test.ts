// roguelite kit: run generation determinism per seed, relic synergy math, room flow, meta unlock persistence,
// daily seed, mid-run save/resume, balance sim, and the example package end-to-end (bot, several seeds).
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { Package } from "@dreamsy/format";
import { Game, MemorySaveHost } from "../../core/index.js";

const EXAMPLE = resolve(__dirname, "../../../games/examples/kit-roguelite");

async function runLuau(src: string, opts: { steps?: number; save?: MemorySaveHost; clock?: () => number } = {}) {
  const files: Record<string, string> = {
    "dreamsy.toml": `format = "0"\nname = "kit test"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/main.scene.json"\nkits = ["roguelite"]\n[style]\npreset = "clean"\n`,
    "scenes/main.scene.json": JSON.stringify({ format: "0", root: "root", entities: { root: { type: "Node2D" } } }),
    "scripts/client/main.luau": src,
  };
  const host = opts.save ?? new MemorySaveHost();
  const game = await Game.load(Package.fromFiles(files), { seed: 1, save: host, clock: opts.clock, budgetMs: 5000 }); // pure-logic batches (thousands of sims in one callback) under parallel test load: the 250ms frame budget is wall-clock
  for (let i = 0; i < (opts.steps ?? 1); i++) game.step();
  const errors = game.errors.map((e) => `${e.script}:${e.line ?? "?"}: ${e.message}`);
  return { out: host.data.out as any, errors, host, logs: game.logs.map((l) => l.text) };
}

// Small inline content: 2 classes, 2 biomes, relics with tags + a tiered synergy, events, actives, meta tree.
const CONTENT = `
local R = require("@kit/roguelite")
R.setup({ content = {
  classes = {
    knight = { name = "Knight", stats = { hp = 40, damage = 4, fireRate = 1.2 }, relics = { "oath" } },
    witch = { name = "Witch", stats = { hp = 26, damage = 3, fireRate = 2 }, unlock = { skill = "unlock_witch", tree = "meta" }, active = "nova" },
  },
  biomes = {
    moss = { order = 1, name = "Moss", floors = 1, steps = 6, enemies = { "slime", "bat" }, elites = { "brute" }, arena = { kind = "open" } },
    ember = { order = 2, name = "Ember", floors = 2, steps = 7, enemies = { "slime", "imp" }, elites = { "brute" }, boss = "king", arena = { kind = "caves" } },
  },
  enemies = {
    slime = { hp = 5, cost = 1, contact = { amount = 1 } }, bat = { hp = 3, cost = 1, contact = { amount = 1 } },
    imp = { hp = 6, cost = 2, projectile = { amount = 1 }, params = { fireEvery = 1.5 } },
    brute = { hp = 14, cost = 4, contact = { amount = 2 } }, king = { hp = 120, cost = 0, boss = true, dps = 3 },
  },
  relics = {
    oath = { name = "Oath", rarity = "starter", mods = { { stat = "armor", add = 0 } } },
    ember_ring = { name = "Ember Ring", rarity = "common", tags = { "fire" }, stack = true, mods = { { stat = "damage", add = 1 } } },
    coal = { name = "Coal", rarity = "common", tags = { "fire" }, mods = { { stat = "damage", pct = 0.5 } } },
    kindle = { name = "Kindle", rarity = "uncommon", tags = { "fire" }, onHit = { name = "burn", chance = 0.2 } },
    leech = { name = "Leech", rarity = "uncommon", triggers = { { on = "kill", every = 2, effects = { { heal = 1 } } } } },
    purse = { name = "Purse", rarity = "common", mods = { { stat = "goldMult", pct = 0.5 } } },
    heart = { name = "Heart", rarity = "rare", mods = { { stat = "hp", add = 10 } } },
    lucky = { name = "Lucky", rarity = "rare", triggers = { { on = "roomClear", effects = { { gold = 5, raw = true } } } } },
  },
  synergies = {
    blaze = { name = "Blaze", tags = { fire = 0 }, tiers = { { count = 2, mods = { { stat = "damage", mul = 1.2 } } }, { count = 3, mods = { { stat = "fireRate", pct = 0.25 } } } } },
  },
  actives = { nova = { name = "Nova", charge = 2, effects = { { healPct = 0.1 } } }, bomb = { name = "Bomb", charge = 3 } },
  events = {
    shrine = { title = "Shrine", choices = { { text = "Pray (-5 HP)", cost = { hp = 5 }, effects = { { relic = "random" } } }, { text = "Leave" } } },
    fountain = { title = "Fountain", choices = { { text = "Drink", effects = { { healPct = 0.5 } } } } },
  },
  meta = {
    unlock_witch = { name = "Witch", cost = { embers = 30 } },
    vigor = { name = "Vigor", cost = { embers = 10 }, maxRank = 3, mods = { { stat = "hp", add = 5 } } },
  },
}, config = { heat = { { name = "Warm", mods = { { stat = "enemyHp", pct = 0.25 } } }, { name = "Hot", mods = { { stat = "enemyDamage", pct = 0.5 } } } } } })
local out = {}
`;

const lua = async (body: string, opts: { steps?: number; save?: MemorySaveHost; clock?: () => number } = {}) => {
  const r = await runLuau(`${CONTENT}\n${body}\nsave.set("out", out)`, opts);
  expect(r.errors).toEqual([]);
  return r;
};

describe("roguelite kit", () => {
  it("run generation is deterministic per seed and follows the floor rules", async () => {
    const { out } = await lua(`
      local function sig(seed)
        local run = R.Run.new({ class = "knight", seed = seed, sim = true })
        local parts = {}
        for f = 1, run:totalFloors() do
          local plan = run:planFloor(f)
          local row = { plan.biome }
          for s, st in plan.steps do
            local ks = {}
            for _, c in st.choices do table.insert(ks, c.type .. ":" .. table.concat(c.enemies or {}, "+") .. ":" .. c.seed) end
            table.insert(row, table.concat(ks, ","))
          end
          table.insert(parts, table.concat(row, "|"))
        end
        return table.concat(parts, "\\n"), run
      end
      local a = sig(42)
      local b = sig(42)
      local c = sig(43)
      out.same = a == b
      out.diff = a ~= c
      -- rules over many seeds
      local bad = {}
      for seed = 1, 60 do
        local run = R.Run.new({ class = "knight", seed = seed, sim = true })
        for f = 1, run:totalFloors() do
          local plan = run:planFloor(f)
          local first = plan.steps[1].choices
          if #first ~= 1 or first[1].type ~= "combat" then table.insert(bad, "first " .. seed) end
          local last = plan.steps[#plan.steps].choices[1]
          if f == 3 and last.type ~= "boss" then table.insert(bad, "boss " .. seed) end
          if f == 1 and last.type ~= "elite" then table.insert(bad, "gate " .. seed) end
          local shops = 0
          for s, st in plan.steps do
            for _, ch in st.choices do
              if ch.type == "shop" and s < #plan.steps - 1 then shops += 1 end
              if ch.type == "elite" and s < 3 then table.insert(bad, "early elite " .. seed) end
              if (ch.type == "combat" or ch.type == "elite") and #ch.enemies == 0 then table.insert(bad, "empty " .. seed) end
            end
          end
          if shops > 1 then table.insert(bad, "shops " .. seed) end
          if plan.boss then
            local pre = plan.steps[#plan.steps - 1].choices
            local hasRest = false
            for _, ch in pre do if ch.type == "rest" then hasRest = true end end
            if not hasRest then table.insert(bad, "rest " .. seed) end
          end
        end
      end
      out.bad = table.concat(bad, ";")
      -- arenas: deterministic + spawns
      local run = R.Run.new({ class = "knight", seed = 9, sim = true })
      local room = run:planFloor(2).steps[1].choices[1]
      local l1, l2 = R.arena(room), R.arena(room)
      out.arenaSame = l1.grid:toString() == l2.grid:toString()
      out.spawns = #l1.spawns == #room.enemies
    `);
    expect(out.same).toBe(true);
    expect(out.diff).toBe(true);
    expect(out.bad).toBe("");
    expect(out.arenaSame).toBe(true);
    expect(out.spawns).toBe(true);
  });

  it("relic synergy + stacking math", async () => {
    const { out } = await lua(`
      local run = R.Run.new({ class = "knight", seed = 1, sim = true })
      out.base = run:statsNow().damage                     -- 4
      run:addRelic("ember_ring") run:addRelic("ember_ring") -- +1 x2 (stackable), 2 fire tags -> blaze tier 1 (x1.2)
      out.two = run:statsNow().damage                      -- (4+2)*1.2 = 7.2
      run:addRelic("coal")                                  -- +50%, 3 fire -> tier 2 (+25% fireRate)
      local st = run:statsNow()
      out.three = st.damage                                 -- (4+2)*1.5*1.2 = 10.8
      out.rate = st.fireRate                                -- 1.2*1.25 = 1.5
      out.syn = #run:synergies()
      out.tier = run:synergies()[1].tier
      out.hp0 = run.hp
      run:addRelic("heart")
      out.hp1 = run.hp                                      -- +10 hp heals the gained max
      run:addRelic("kindle")
      out.statuses = #run:hitStatuses()
      -- heat mods + meta mods
      local hot = R.Run.new({ class = "knight", seed = 1, heat = 1, sim = true, metaMods = { { stat = "hp", add = 5 } } })
      out.heatHp = hot:statsNow().enemyHp
      out.metaHp = hot:maxHp()
      -- triggers: every = 2
      run:addRelic("leech")
      run.hp = 10
      run:onKill("slime") run:onKill("slime") run:onKill("slime") run:onKill("slime")
      out.leechHp = run.hp
    `);
    expect(out.base).toBe(4);
    expect(out.two).toBeCloseTo(7.2, 5);
    expect(out.three).toBeCloseTo(10.8, 5);
    expect(out.rate).toBeCloseTo(1.5, 5);
    expect(out.syn).toBe(1);
    expect(out.tier).toBe(2);
    expect(out.hp1 - out.hp0).toBe(10);
    expect(out.statuses).toBe(1);
    expect(out.heatHp).toBeCloseTo(1.25, 5);
    expect(out.metaHp).toBe(45);
    expect(out.leechHp).toBe(12);
  });

  it("room flow: doors → rooms → rewards → floors → boss → won; shop/rest/event", async () => {
    const { out } = await lua(`
      local run = R.Run.new({ class = "knight", seed = 5, sim = true })
      run.gold = 500
      local log = {}
      local guard = 0
      local seen = {}
      while run.state ~= "won" and run.state ~= "dead" and guard < 200 do
        guard += 1
        if run.state == "choose" then
          local ch = run:choices()
          local pick = 1
          for i, c in ch do if not seen[c.type] then pick = i end end
          run:enter(pick)
          seen[run.room.type] = true
        elseif run.state == "room" then
          local t = run.room.type
          table.insert(log, t)
          if t == "shop" then
            out.stock = #run.room.stock
            local g = run.gold
            run:buy(1)
            out.paid = g - run.gold
            out.rebuy = select(2, run:buy(1))
            run:clear()
          elseif t == "rest" then run.hp = 5 run:rest("heal") out.rested = run.hp
          elseif t == "event" then out.event = run:eventDef().title run:choose(#run:eventDef().choices)
          else run:clear() end
        elseif run.state == "reward" then
          out.offered = #run.pending
          run:takeRelic(1)
        end
      end
      out.state = run.state
      out.floor = run.floor
      out.seen = seen
      out.rooms = run.stats.rooms
      out.relics = #run.relics
      out.bosses = run.stats.bosses
    `);
    expect(out.state).toBe("won");
    expect(out.floor).toBe(3);
    expect(out.rooms).toBe(20);
    expect(out.bosses).toBe(1);
    expect(out.offered).toBe(3);
    expect(out.relics).toBeGreaterThan(2);
    expect(out.seen.boss && out.seen.elite && out.seen.combat).toBeTruthy();
    if (out.seen.shop) { expect(out.stock).toBeGreaterThanOrEqual(3); expect(out.paid).toBeGreaterThan(0); expect(out.rebuy).toBe("sold"); }
    if (out.seen.rest) expect(out.rested).toBeGreaterThan(5);
  });

  it("meta unlocks persist across saves; heat unlocks after a win; mid-run resume", async () => {
    const save = new MemorySaveHost();
    const a = await lua(`
      core = require("@kit/core")
      out.witchBefore = R.unlocked("witch")
      core.wallet.add("embers", 50)
      local t = R.metaTree()
      out.buy = t:unlock("unlock_witch")
      out.vigor = t:unlock("vigor")
      out.witchAfter = R.unlocked("witch")
      out.embers = core.wallet.get("embers")
      out.heat0 = R.maxHeat("knight")
      local run = R.newRun({ class = "knight", seed = 77 })
      out.metaHp = run:maxHp()
      -- win the run quickly
      while run.state ~= "won" do
        if run.state == "choose" then run:enter(1)
        elseif run.state == "room" then
          local t = run.room.type
          if t == "shop" then run:clear() elseif t == "rest" then run:rest("heal") elseif t == "event" then run:choose(#run:eventDef().choices) else run:clear() end
        elseif run.state == "reward" then run:takeRelic(1) end
      end
      local sum = R.finish(run)
      out.won = sum.won
      out.earned = sum.metaEarned
      out.heat1 = R.maxHeat("knight")
      out.unlockedHeat = sum.unlockedHeat
      -- start another run, play 3 rooms, save mid-run
      local r2 = R.newRun({ class = "witch", seed = 1234, heat = 0 })
      r2:enter(1) r2:clear()
      r2:enter(1)
      out.midStep = r2.step
      out.midRoom = r2.room.type
      out.midGold = r2.gold
      R.save()
    `, { save });
    expect(a.out.witchBefore).toBe(false);
    expect(a.out.buy).toBe(true);
    expect(a.out.witchAfter).toBe(true);
    expect(a.out.embers).toBe(10);
    expect(a.out.heat0).toBe(0);
    expect(a.out.metaHp).toBe(45);
    expect(a.out.won).toBe(true);
    expect(a.out.earned).toBeGreaterThan(40);
    expect(a.out.heat1).toBe(1);
    expect(a.out.unlockedHeat).toBe(1);
    const b = await lua(`
      core = require("@kit/core")
      core.save.load()
      out.witch = R.unlocked("witch")
      out.vigor = R.metaTree():rank("vigor")
      out.heat = R.maxHeat("knight")
      out.has = R.hasSavedRun()
      local run = R.resume()
      out.step = run.step
      out.room = run.room and run.room.type
      out.gold = run.gold
      out.class = run.classId
      out.wins = R.meta.data.wins
    `, { save });
    expect(b.out.witch).toBe(true);
    expect(b.out.vigor).toBe(1);
    expect(b.out.heat).toBe(1);
    expect(b.out.has).toBe(true);
    expect(b.out.step).toBe(a.out.midStep);
    expect(b.out.room).toBe(a.out.midRoom);
    expect(b.out.gold).toBe(a.out.midGold);
    expect(b.out.class).toBe("witch");
    expect(b.out.wins).toBe(1);
  });

  it("daily seed: same for a calendar day, changes the next day, one record per day", async () => {
    const day = 20000 * 86400;
    const { out } = await lua(`
      local a = R.daily(${day} + 100)
      local b = R.daily(${day} + 80000)
      local c = R.daily(${day} + 86400 + 5)
      out.same = a.seed == b.seed and a.class == b.class
      out.diff = a.seed ~= c.seed
      out.day = a.day
      -- clock.now() default source
      local d = R.daily()
      out.clockDay = d.day
      local run = R.newRun({ daily = true })
      out.dailySeed = run.seed == d.seed
      run:die()
      R.finish(run)
      out.played = R.daily().played
    `, { clock: () => day + 3600 });
    expect(out.same).toBe(true);
    expect(out.diff).toBe(true);
    expect(out.day).toBe(20000);
    expect(out.clockDay).toBe(20000);
    expect(out.dailySeed).toBe(true);
    expect(out.played).toBe(true);
  });

  it("balance sim: deterministic, heat makes it harder", async () => {
    const { out } = await lua(`
      local ja, jb = R.sim.job({ runs = 30, seed = 3, heats = { 0, 2 } }), R.sim.job({ runs = 30, seed = 3, heats = { 0 } })
      onTick(function()
        ja:step(8) jb:step(8)
        if ja.done and jb.done and not out.a then
          local a, b = ja.result, jb.result
          out.a = a
          out.same = a.knight["0"].winRate == b.knight["0"].winRate and a.knight["0"].avgFloor == b.knight["0"].avgFloor
          save.set("out", out)
        end
      end)
    `, { steps: 60 });
    expect(out.same).toBe(true);
    for (const cls of ["knight", "witch"]) {
      const r0 = out.a[cls]["0"], r2 = out.a[cls]["2"];
      expect(r0.avgMinutes).toBeGreaterThan(0);
      expect(r2.winRate).toBeLessThanOrEqual(r0.winRate);
    }
  });
});

// ---------- example package (games/examples/kit-roguelite) ----------
async function examplePkg(extraConfig: (cfg: string) => string, replaceMain?: string) {
  const pkg = await Package.fromDir(EXAMPLE);
  const files: Record<string, string | Uint8Array> = {};
  for (const p of pkg.paths()) files[p] = pkg.bytes(p)!;
  files["scripts/shared/config.luau"] = extraConfig(new TextDecoder().decode(files["scripts/shared/config.luau"] as Uint8Array));
  if (replaceMain !== undefined) files["scripts/client/game.luau"] = replaceMain;
  return Package.fromFiles(files);
}

describe("kit-roguelite example", () => {
  it("bot plays several seeds end-to-end with zero script errors", async () => {
    for (const seed of [1, 2, 3, 4]) {
      const pkg = await examplePkg((c) => c.replace("bot = false", "bot = true").replace("seed = nil", `seed = ${seed}`));
      const host = new MemorySaveHost();
      const game = await Game.load(pkg, { seed, save: host });
      for (let i = 0; i < 60 * 90; i++) game.step();
      expect(game.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
      const rooms = game.logs.filter((l) => l.text.startsWith("room ")).length;
      expect(rooms).toBeGreaterThanOrEqual(4);
    }
  });

  it("balance sim over the example content (win rate per class/heat, floor, run length)", async () => {
    const pkg = await examplePkg((c) => c, `
local core = require("@kit/core")
local R = require("@kit/roguelite")
core.setup({ save = { key = "t" } })
R.setup()
local jobs = {}
for _, cls in { "warden", "tinker" } do
  for _, heat in { 0, 1, 2, 3 } do table.insert(jobs, { cls = cls, heat = heat, meta = false }) end
  table.insert(jobs, { cls = cls, heat = 0, meta = true })
end
local full = {}
for _, d in core.content.all("meta") do for _ = 1, d.maxRank or 1 do for _, m in d.mods or {} do table.insert(full, m) end end end
local out = {}
local k = 0
local cur = nil
onTick(function()
  if cur == nil then
    k += 1
    local j = jobs[k]
    if not j then return end
    cur = { j = j, job = R.sim.job({ classes = { j.cls }, heats = { j.heat }, runs = 100, seed = 7, metaMods = if j.meta then full else nil }) }
  end
  if cur.job:step(10) then
    local j = cur.j
    out[j.cls .. "/h" .. j.heat .. (if j.meta then "+meta" else "")] = cur.job.result[j.cls][tostring(j.heat)]
    save.set("out", out)
    cur = nil
  end
end)
`);
    const host = new MemorySaveHost();
    const game = await Game.load(pkg, { seed: 1, save: host });
    for (let i = 0; i < 200; i++) game.step();
    expect(game.errors.map((e) => e.message)).toEqual([]);
    const out = host.data.out as Record<string, { winRate: number; avgFloor: number; avgMinutes: number }>;
    const rows = Object.entries(out).map(([k, v]) => `${k}: win ${(v.winRate * 100).toFixed(0)}% floor ${v.avgFloor.toFixed(2)} ${v.avgMinutes.toFixed(1)} min`);
    console.log("roguelite balance\n" + rows.join("\n"));
    expect(out["warden/h0"]!.winRate).toBeLessThan(out["warden/h0+meta"]!.winRate + 1e-9);
    expect(out["warden/h3"]!.winRate).toBeLessThanOrEqual(out["warden/h0"]!.winRate);
  });
});
