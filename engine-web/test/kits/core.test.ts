// core kit (engine-web/kits/core): headless tests of every module through real Luau.
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game, MemorySaveHost } from "../../core/index.js";

const scene = JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } });
function kitGame(script: string, files: Record<string, string> = {}) {
  return Package.fromFiles({
    "dreamsy.toml": `format = "0"\nname = "K"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/main.scene.json"\nkits = ["core", "progression", "juice"]\n`,
    "scenes/main.scene.json": scene,
    "scripts/client/main.luau": script,
    ...files,
  });
}
async function run(script: string, opts: { steps?: number; save?: MemorySaveHost; files?: Record<string, string>; each?: (g: Game, i: number) => void } = {}) {
  const g = await Game.load(kitGame(script, opts.files), { save: opts.save });
  for (let i = 0; i < (opts.steps ?? 2); i++) { opts.each?.(g, i); g.step(); }
  const errs = g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`);
  const logs = g.logs.map((l) => l.text).filter((l) => !l.startsWith("[validate]"));
  return { g, errs, logs };
}
// assert helper available inside scripts: check(name, cond) prints "ok name" / "FAIL name"
const PRE = `
local fails = 0
local function check(name, c, extra) if c then print("ok " .. name) else fails += 1 print("FAIL " .. name .. " " .. tostring(extra)) end end
local function eq(name, a, b) check(name, a == b, tostring(a) .. " ~= " .. tostring(b)) end
`;
const noFails = (r: { errs: string[]; logs: string[] }) => {
  expect(r.errs).toEqual([]);
  expect(r.logs.filter((l) => l.startsWith("FAIL"))).toEqual([]);
  expect(r.logs.filter((l) => l.startsWith("ok ")).length).toBeGreaterThan(0);
};


const CONTENT = `
local core = require("@kit/core")
core.setup({
  currencies = { gold = { name = "Gold", start = 10 }, gems = { max = 5 } },
  bag = { slots = 3, categorySlots = { key = 1 } },
  items = {
    apple = { name = "Apple", category = "food", stack = 5, use = { { add = "hp", value = 2 } } },
    sword = { name = "Sword", category = "gear", stack = 1 },
    key = { name = "Key", category = "key", stack = 1, max = 1 },
    gem = { name = "Gem", category = "loot" },
  },
  quests = {
    { id = "apples", title = "Apples", steps = {
      { id = "collect", text = "Bring 3 apples", objectives = { { id = "a", condition = { item = "apple", count = 3 } } }, effects = { { take = "apple", count = 3 } } },
      { id = "slimes", text = "Beat 2 slimes", objectives = { { id = "s", event = "enemy_defeated", match = { enemy = "slime" }, count = 2 } } },
    }, rewards = { { earn = "gold", amount = 50 }, { set = "apples_done" } } },
    { id = "sequel", title = "Sequel", requires = { quest = "apples" }, autoStart = true, steps = {
      { id = "talk", objectives = { { id = "t", event = "talked", match = { npc = "owl" } } } } } },
  },
  dialog = {
    owl = { id = "owl", speaker = "Owl", start = "root", nodes = {
      root = { branches = { { condition = { quest = "apples", is = "done" }, next = "thanks" }, { condition = { quest = "apples", is = "active" }, next = "waiting" }, { next = "hello" } } },
      hello = { lines = { "Hoo!", { text = "You have {item:apple} apples.", speaker = "You" } }, next = "ask" },
      ask = { text = "Fetch apples?", choices = {
        { text = "Sure", next = "yes", effects = { { quest = "apples" } } },
        { text = "Pay 100 gold", condition = { currency = "gold", gte = 100 }, next = "rich", showLocked = true },
        { text = "Secret", condition = { flag = "secret" }, next = "rich" },
        { text = "No", next = "end" } } },
      yes = { text = "Thanks!", effects = { { set = "agreed" } } },
      waiting = { text = "Still waiting ({flag:hp} hp)" },
      thanks = { text = "Great job!" },
      rich = { text = "Rich!" },
    } },
  },
  achievements = {
    first_blood = { name = "First", event = "enemy_defeated" },
    hoarder = { name = "Hoarder", condition = { currency = "gold", gte = 60 }, rewards = { { earn = "gems", amount = 9 } } },
  },
  save = { key = "t", version = 1 },
})
`;

describe("core kit", () => {
  it("loads", async () => {
    const r = await run(`local core = require("@kit/core") print("v " .. core.VERSION)`);
    expect(r.errs).toEqual([]);
    expect(r.logs).toContain("v 0.1.0");
  });

  it("fsm + event bus", async () => {
    noFails(await run(PRE + `
      local core = require("@kit/core")
      local log = {}
      local m = core.fsm.new({ initial = "idle", states = {
        idle = { enter = function(m, from) table.insert(log, "enter idle " .. tostring(from)) end, on = { jump = "air", hurt = function(m, d) return if d > 5 then "dead" else nil end } },
        air = { update = function(m, dt) if m.time >= 0.5 then return "idle" end end, exit = function(m, to) table.insert(log, "exit air->" .. to) end },
        dead = {},
      } })
      eq("initial", m.state, "idle")
      check("send", m:send("jump"))
      eq("air", m.state, "air")
      check("no transition", not m:send("nope"))
      m:update(0.3) eq("still air", m.state, "air")
      m:update(0.3) eq("back idle", m.state, "idle")
      eq("prev", m.previous, "air")
      m:send("hurt", 2) eq("hurt small", m.state, "idle")
      m:send("hurt", 9) eq("hurt big", m.state, "dead")
      eq("log", table.concat(log, ","), "enter idle nil,exit air->idle,enter idle air")
      check("bad state errors", not pcall(function() m:go("zzz") end))
      local got, any = {}, {}
      local c = core.events.on("hit", function(d) table.insert(got, d.n) end)
      core.events.on("*", function(name, d) if name == "hit" then table.insert(any, d.n) end end)
      core.events.once("hit", function(d) table.insert(got, "once" .. d.n) end)
      core.emit("hit", { n = 1 }) core.emit("hit", { n = 2 }) c.disconnect() core.emit("hit", { n = 3 })
      eq("bus", table.concat(got, ","), "1,once1,2")
      eq("wildcard", table.concat(any, ","), "1,2,3")
      local bus = core.events.new() local n = 0 bus:on("x", function() n += 1 end) bus:emit("x") core.emit("x")
      eq("private bus", n, 1)
    `));
  });

  it("inventory stacking, slot + category + max limits, move/sort/use", async () => {
    noFails(await run(PRE + CONTENT + `
      local bag = core.bag
      eq("add 7 apples", bag:add("apple", 7), 7)
      eq("2 stacks", #bag:stacks(), 2)
      eq("count", bag:count("apple"), 7)
      eq("room: 3 more apples in stack 2 + 5 in last slot", bag:canAdd("apple", 20), 8)
      eq("add sword fills last slot", bag:add("sword", 2), 1)
      eq("full: no gem", bag:add("gem", 1), 0)
      eq("apples still fit in stack", bag:add("apple", 10), 3)
      check("remove all-or-nothing", not bag:remove("apple", 11))
      check("remove 6", bag:remove("apple", 6))
      eq("left", bag:count("apple"), 4)
      eq("freeSlots", bag:freeSlots(), 1)
      bag:clear()
      eq("key max 1", bag:add("key", 3), 1)
      local chest = core.inventory.new({ id = "chest", categorySlots = { food = 1 } })
      eq("category cap", chest:add("apple", 9), 5)
      eq("all-or-nothing add", chest:add("apple", 1, true), 0)
      chest:add("gem", 150)
      eq("gem stacks 99", chest:slot(3).count, 51)
      chest:move(3, 2)
      eq("full stack: no merge", chest:slot(3).count, 51)
      chest:removeAt(2, 60)
      chest:move(3, 2)
      eq("merge move", chest:slot(2).count, 90)
      eq("merged slot emptied", chest:slot(3), nil)
      chest:move(1, 5)
      eq("swap to empty", chest:slot(5).id, "apple")
      chest:sort()
      eq("sorted compact first", chest:slot(1).id, "apple")
      check("unknown item errors", not pcall(function() chest:add("nope") end))
      bag:add("apple", 1)
      check("use", bag:use("apple"))
      eq("use effect", core.flags.get("hp"), 2)
      eq("consumed", bag:count("apple"), 0)
      check("can't use sword", not bag:use("sword"))
      local gained = 0 core.events.on("item_gained", function(d) gained += d.count end)
      bag:add("key", 1) bag:remove("key") bag:add("key", 1)
      eq("events", gained, 1)
      local ser = chest:serialize()
      local c2 = core.inventory.new({ id = "c2" }) c2:deserialize(ser)
      eq("roundtrip", c2:count("gem"), chest:count("gem"))
      eq("list merges", #chest:list(), 2)
      eq("list category", #chest:list("food"), 1)
    `));
  });

  it("wallet + flags + conditions/effects", async () => {
    noFails(await run(PRE + CONTENT + `
      local w = core.wallet
      eq("start", w.get("gold"), 10)
      check("spend fail", not w.spend("gold", 11))
      check("spend", w.spend("gold", 4))
      eq("after", w.get("gold"), 6)
      w.add("gems", 99) eq("max clamp", w.get("gems"), 5)
      check("canAfford", w.canAfford({ gold = 6, gems = 5 }))
      check("pay fails atomically", not w.pay({ gold = 1, gems = 6 }))
      eq("unchanged", w.get("gold"), 6)
      check("pay", w.pay({ gold = 1, gems = 1 }))
      eq("paid", w.get("gems"), 4)
      w.add("gold", -100) eq("no negative", w.get("gold"), 0)
      core.flags.set("door", "open") core.flags.add("kills", 3)
      check("flag eq", core.check({ flag = "door", eq = "open" }))
      check("flag gte", core.check({ flag = "kills", gte = 3 }))
      check("flag missing", not core.check({ flag = "nope" }))
      check("list = all", not core.check({ { flag = "kills", gte = 3 }, { flag = "kills", gt = 3 } }))
      check("any", core.check({ any = { { flag = "nope" }, { flag = "door" } } }))
      check("not", core.check({ ["not"] = { flag = "nope" } }))
      core.apply({ { give = "apple", count = 2 }, { earn = "gold", amount = 5 }, { set = "x", value = 7 } })
      check("item cond", core.check({ item = "apple", count = 2 }) and not core.check({ item = "apple", count = 3 }))
      check("currency cond", core.check({ currency = "gold", gte = 5 }))
      eq("set effect", core.flags.get("x"), 7)
      core.conditions.registerCondition("level", function(c) return 3 >= c.level end)
      check("custom", core.check({ level = 2 }) and not core.check({ level = 4 }))
      check("unknown condition errors", not pcall(function() core.check({ zzz = 1 }) end))
      check("unknown effect errors", not pcall(function() core.apply({ { zzz = 1 } }) end))
      eq("failing", #core.conditions.failing({ { flag = "door" }, { flag = "nope" }, { item = "apple", count = 9 } }), 2)
    `));
  });

  it("quests: steps, condition + event objectives, rewards, autoStart, achievements", async () => {
    noFails(await run(PRE + CONTENT + `
      local Q = core.quests
      local log = {}
      for _, ev in { "quest_started", "quest_step", "quest_completed", "achievement_unlocked" } do
        core.events.on(ev, function(d) table.insert(log, ev .. ":" .. (d.quest or d.achievement) .. (if d.step then "/" .. d.step else "")) end)
      end
      eq("inactive", Q.status("apples"), "inactive")
      check("sequel locked", not Q.canStart("sequel"))
      check("start", Q.start("apples"))
      check("no double start", not Q.start("apples"))
      eq("step 1", Q.step("apples").id, "collect")
      core.bag:add("apple", 2)
      eq("not yet", Q.step("apples").id, "collect")
      core.bag:add("apple", 1)
      eq("advanced on condition", Q.step("apples").id, "slimes")
      eq("step effects took apples", core.bag:count("apple"), 0)
      core.emit("enemy_defeated", { enemy = "bat" })
      eq("match filters", Q.progress("apples")[1].count, 0)
      core.emit("enemy_defeated", { enemy = "slime" })
      eq("progress", Q.progress("apples")[1].count, 1)
      check("quest cond step", core.check({ quest = "apples", step = "slimes" }))
      core.emit("enemy_defeated", { enemy = "slime" })
      eq("done", Q.status("apples"), "done")
      eq("reward gold", core.wallet.get("gold"), 60)
      check("reward flag", core.flags.get("apples_done") == true)
      eq("sequel autostarted", Q.status("sequel"), "active")
      check("achievement event", core.achievements.isUnlocked("first_blood"))
      check("achievement condition", core.achievements.isUnlocked("hoarder"))
      eq("achievement reward (clamped)", core.wallet.get("gems"), 5)
      core.emit("talked", { npc = "owl" })
      eq("sequel done", Q.status("sequel"), "done")
      eq("log", table.concat(log, " "), "quest_started:apples quest_step:apples/collect quest_step:apples/slimes achievement_unlocked:first_blood achievement_unlocked:hoarder quest_completed:apples quest_started:sequel quest_step:sequel/talk quest_completed:sequel")
      check("fail", Q.reset("apples") == nil and Q.start("apples") and Q.fail("apples") and Q.status("apples") == "failed")
      eq("list done", #Q.list("done"), 1)
    `));
  });

  it("dialog cursor: branches, conditions, locked choices, effects, interpolation, seen", async () => {
    noFails(await run(PRE + CONTENT + `
      core.bag:add("apple", 2)
      local c = core.dialog.open("owl")
      eq("branch to hello", c.nodeId, "hello")
      local v = c:view()
      eq("lines", #v.lines, 2)
      eq("speaker default", v.lines[1].speaker, "Owl")
      eq("interp", v.lines[2].text, "You have 2 apples.")
      eq("speaker override", v.lines[2].speaker, "You")
      c:advance()
      v = c:view()
      eq("choices: hidden secret", #v.choices, 3)
      check("locked shown", v.choices[2].locked)
      check("locked choice refuses", c:choose(2) == false)
      check("seen", core.check({ seen = "owl/ask" }) and core.check({ seen = "owl" }) and not core.check({ seen = "owl/rich" }))
      c:choose(1)
      eq("quest started by choice", core.quests.status("apples"), "active")
      eq("at yes", c.nodeId, "yes")
      eq("node effect", core.flags.get("agreed"), true)
      c:advance()
      check("ended", c.done)
      core.flags.set("hp", 4)
      local c2 = core.dialog.open("owl")
      eq("branch waiting", c2.nodeId, "waiting")
      eq("flag interp", c2:view().lines[1].text, "Still waiting (4 hp)")
      core.flags.set("secret", true)
      core.quests.reset("apples")
      local c3 = core.dialog.open("owl") c3:advance()
      eq("secret visible", #c3:view().choices, 4)
    `));
  });

  it("dialog play() renders through ui.dialog / ui.choice and applies choices", async () => {
    const r = await run(PRE + CONTENT + `
      core.dialog.play("owl", { speed = 0, onEnd = function(c) print("ended " .. table.concat(c.path, ">") .. " paused=" .. tostring(core.pause.isPaused())) end })
      print("paused while open " .. tostring(core.pause.isPaused()))
    `, { steps: 60, each: (g, i) => { if (i % 10 === 5) { if (g.dialogs.current?.options?.length) g.tapScreen(360, 0) ; g.input.tap("jump"); } } });
    expect(r.errs).toEqual([]);
    expect(r.logs).toContain("paused while open true");
    expect(r.logs.some((l) => /^ended root>hello>ask>yes paused=false$/.test(l))).toBe(true);
  });

  it("save round trip + migration + new game", async () => {
    const host = new MemorySaveHost();
    const a = await run(PRE + CONTENT + `
      core.bag:add("apple", 4) core.bag:add("sword")
      core.wallet.add("gold", 5) core.flags.set("met", true) core.quests.start("apples")
      core.emit("enemy_defeated", { enemy = "slime" })
      local chest = core.inventory.new({ id = "chest" }) chest:add("gem", 3)
      local extra = { n = 41 }
      core.save.section("extra", { serialize = function() return { n = extra.n } end, deserialize = function(_, t) extra.n = if t then t.n else 0 end })
      check("save", core.save.save())
      check("exists", core.save.exists())
      core.newGame()
      eq("reset bag", core.bag:count("apple"), 0)
      eq("reset gold", core.wallet.get("gold"), 10)
      eq("reset quest", core.quests.status("apples"), "inactive")
      eq("reset extra", extra.n, 0)
      check("load", core.save.load())
      eq("bag (3 apples went to the quest)", core.bag:count("apple"), 1)
      eq("chest", chest:count("gem"), 3)
      eq("gold", core.wallet.get("gold"), 15)
      eq("flag", core.flags.get("met"), true)
      eq("quest", core.quests.status("apples"), "active")
      eq("extra", extra.n, 41)
      check("achievement kept", core.achievements.isUnlocked("first_blood"))
    `, { save: host });
    noFails(a);
    const saved = host.data.t as { v: number; d: { flags: Record<string, unknown> } };
    expect(saved.v).toBe(1);
    expect(saved.d.flags.met).toBe(true);
    // relaunch with version 2 + migrate hook
    const b = await run(PRE + CONTENT.replace(`save = { key = "t", version = 1 }`, `save = { key = "t", version = 2, migrate = function(d, from) d.flags.migrated_from = from d.wallet.gold = d.wallet.gold * 2 return d end }, autoload = true`) + `
      eq("migrated", core.flags.get("migrated_from"), 1)
      eq("migrated gold", core.wallet.get("gold"), 30)
      eq("bag after relaunch", core.bag:count("apple"), 1)
    `, { save: host });
    noFails(b);
  });

  it("pause clock, cooldowns, pausable timers", async () => {
    const r = await run(PRE + `
      local core = require("@kit/core")
      local cd = core.timers.cooldown(0.5)
      check("ready", cd.use())
      check("not ready", not cd.use())
      local fired = {}
      core.timers.after(0.5, function() table.insert(fired, "after@" .. string.format("%.1f", time())) end)
      local n = 0 core.timers.every(0.25, function() n += 1 end)
      after(0.2, function() core.pause.push("menu") end)
      after(0.7, function() core.pause.pop("menu") print("clock " .. string.format("%.1f", core.pause.clock())) end)
      after(1.6, function() print(table.concat(fired, ",") .. " n=" .. n .. " cd=" .. tostring(cd.ready())) end)
    `, { steps: 100 });
    expect(r.errs).toEqual([]);
    expect(r.logs).toContain("clock 0.2");
    expect(r.logs.find((l) => l.startsWith("after@"))).toMatch(/^after@1\.0 n=4 cd=true$/);
  });

  it("menus build headless: list, grid, confirm, tabs, toast; taps select", async () => {
    const r = await run(PRE + CONTENT + `
      core.bag:add("apple", 3)
      local picked = nil
      local m = core.menus.list({ title = "Pick", items = { { label = "One", onSelect = function() picked = 1 end }, { label = "Two", onSelect = function() picked = 2 print("picked 2") end } } })
      check("open", core.menus.isOpen() and core.pause.isPaused())
      _G_m = m
      after(0.2, function()
        print("menu closed " .. tostring(not m.isOpen()) .. " paused " .. tostring(core.pause.isPaused()))
        local g = core.menus.grid({ title = "Bag", cells = { { label = "Apple", count = 3, onSelect = function() print("cell") end } } })
        local cf = core.menus.confirm("Sure?", function() print("yes") end)
        cf.close() g.close()
        local t = core.menus.tabs({ tabs = { { label = "A", build = function(p) core.menus.text(p, "tab a") end }, { label = "B", build = function(p) core.menus.text(p, "tab b") end } } })
        t.select(2) t.close()
        core.menus.toast("hi")
        print("all closed " .. tostring(not core.menus.isOpen()))
      end)
    `, { steps: 30, each: (g, i) => { if (i === 3) { const btn = [...g.world.walk()].find((e) => e.type === "UIButton" && e.get<string>("text") === "Two"); const [x, y, w, h] = g.uiRect(btn!); g.tapScreen(x + w / 2, y + h / 2); } } });
    noFails(r);
    expect(r.logs).toContain("picked 2");
    expect(r.logs).toContain("menu closed true paused false");
    expect(r.logs).toContain("all closed true");
  });
});

// ---------- example package end-to-end (games/examples/kit-foundation) ----------
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const EX = join(__dirname, "../../../games/examples/kit-foundation");

describe("kit-foundation example", () => {
  const center = (g: Game, id: string) => { const [x, y, w, h] = g.uiRect(g.world.byId.get(id)!); return [x + w / 2, y + h / 2] as const; };
  const tapUI = (g: Game, id: string) => { const [x, y] = center(g, id); return g.tapScreen(x, y); };
  const tapWorld = (g: Game, id: string) => g.tapEntity(id);
  const steps = (g: Game, n: number) => { for (let i = 0; i < n; i++) g.step(); };
  const advanceDialogs = (g: Game, choose?: number) => {
    for (let i = 0; i < 40 && g.dialogs.current; i++) {
      const d = g.dialogs.current;
      if (d.options?.length && choose) { for (let k = 1; k < choose; k++) { g.input.tap("move_down" as never); } }
      g.input.tap("jump"); steps(g, 3);
    }
  };
  const findButton = (g: Game, text: string) => [...g.world.walk()].find((e) => e.type === "UIButton" && e.get<string>("text").startsWith(text));

  it("data files match the kit schemas (top-level keys + required)", () => {
    const schemaFor: Record<string, string> = { items: "core/schemas/item", quests: "core/schemas/quest", dialog: "core/schemas/dialog", achievements: "core/schemas/achievement", skills: "progression/schemas/skill" };
    for (const [kind, sp] of Object.entries(schemaFor)) {
      const schema = JSON.parse(readFileSync(join(__dirname, `../../../kits/${sp}.schema.json`), "utf8"));
      for (const f of readdirSync(join(EX, "data", kind))) {
        const d = JSON.parse(readFileSync(join(EX, "data", kind, f), "utf8"));
        for (const k of Object.keys(d)) expect(Object.keys(schema.properties), `${kind}/${f}: ${k}`).toContain(k);
        for (const r of schema.required) expect(d, `${kind}/${f} requires ${r}`).toHaveProperty(r);
      }
    }
  });

  it("plays end to end: new game → quest via dialog → apples → slimes → skill → save → continue", async () => {
    const pkg = await Package.fromDir(EX);
    const host = new MemorySaveHost();
    const g = await Game.load(pkg, { save: host });
    steps(g, 30);
    expect(g.world.byId.get("btn_continue")!.get("visible")).toBe(false);
    tapUI(g, "btn_new");
    steps(g, 60);
    expect(g.scenePath).toBe("scenes/garden.scene.json");
    // owl: hello → ask → choose "Sure thing!"
    tapWorld(g, "owl"); steps(g, 2);
    advanceDialogs(g, 1);
    steps(g, 5);
    const save1 = () => (host.data.owl_garden as { d: Record<string, any> } | undefined)?.d;
    // pick apples (cooldown 1.2 s per tree)
    for (const t of ["tree_1", "tree_2", "tree_3"]) { tapWorld(g, t); steps(g, 3); }
    steps(g, 10);
    expect(g.world.byId.get("hud_quest")!.get<string>("text")).toContain("Bring them");
    tapWorld(g, "owl"); steps(g, 2);
    advanceDialogs(g);
    steps(g, 10);
    // slimes: 3 hp, 1 dmg (crits may double) → keep tapping
    for (let i = 0; i < 40; i++) { tapWorld(g, "slime"); steps(g, 8); if (i % 4 === 3) steps(g, 70); }
    steps(g, 120);
    const quest = g.world.byId.get("hud_quest")!.get<string>("text");
    expect(quest).toBe("All quests done!");
    // skills menu: unlock the first available skill
    tapUI(g, "btn_skills"); steps(g, 3);
    const strong = findButton(g, "Strong Arm");
    expect(strong).toBeTruthy();
    { const [x, y, w, h] = g.uiRect(strong!); g.tapScreen(x + w / 2, y + h / 2); }
    steps(g, 3);
    findButton(g, "Close") && (() => { const [x, y, w, h] = g.uiRect(findButton(g, "Close")!); g.tapScreen(x + w / 2, y + h / 2); })();
    steps(g, 3);
    // bag + journal open/close
    tapUI(g, "btn_bag"); steps(g, 3); { const c = findButton(g, "Close")!; const [x, y, w, h] = g.uiRect(c); g.tapScreen(x + w / 2, y + h / 2); } steps(g, 3);
    tapUI(g, "btn_quests"); steps(g, 3); { const c = findButton(g, "Awards")!; const [x, y, w, h] = g.uiRect(c); g.tapScreen(x + w / 2, y + h / 2); } steps(g, 3);
    { const c = findButton(g, "Close")!; const [x, y, w, h] = g.uiRect(c); g.tapScreen(x + w / 2, y + h / 2); } steps(g, 3);
    tapUI(g, "btn_menu"); steps(g, 60);
    expect(g.scenePath).toBe("scenes/title.scene.json");
    expect(g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
    const d = save1()!;
    expect(d.quests.apple_pie.s).toBe("done");
    expect(d.quests.slime_trouble.s).toBe("done");
    expect(d.progression.skills.r.strong_arm).toBe(1);
    expect(d.achievements.u.first_pop).toBe(true);
    expect(d.inventories.bag.some((s: unknown) => Array.isArray(s) && s[0] === "gem")).toBe(true);
    expect(d.wallet.gold).toBeGreaterThanOrEqual(45);
    g.dispose();
    // relaunch: Continue restores everything
    const g2 = await Game.load(pkg, { save: host });
    steps(g2, 30);
    expect(g2.world.byId.get("btn_continue")!.get("visible")).toBe(true);
    tapUI(g2, "btn_continue"); steps(g2, 60);
    expect(g2.scenePath).toBe("scenes/garden.scene.json");
    expect(g2.world.byId.get("hud_quest")!.get<string>("text")).toBe("All quests done!");
    expect(g2.world.byId.get("hud_gold")!.get<string>("text")).toBe(`Gold ${d.wallet.gold}`);
    expect(g2.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
  });
});
