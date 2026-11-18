// core kit: every module through real Luau (fsm, events, inventory, wallet, flags, conditions,
// quests, dialog, save, pause/timers, menus), the kit schemas vs the kit-foundation data files, and
// kit-foundation played end to end. Port of engine-web/test/kits/core.test.ts (same numbers).
#include "kits/kit_test.h"
#include "ui/layout.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kExample = "games/examples/kit-foundation";

// A finished run of a one-script test game (TS run()).
struct Run {
  Game g;
  std::vector<std::string> errs;
  std::vector<std::string> logs;  // print() texts without the "[validate]" lines
};

struct RunOptions {
  int steps = 2;
  Json save = Json::object_value();
  FileMap files;
  std::function<void(Game&, int)> each;  // before tick i
};

// TS run(): a package with kits core + progression + juice and `script` as its only client script.
Run run(const std::string& script, RunOptions o = {}) {
  FileMap files = {
      {"dreamsy.toml", manifest(R"("core", "progression", "juice")", "scenes/main.scene.json", "portrait")},
      {"scenes/main.scene.json", empty_scene("world")},
      {"scripts/client/main.luau", script},
  };
  for (const auto& [path, data] : o.files) files[path] = data;
  script::HostOptions opts;
  opts.save = o.save;
  opts.budget_ms = budget(250);
  Run r{start(files, opts), {}, {}};
  r.g.step(o.steps, [&](int i) {
    if (o.each) o.each(r.g, i);
  });
  r.errs = r.g.errors();
  for (const std::string& l : r.g.logs())
    if (l.rfind("[validate]", 0) != 0) r.logs.push_back(l);
  return r;
}

bool has_log(const Run& r, std::string_view text) {
  for (const std::string& l : r.logs)
    if (l == text) return true;
  return false;
}

// TS noFails(): no script errors, no "FAIL ..." line from check()/eq(), and at least one "ok ...".
void no_fails(const Run& r) {
  CHECK_MESSAGE(r.errs.empty(), join(r.errs));
  std::vector<std::string> fails;
  int oks = 0;
  for (const std::string& l : r.logs) {
    if (l.rfind("FAIL", 0) == 0) fails.push_back(l);
    if (l.rfind("ok ", 0) == 0) ++oks;
  }
  CHECK_MESSAGE(fails.empty(), join(fails));
  CHECK(oks > 0);
}

// Assert helpers available inside the scripts: check(name, cond) prints "ok name" / "FAIL name".
const std::string kPre = R"LUA(
local fails = 0
local function check(name, c, extra) if c then print("ok " .. name) else fails += 1 print("FAIL " .. name .. " " .. tostring(extra)) end end
local function eq(name, a, b) check(name, a == b, tostring(a) .. " ~= " .. tostring(b)) end
)LUA";

const std::string kContent = R"LUA(
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
)LUA";

// The center of a UI element's headless rect (TS g.uiRect), in reference px.
std::pair<double, double> ui_center(Game& g, world::EntityId e) {
  ui::Rect r = ui::ui_rect_headless(g->world(), e, g->ref_width(), g->ref_height());
  return {r.x + r.w / 2, r.y + r.h / 2};
}

// Taps the center of a UI element, like a player would (TS tapUI / tapScreen at the rect center).
std::string tap_ui(Game& g, world::EntityId e) {
  auto [x, y] = ui_center(g, e);
  return g.tap(x, y);
}

// The first UIButton whose text starts with `text` (null id if none).
world::EntityId find_button(Game& g, std::string_view text) {
  for (world::EntityId e : g.of_type("UIButton"))
    if (g->world().str(*g->world().get(e), "text").rfind(text, 0) == 0) return e;
  return {};
}

}  // namespace

TEST_SUITE("kit core") {

TEST_CASE("core: loads") {
  Run r = run(R"(local core = require("@kit/core") print("v " .. core.VERSION))");
  CHECK_MESSAGE(r.errs.empty(), join(r.errs));
  CHECK(has_log(r, "v 0.1.0"));
}

TEST_CASE("core: fsm + event bus") {
  no_fails(run(kPre + R"LUA(
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
    )LUA"));
}

TEST_CASE("core: inventory stacking, slot + category + max limits, move/sort/use") {
  no_fails(run(kPre + kContent + R"LUA(
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
    )LUA"));
}

TEST_CASE("core: wallet + flags + conditions/effects") {
  no_fails(run(kPre + kContent + R"LUA(
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
    )LUA"));
}

TEST_CASE("core: quests: steps, condition + event objectives, rewards, autoStart, achievements") {
  no_fails(run(kPre + kContent + R"LUA(
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
    )LUA"));
}

TEST_CASE("core: dialog cursor: branches, conditions, locked choices, effects, interpolation, seen") {
  no_fails(run(kPre + kContent + R"LUA(
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
    )LUA"));
}

TEST_CASE("core: dialog play() renders through ui.dialog / ui.choice and applies choices") {
  RunOptions o;
  o.steps = 60;
  o.each = [](Game& g, int i) {
    if (i % 10 == 5) {
      const auto& cur = g->dialogs().dialogs.current;
      if (cur && !cur->options.empty()) g.tap(360, 0);
      g->input().tap("jump");
    }
  };
  Run r = run(kPre + kContent + R"LUA(
      core.dialog.play("owl", { speed = 0, onEnd = function(c) print("ended " .. table.concat(c.path, ">") .. " paused=" .. tostring(core.pause.isPaused())) end })
      print("paused while open " .. tostring(core.pause.isPaused()))
    )LUA",
              o);
  CHECK_MESSAGE(r.errs.empty(), join(r.errs));
  CHECK(has_log(r, "paused while open true"));
  bool ended = false;
  for (const std::string& l : r.logs) ended = ended || matches(l, R"(^ended root>hello>ask>yes paused=false$)");
  CHECK_MESSAGE(ended, join(r.logs));
}

TEST_CASE("core: save round trip + migration + new game") {
  Run a = run(kPre + kContent + R"LUA(
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
    )LUA");
  no_fails(a);
  J saved = J(&a.g.save())["t"];
  CHECK(saved["v"].num() == 1);
  CHECK(saved["d"]["flags"]["met"].b());
  // relaunch with version 2 + migrate hook (same save data, like the shared MemorySaveHost)
  std::string content2 = kContent;
  const std::string from = R"(save = { key = "t", version = 1 })";
  content2.replace(content2.find(from), from.size(),
                   R"(save = { key = "t", version = 2, migrate = function(d, from) d.flags.migrated_from = from d.wallet.gold = d.wallet.gold * 2 return d end }, autoload = true)");
  RunOptions o;
  o.save = a.g.save();
  no_fails(run(kPre + content2 + R"LUA(
      eq("migrated", core.flags.get("migrated_from"), 1)
      eq("migrated gold", core.wallet.get("gold"), 30)
      eq("bag after relaunch", core.bag:count("apple"), 1)
    )LUA",
               o));
}

TEST_CASE("core: pause clock, cooldowns, pausable timers") {
  RunOptions o;
  o.steps = 100;
  Run r = run(kPre + R"LUA(
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
    )LUA",
              o);
  CHECK_MESSAGE(r.errs.empty(), join(r.errs));
  CHECK(has_log(r, "clock 0.2"));
  std::string after_line;
  for (const std::string& l : r.logs)
    if (after_line.empty() && l.rfind("after@", 0) == 0) after_line = l;
  CHECK_MESSAGE(matches(after_line, R"(^after@1\.0 n=4 cd=true$)"), after_line);
}

TEST_CASE("core: menus build headless: list, grid, confirm, tabs, toast; taps select") {
  RunOptions o;
  o.steps = 30;
  o.each = [](Game& g, int i) {
    if (i != 3) return;
    world::EntityId btn = find_button(g, "Two");
    REQUIRE(g->world().alive(btn));
    tap_ui(g, btn);
  };
  Run r = run(kPre + kContent + R"LUA(
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
    )LUA",
              o);
  no_fails(r);
  CHECK(has_log(r, "picked 2"));
  CHECK(has_log(r, "menu closed true paused false"));
  CHECK(has_log(r, "all closed true"));
}

// ---------- example package end-to-end (games/examples/kit-foundation) ----------

TEST_CASE("kit-foundation example: data files match the kit schemas (top-level keys + required)") {
  const std::vector<std::pair<std::string, std::string>> schema_for = {
      {"items", "core/schemas/item"},
      {"quests", "core/schemas/quest"},
      {"dialog", "core/schemas/dialog"},
      {"achievements", "core/schemas/achievement"},
      {"skills", "progression/schemas/skill"},
  };
  FileMap pkg = read_dir(kExample);
  for (const auto& [kind, sp] : schema_for) {
    Json schema_json = read_json("kits/" + sp + ".schema.json");
    J schema(&schema_json);
    std::vector<std::string> files = paths_with(pkg, "data/" + kind + "/");
    CHECK(!files.empty());
    for (const std::string& f : files) {
      Json d_json = parse_json(pkg[f]);
      J d(&d_json);
      for (const std::string& k : d.keys()) {
        CAPTURE(f);
        CAPTURE(k);
        CHECK(schema["properties"].has(k));
      }
      for (const std::string& req : schema["required"].strs()) {
        CAPTURE(f);
        CAPTURE(req);
        CHECK(d.has(req));
      }
    }
  }
}

TEST_CASE("kit-foundation example: plays end to end: new game -> quest via dialog -> apples -> slimes -> skill -> save -> continue") {
  script::HostOptions o1;
  o1.budget_ms = budget(250);
  Game g = start_dir(kExample, {}, o1);
  auto steps = [](Game& game, int n) { game.step(n); };
  auto tap_id = [](Game& game, std::string_view id) { return tap_ui(game, game.id(id)); };
  auto tap_world = [](Game& game, std::string_view id) { game->tap_entity(game.id(id)); };
  // TS advanceDialogs: confirm (jump) until no dialog is open; `choose` moves the selection down first.
  auto advance_dialogs = [&](Game& game, int choose = 0) {
    for (int i = 0; i < 40 && game->dialogs().dialogs.current; ++i) {
      const auto& d = *game->dialogs().dialogs.current;
      if (!d.options.empty() && choose)
        for (int k = 1; k < choose; ++k) game->input().tap("move_down");
      game->input().tap("jump");
      steps(game, 3);
    }
  };
  auto tap_button = [](Game& game, std::string_view text) {
    world::EntityId b = find_button(game, text);
    REQUIRE_MESSAGE(game->world().alive(b), "no button " << std::string(text));
    tap_ui(game, b);
  };
  auto text_of = [](Game& game, std::string_view id) { return game->world().str(game.entity(id), "text"); };

  steps(g, 30);
  CHECK_FALSE(g->world().visible(g.entity("btn_continue")));
  tap_id(g, "btn_new");
  steps(g, 60);
  CHECK(g->scene() == "scenes/garden.scene.json");
  // owl: hello -> ask -> choose "Sure thing!"
  tap_world(g, "owl");
  steps(g, 2);
  advance_dialogs(g, 1);
  steps(g, 5);
  // pick apples (cooldown 1.2 s per tree)
  for (const char* t : {"tree_1", "tree_2", "tree_3"}) {
    tap_world(g, t);
    steps(g, 3);
  }
  steps(g, 10);
  CHECK(contains(text_of(g, "hud_quest"), "Bring them"));
  tap_world(g, "owl");
  steps(g, 2);
  advance_dialogs(g);
  steps(g, 10);
  // slimes: 3 hp, 1 dmg (crits may double) -> keep tapping
  for (int i = 0; i < 40; ++i) {
    if (g.alive("slime")) tap_world(g, "slime");  // TS tapEntity ignores a missing entity
    steps(g, 8);
    if (i % 4 == 3) steps(g, 70);
  }
  steps(g, 120);
  CHECK(text_of(g, "hud_quest") == "All quests done!");
  // skills menu: unlock the first available skill
  tap_id(g, "btn_skills");
  steps(g, 3);
  tap_button(g, "Strong Arm");
  steps(g, 3);
  if (g->world().alive(find_button(g, "Close"))) tap_button(g, "Close");
  steps(g, 3);
  // bag + journal open/close
  tap_id(g, "btn_bag");
  steps(g, 3);
  tap_button(g, "Close");
  steps(g, 3);
  tap_id(g, "btn_quests");
  steps(g, 3);
  tap_button(g, "Awards");
  steps(g, 3);
  tap_button(g, "Close");
  steps(g, 3);
  tap_id(g, "btn_menu");
  steps(g, 60);
  CHECK(g->scene() == "scenes/title.scene.json");
  CHECK_NO_ERRORS(g);

  Json save = g.save();  // a copy: the relaunch below starts from it
  J d = J(&save)["owl_garden"]["d"];
  CHECK(d["quests"]["apple_pie"]["s"].str() == "done");
  CHECK(d["quests"]["slime_trouble"]["s"].str() == "done");
  CHECK(d["progression"]["skills"]["r"]["strong_arm"].num() == 1);
  CHECK(d["achievements"]["u"]["first_pop"].b());
  bool gem = false;
  for (J slot : d["inventories"]["bag"].values()) gem = gem || (slot.is_array() && slot[0].str() == "gem");
  CHECK(gem);
  const double gold = d["wallet"]["gold"].num();
  CHECK(gold >= 45);

  // relaunch: Continue restores everything
  script::HostOptions o2;
  o2.save = save;
  o2.budget_ms = budget(250);
  Game g2 = start_dir(kExample, {}, o2);
  steps(g2, 30);
  CHECK(g2->world().visible(g2.entity("btn_continue")));
  tap_id(g2, "btn_continue");
  steps(g2, 60);
  CHECK(g2->scene() == "scenes/garden.scene.json");
  CHECK(text_of(g2, "hud_quest") == "All quests done!");
  CHECK(text_of(g2, "hud_gold") == "Gold " + std::to_string(static_cast<long long>(gold)));
  CHECK_NO_ERRORS(g2);
}

}  // TEST_SUITE
