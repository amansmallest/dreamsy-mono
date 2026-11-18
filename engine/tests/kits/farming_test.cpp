// farming kit: field (growth, watering, sprinklers), economy (shipping, shops, animals, collections),
// villagers (schedules, friendship), save per day, the example package (Mossbell Farm) pacing sim and
// an end-to-end playtest. Port of engine-web/test/kits/farming.test.ts (same numbers and thresholds).
#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kExample = "games/examples/kit-farming";

// A finished run of a one-script test game (TS run()).
struct Run {
  Game g;
  std::vector<std::string> errs;
  std::vector<std::string> logs;  // print() texts without the "[validate]" lines
};

struct RunOptions {
  int steps = 2;
  Json save = Json::object_value();
  double budget_ms = budget(250);
};

// TS run(): a package with the farming kit and `script` as its only client script.
Run run(const std::string& script, const RunOptions& o = {}) {
  FileMap files = {
      {"dreamsy.toml", manifest(R"("farming")", "scenes/main.scene.json", "portrait")},
      {"scenes/main.scene.json", empty_scene("world")},
      {"scripts/client/main.luau", script},
  };
  script::HostOptions opts;
  opts.save = o.save;
  opts.budget_ms = o.budget_ms;
  Run r{start(files, opts), {}, {}};
  r.g.step(o.steps);
  r.errs = r.g.errors();
  for (const std::string& l : r.g.logs())
    if (l.rfind("[validate]", 0) != 0) r.logs.push_back(l);
  return r;
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

// check()/eq() helpers, the kit, a small hand-made content set and newFarm().
const std::string kPre = R"LUA(
local fails = 0
local function check(name, c, extra) if c then print("ok " .. name) else fails += 1 print("FAIL " .. name .. " " .. tostring(extra)) end end
local function eq(name, a, b) check(name, a == b, tostring(a) .. " ~= " .. tostring(b)) end
local Farming = require("@kit/farming")
local core = require("@kit/core")
local CONTENT = {
  config = { startGold = 100, seasons = { { id = "spring", name = "Spring", days = 4 }, { id = "summer", name = "Summer", days = 4 } },
             weather = { default = { sunny = 1 } }, weatherFixed = { spring_3 = "rain" },
             energy = { max = 20, costs = { till = 2, water = 1 } },
             locations = { house = { x = 0, y = 0, links = { "road" } }, road = { x = 100, y = 0, links = { "house", "square" } }, square = { x = 100, y = 100, links = { "road" } } },
             villagerSpeed = 2 },
  crops = {
    radish = { name = "Radish", seasons = { "spring" }, stages = { 1, 1 }, price = 40, seed = { price = 10 } },
    bean = { name = "Bean", seasons = { "spring", "summer" }, stages = { 1, 2 }, regrow = 2, price = 25, seed = { price = 30 } },
    melon = { name = "Melon", seasons = { "summer" }, stages = { 2, 2 }, price = 200, seed = { price = 60 } },
  },
  animals = { hen = { name = "Hen", building = "coop", price = 50, product = "egg", productPrice = 30, matureDays = 1, feed = "hay" } },
  villagers = {
    ada = { name = "Ada", home = "house", loves = { "melon" }, likes = { "category:crop" }, hates = { "hay" },
            birthday = { season = "spring", day = 2 },
            schedule = { default = { { 360, "house" }, { 600, "square" }, { 1200, "house" } }, rain = { { 360, "house" } } },
            lines = { default = { "Hi." }, hearts_1 = { "Good to see you!" } },
            heartEvents = { { hearts = 1, dialog = "ada_h1" } } },
  },
  festivals = { fair = { name = "Fair", season = "spring", day = 4, start = 540, ["end"] = 840, location = "square", rewards = { { earn = "gold", amount = 7 } } } },
  recipes = { sprinkler = { output = "sprinkler", inputs = { ore = 2 }, data = { placeable = true, sprinkler = { area = 4 } } },
              fert = { output = "fert", inputs = { hay = 1 }, data = { fertilizer = { quality = 2, speed = 1 } } } },
  shops = { store = { name = "Store", stock = { { item = "radish_seeds" }, { item = "bean_seeds" }, { item = "melon_seeds" }, { animal = "hen" }, { item = "hay", price = 5 } } } },
  collections = { museum = { name = "Museum", items = { "radish", "bean" }, rewards = { ["1"] = { { earn = "gold", amount = 1 } }, all = { { set = "museum_done" } } } },
                  shipped = { name = "Shipped", auto = "shipped", items = { "radish", "bean", "melon" } } },
}
local UPGRADES = { { id = "big_coop", name = "Big Coop", cost = { gold = 100 }, mods = { { stat = "coop_capacity", add = 4 } } },
                   { id = "can2", name = "Copper Can", cost = { gold = 50 }, mods = { { stat = "water_area", add = 2 } } } }
core.setup({ save = { key = "t", version = 1 }, items = {} })
local function newFarm(o) o = o or {} o.upgrades = o.upgrades or UPGRADES o.autosave = false return Farming.new(CONTENT, o) end
)LUA";

std::string first_with(const std::vector<std::string>& logs, std::string_view prefix) {
  for (const std::string& l : logs)
    if (l.rfind(prefix, 0) == 0) return l;
  return "";
}

}  // namespace

TEST_SUITE("kit farming") {

// ---------------------------------------------------------------- field

TEST_CASE("farming: field: growth timing, watering, stages, regrow, rain, season death") {
  no_fails(run(kPre + R"LUA(
      local f = newFarm()
      core.bag:add("radish_seeds", 3) core.bag:add("bean_seeds", 2)
      check("till", f:till(0, 0)) eq("energy after till", f.energy, 18)
      check("plant", f:plant(0, 0, "radish_seeds")) eq("seeds left", core.bag:count("radish_seeds"), 2)
      eq("stage 1", f:stage(f:plot(0, 0)), 1)
      f:sleep() eq("unwatered: no growth", f:plot(0, 0).days, 0) eq("day 2", f.day, 2)
      check("water", f:water(0, 0)) eq("energy after water", f.energy, 19)
      local ok, why = f:water(0, 0) eq("double water", why, "already")
      f:sleep() eq("grew", f:plot(0, 0).days, 1) eq("stage 2", f:stage(f:plot(0, 0)), 2) check("not ready", not f:isReady(f:plot(0, 0)))
      eq("day 3 rain", f.weather, "rain") check("rain watered", f:plot(0, 0).watered)
      f:sleep() check("ready", f:isReady(f:plot(0, 0)))
      local ok2, n = f:harvest(0, 0) check("harvest", ok2) check("got radish", core.bag:count("radish") >= 1) eq("plot emptied", f:plot(0, 0).crop, nil)
      -- regrow: bean (1 + 2 days, regrow 2) and season death
      f:till(1, 0) f:plant(1, 0, "bean_seeds")
      check("out of season", select(2, f:plant(0, 0, "melon_seeds")) ~= nil)
      f:till(2, 0) f:plant(2, 0, "radish_seeds")
      f:water(1, 0) f:water(2, 0)
      f:sleep() -- -> summer day 1: radish dies, bean survives
      eq("summer", f:seasonId(), "summer")
      check("radish died", f:plot(2, 0).dead) check("bean alive", not f:plot(1, 0).dead)
      local cok = f:harvest(2, 0) check("clear dead", cok) eq("cleared", f:plot(2, 0).crop, nil)
      for i = 1, 2 do f:water(1, 0) f:sleep() end
      check("bean ready", f:isReady(f:plot(1, 0)))
      f:harvest(1, 0) eq("regrow keeps crop", f:plot(1, 0).crop, "bean") eq("regrow days", f:plot(1, 0).days, 1)
      check("melon too late this season", not f:canMature("melon"))
      -- smart tap
      core.bag:add("melon_seeds", 1)
      local a1, act1 = f:smart(5, 5) eq("smart till", act1, "till")
      local a2, act2 = f:smart(5, 5, "melon_seeds") eq("smart plant", act2, "plant")
      local a3, act3 = f:smart(5, 5) eq("smart water", act3, "water")
      local a4, act4 = f:smart(5, 5) eq("smart none", act4, "none")
      -- tired
      f.energy = 1 local tok, twhy = f:till(9, 9) eq("tired", twhy, "tired")
    )LUA"));
}

TEST_CASE("farming: field: sprinklers, fertilizer speed, upgraded watering can") {
  no_fails(run(kPre + R"LUA(
      local f = newFarm()
      core.bag:add("ore", 2) core.bag:add("hay", 1) core.bag:add("radish_seeds", 5)
      check("craft sprinkler", f:craft("sprinkler")) check("craft fert", f:craft("fert"))
      eq("missing", select(2, f:canCraft("sprinkler")), "missing")
      check("place", f:place(3, 3, "sprinkler"))
      f:till(4, 3) f:plant(4, 3, "radish_seeds")
      check("fertilize", f:fertilize(4, 3, "fert"))
      f:water(4, 3) f:sleep() check("sprinkler watered", f:plot(4, 3).watered) eq("speed fert grows 2/day", f:plot(4, 3).days, 2)
      check("ready early", f:isReady(f:plot(4, 3)))
      core.wallet.set("gold", 100)
      check("buy can", f:buyUpgrade("can2")) eq("water area 3", f:stat("water_area"), 3)
      f:till(0, 6) f:till(1, 6) f:till(2, 6)
      local ok, n = f:water(1, 6) eq("watered row of 3", n, 3)
    )LUA"));
}

// ---------------------------------------------------------------- economy

TEST_CASE("farming: economy: shipping income paid at sleep, shops, animals, collections") {
  no_fails(run(kPre + R"LUA(
      local f = newFarm()
      eq("start gold", core.wallet.get("gold"), 100)
      check("buy seeds", f:buy("store", "radish_seeds", 2)) eq("paid", core.wallet.get("gold"), 80)
      local st = f:stock("store") local names = {} for _, r in st do names[r.item or r.animal] = r end
      check("melon hidden in spring", names.melon_seeds == nil) check("bean listed", names.bean_seeds ~= nil)
      core.bag:add("radish", 3)
      eq("ship", f:ship("radish"), 3) eq("bin value", f:binValue(), 120) eq("not paid yet", core.wallet.get("gold"), 80)
      local rep = f:sleep() eq("earned", rep.earned, 120) eq("paid", core.wallet.get("gold"), 200)
      eq("income day1", f.income[1], 120) eq("shipped collection", (f:collectionProgress("shipped")), 1)
      -- animals
      check("buy hen", f:buy("store", "hen")) eq("hens", f:animalCount("coop"), 1)
      f:buy("store", "hay", 1)
      local uid = f.animals[1].uid
      check("feed", f:feed(uid)) check("pet", f:pet(uid))
      f:sleep() check("egg ready", f.animals[1].ready ~= nil)
      check("collect", f:collect(uid)) eq("egg in bag", core.bag:count("egg") + core.bag:count("egg_large"), 1)
      -- capacity + upgrade
      core.wallet.set("gold", 1000)
      for i = 1, 3 do f:buyAnimal("hen") end
      eq("coop full", select(2, f:buyAnimal("hen")), "full")
      check("upgrade coop", f:buyUpgrade("big_coop")) eq("capacity 8", f:capacity("coop"), 8) check("buy 5th", f:buyAnimal("hen"))
      -- museum
      core.bag:add("bean", 1) core.bag:add("radish", 1)
      local g0 = core.wallet.get("gold")
      check("donate", f:donate("museum", "radish")) eq("reward 1", core.wallet.get("gold"), g0 + 1)
      eq("dup", select(2, f:donate("museum", "radish")), "already")
      check("donate 2", f:donate("museum", "bean")) check("all reward", core.flags.get("museum_done"))
    )LUA"));
}

// ---------------------------------------------------------------- villagers

TEST_CASE("farming: villagers: schedules follow the location graph; rain + festival overrides") {
  no_fails(run(kPre + R"LUA(
      local f = newFarm()
      local w = f:where("ada", 400) eq("home morning", w.loc, "house") eq("x0", w.x, 0)
      w = f:where("ada", 625) check("walking", w.moving) eq("on road leg", w.y, 0) eq("x 50", w.x, 50)
      w = f:where("ada", 660) eq("turned the corner", w.x, 100) eq("y 20", w.y, 20)
      w = f:where("ada", 800) eq("arrived", w.loc, "square") check("still", not w.moving) eq("y", w.y, 100)
      f:sleep() f:sleep() -- day 3 = rain
      eq("rain", f.weather, "rain") eq("rain schedule", f:where("ada", 800).loc, "house")
      f:sleep() -- day 4 = festival
      check("festival today", f:festivalToday() ~= nil) eq("weather sunny on festival", f.weather, "sunny")
      eq("at festival", f:where("ada", 700).loc, "square")
      eq("home after", f:where("ada", 1000).loc, "house")
      f.minute = 600 local g0 = core.wallet.get("gold")
      check("attend", f:attendFestival()) eq("festival reward", core.wallet.get("gold"), g0 + 7)
      eq("once", select(2, f:attendFestival()), "already")
    )LUA"));
}

TEST_CASE("farming: villagers: friendship: talk once a day, gift tastes, birthday, hearts, heart events") {
  no_fails(run(kPre + R"LUA(
      local f = newFarm()
      core.bag:add("radish", 3) core.bag:add("hay", 2) core.bag:add("melon", 1)
      local t = f:talk("ada") check("first talk", t.first) eq("talk pts", f:friend("ada").points, 20)
      t = f:talk("ada") check("second talk not first", not t.first) eq("no extra", f:friend("ada").points, 20)
      eq("hearts 0", f:hearts("ada"), 0)
      f:sleep() -- day 2 = birthday
      check("birthday", f:isBirthday("ada"))
      local ok, taste = f:gift("ada", "radish") eq("likes category", taste, "like") eq("birthday x8", f:friend("ada").points, 20 + 45 * 8)
      eq("one gift a day", select(2, f:gift("ada", "melon")), "already")
      eq("hearts 1", f:hearts("ada"), 1)
      local ev, evId = f:pendingHeartEvent("ada") check("heart event pending", ev ~= nil) eq("event dialog", ev.dialog, "ada_h1")
      f:markHeartEvent("ada", ev) check("event seen", f:pendingHeartEvent("ada") == nil)
      t = f:talk("ada") eq("hearts line", t.lines[1], "Good to see you!")
      f:sleep() local _, tt = f:gift("ada", "hay") eq("hate", tt, "hate")
      f:sleep() local _, t3 = f:gift("ada", "melon") eq("love", t3, "love")
    )LUA"));
}

// ---------------------------------------------------------------- save per day

TEST_CASE("farming: save per day: sleep saves; a fresh game loads the farm back at morning") {
  // (the TS version replaces an f:talk("x") placeholder with f:sleep(); this is the replaced script)
  const std::string script = R"LUA(
      local Farming = require("@kit/farming")
      local core = require("@kit/core")
      local f, loaded = Farming.start({ content = {
        config = { startGold = 100, startItems = { radish_seeds = 2 }, seasons = { { id = "spring", days = 10 } }, weather = { default = { sunny = 1 } } },
        crops = { radish = { seasons = { "spring" }, stages = { 1, 1 }, price = 40 } } }, core = { save = { key = "fs", version = 1 } } })
      if not loaded then
        f:till(1, 1) f:plant(1, 1, "radish_seeds") f:water(1, 1)
        core.bag:add("radish", 2) f:ship("radish")
        f:sleep()
      end
      print("state", loaded, f.day, core.wallet.get("gold"), f:plot(1, 1) and f:plot(1, 1).days, core.bag:count("radish_seeds"))
    )LUA";
  Run a = run(script);
  CHECK_MESSAGE(a.errs.empty(), join(a.errs));
  CHECK(first_with(a.logs, "state") == "state\tfalse\t2\t180\t1\t1");
  RunOptions o;
  o.save = a.g.save();  // the same save host across both sessions
  Run b = run(script, o);
  CHECK_MESSAGE(b.errs.empty(), join(b.errs));
  CHECK(first_with(b.logs, "state") == "state\ttrue\t2\t180\t1\t1");
}

// ---------------------------------------------------------------- example package (Mossbell Farm)

TEST_CASE("farming example (Mossbell Farm): pacing sim: income curve over the season, purchases land in order, first harvest early") {
  FileMap files = read_dir(kExample);
  for (auto it = files.begin(); it != files.end();) {
    bool game_script = it->first.rfind("scripts/client/", 0) == 0 || it->first.rfind("scripts/server/", 0) == 0;
    it = game_script ? files.erase(it) : std::next(it);
  }
  files["scripts/client/play.luau"] = "-- (replaced for the sim)";
  files["scripts/client/bal.luau"] = R"LUA(
      local Farming = require("@kit/farming")
      local core = require("@kit/core")
      core.setup({ save = { key = "bal", version = 1 } })
      local r = Farming.balance.run(nil, {})
      local wk = {}
      for i = 1, #r.days, 5 do local t = 0 for j = i, math.min(#r.days, i + 4) do t += r.days[j].earned end table.insert(wk, t) end
      print("income per 5 days " .. table.concat(wk, ", "))
      local p = {} for _, x in r.purchases do table.insert(p, x.what .. "@d" .. x.day) end
      print("purchases " .. table.concat(p, ", "))
      print("firstHarvest d" .. tostring(r.firstHarvestDay) .. " total " .. r.totalEarned .. " final " .. r.finalGold .. " play " .. r.playMinutes .. "min")
      local best = {} for s, c in r.bestCrop do table.insert(best, s .. "=" .. c) end
      print("bestCrop " .. table.concat(best, ","))
      save.set("rep", { first = r.firstHarvestDay, total = r.totalEarned, purchases = #r.purchases, play = r.playMinutes, weeks = wk })
    )LUA";
  script::HostOptions opts;
  opts.budget_ms = budget(5000);  // TS budgetMs
  Game g = start(files, opts);
  g.step();
  std::vector<std::string> shown;
  for (const std::string& l : g.logs())
    if (l.rfind("[validate]", 0) != 0) shown.push_back(l);
  MESSAGE(join(shown));
  CHECK_NO_ERRORS(g);
  g.step();
  J rep = J(&g.save())["rep"];
  REQUIRE(rep.exists());
  CHECK(rep["first"].num() <= 5);
  CHECK(rep["play"].num() >= 60);      // one season ~ 1h20 of play
  CHECK(rep["purchases"].num() >= 3);  // the first upgrades land inside the season; the rest carry into year 2
  // income grows: the last 5 days earn more than the first 5
  std::vector<double> weeks = rep["weeks"].nums();
  REQUIRE(!weeks.empty());
  CHECK(weeks.back() > weeks.front());
}

TEST_CASE("farming example: plays end-to-end headless with zero script errors (dialog, till/plant/water by tap, menus, pass out, next day)" *
          doctest::test_suite("slow")) {
  std::vector<TimelineStep> taps;
  auto tap = [&](double t, double x, double y) {
    TimelineStep s;
    s.t = t;
    s.tap = std::make_pair(x, y);
    taps.push_back(s);
  };
  for (int i = 0; i < 10; ++i) tap(1 + i * 0.3, 360, 700);  // welcome dialog
  const std::vector<std::pair<double, double>> field = {{168, 552}, {216, 552}, {264, 552}, {168, 600}};
  double t = 5;
  for (auto [x, y] : field) tap(t += 1.2, x, y);  // till
  tap(t += 0.5, 152, 180);                         // seeds slot
  for (auto [x, y] : field) tap(t += 0.8, x, y);  // plant
  for (auto [x, y] : field) tap(t += 0.8, x, y);  // water
  tap(t += 1, 360, 414);                           // shipping bin
  tap(t += 2, 653, 180);                           // menu
  tap(t += 1, 360, 971);                           // close
  PlaytestReport r = simulate(read_dir(kExample), taps, 260);
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
  CHECK(contains(J(&r.save).dump(), "farming"));  // passed out at 2 AM -> new day -> saved
  CHECK(r.sfx["till"] > 0);
  CHECK(r.sfx["plant"] > 0);
}

}  // TEST_SUITE
