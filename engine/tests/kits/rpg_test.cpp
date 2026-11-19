// rpg kit: content loading, creatures and battle math, dialog/quests/inventory/save, the overworld,
// a scripted end-to-end run of games/examples/kit-rpg, and the content JSON schemas.
// Port of engine-web/test/kits/rpg.test.ts (same numbers and thresholds).
#include <algorithm>
#include <cmath>
#include <deque>
#include <map>
#include <utility>

#include "kits/kit_test.h"
#include "pkg/text.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kExample = "games/examples/kit-rpg";

// A running game whose save data holds what the snippet stored with save.set("out", ...).
struct Run {
  Game g;
  J out() const { return J(&g.save())["out"]; }
  J save() const { return J(&g.save()); }
};

// TS lua(): the snippet runs as the example's main client script in the world scene, with the kit
// set up (rpg, U = rpg.util, Core = the battle core) and an `out` table it saves at the end.
Run lua(const std::string& body, Json save = Json::object_value(), uint32_t seed = 1, int ticks = 0) {
  script::HostOptions opts;
  opts.seed = seed;
  opts.scene = "scenes/world.scene.json";
  opts.save = std::move(save);
  opts.budget_ms = budget(250);
  Run r{start_dir(kExample,
                  {{"scripts/client/main.luau",
                    "local rpg = require(\"@kit/rpg\")\nrpg.setup()\nlocal U = rpg.util\nlocal Core = require(\"@kit/rpg/battle_core\")\n"
                    "local out = {}\n" + body + "\nsave.set(\"out\", out)\n"}},
                  opts)};
  r.g.step(ticks);
  return r;
}

// ---------------------------------------------------------------- overworld helpers

const world::World& W(const Game& g) { return g.host->world(); }
std::string type_of(const Game& g, world::EntityId e) { return W(g).get(e)->type->name; }

// The player: a Node2D whose first child is a Sprite2D with a hero_ texture.
world::EntityId player_entity(const Game& g) {
  for (world::EntityId e : W(g).walk()) {
    const world::Entity* x = W(g).get(e);
    if (x->type->name != "Node2D" || x->children.empty()) continue;
    const world::Entity* s = W(g).get(x->children[0]);
    if (s && s->type->name == "Sprite2D" && contains(W(g).str(*s, "texture"), "hero_")) return e;
  }
  return {};
}
world::Point player_pos(const Game& g) {
  world::EntityId p = player_entity(g);
  if (p.is_null()) return {-1000, -1000};
  return W(g).vec(*W(g).get(p), "position");
}
std::pair<int, int> cell(const Game& g) {
  world::Point p = player_pos(g);
  return {static_cast<int>(std::floor(p.x / 16)), static_cast<int>(std::floor(p.y / 16))};
}
using Cell = std::pair<int, int>;

// direction -> (axis, value)
std::pair<const char*, double> axis_of(const std::string& dir) {
  if (dir == "up") return {"move_y", -1};
  if (dir == "down") return {"move_y", 1};
  if (dir == "left") return {"move_x", -1};
  return {"move_x", 1};
}
// Hold a direction until the player has moved `n` cells (or `max` ticks); returns cells moved.
int walk(Game& g, const std::string& dir, int n, int max = 400) {
  auto [axis, v] = axis_of(dir);
  int moved = 0, t = 0;
  Cell last = cell(g);
  while (moved < n && t++ < max) {
    g.axis(axis, v);
    g.step();
    Cell now = cell(g);
    if (now != last) {
      ++moved;
      last = now;
    }
  }
  // let the last step finish
  g.axis("move_x", 0);
  g.axis("move_y", 0);
  g.step(20);
  return moved;
}
void face(Game& g, const std::string& dir) {
  auto [axis, v] = axis_of(dir);
  g.axis(axis, v);
  g.step();
  g.axis(axis, 0);
  g.step(3);
}
void press_a(Game& g) {
  g->input().tap("jump");
  g.step(2);
}
// Visible UIText / UIButton texts.
std::vector<std::string> texts(const Game& g) {
  std::vector<std::string> out;
  for (world::EntityId e : W(g).walk()) {
    std::string t = type_of(g, e);
    if ((t == "UIText" || t == "UIButton") && g.visible(e)) out.push_back(W(g).str(*W(g).get(e), "text"));
  }
  return out;
}
bool has_text(const Game& g, const std::string& s) {
  std::vector<std::string> t = texts(g);
  return std::find(t.begin(), t.end(), s) != t.end();
}
const std::optional<ui::DialogState>& dialog(Game& g) { return g->dialogs().dialogs.current; }
// Click through dialogs; `choices` answers choice prompts in order (0-based).
void talk(Game& g, std::deque<int> choices = {}, int max = 3000) {
  int t = 0;
  while (t++ < max) {
    const auto& d = dialog(g);
    if (!d) {
      g.step(4);
      if (!dialog(g)) break;
      continue;
    }
    if (d->choice && d->index == d->lines.size() - 1) {
      int c = 0;
      if (!choices.empty()) {
        c = choices.front();
        choices.pop_front();
      }
      g->dialogs().tap(c);
    } else {
      g->dialogs().tap(-1);
    }
    g.step(3);
  }
}
world::EntityId button(const Game& g, const std::string& text) {
  for (world::EntityId e : W(g).walk())
    if (type_of(g, e) == "UIButton" && g.visible(e) && W(g).str(*W(g).get(e), "text") == text) return e;
  return {};
}
// Tap a kit list row (UIPanel) whose texts include `label`.
bool tap_row(Game& g, const std::string& label) {
  for (world::EntityId e : W(g).walk()) {
    if (type_of(g, e) != "UIPanel" || !g.visible(e)) continue;
    bool hit = false;
    for (world::EntityId c : W(g).get(e)->children)
      if (type_of(g, c) == "UIText" && W(g).str(*W(g).get(c), "text") == label) hit = true;
    if (hit && g->tap_entity(e)) return true;
  }
  return false;
}
const std::vector<std::string> kAttacks = {"Sunbeam", "Comet Rush", "Moonbeam", "Flare Tap", "Star Tap",
                                           "Night Nip", "Shooting Star", "Scorch", "Eclipse Drain"};
// In a battle's action menu: FIGHT, then the first damaging move available.
bool attack(Game& g, const std::vector<std::string>& prefer = kAttacks) {
  world::EntityId fight = button(g, "FIGHT");
  if (fight.is_null()) return false;
  g->press(fight);
  g.step(2);
  for (const std::string& m : prefer)
    if (tap_row(g, m)) return true;
  return false;
}
bool in_battle(const Game& g) {
  if (!button(g, "FIGHT").is_null()) return true;
  std::vector<std::string> t = texts(g);
  bool lv = false;
  for (const std::string& s : t) lv = lv || matches(s, R"(^Lv\d+)");
  return lv && has_text(g, "HP");
}
bool wait_for(Game& g, const std::function<bool()>& pred, int max = 2000) {
  int t = 0;
  while (!pred() && t++ < max) g.step();
  return pred();
}

// Mutable object member (created if missing) / array item of a Json value.
Json& member(Json& obj, const std::string& key) {
  for (auto& m : obj.object)
    if (m.first == key) return m.second;
  obj.set(key, Json());
  return obj.object.back().second;
}

// JSON text with object keys sorted at every level: TS toEqual ignores key order, and Luau
// tables don't keep insertion order.
std::string canon(const Json& v) {
  if (v.type == Json::Type::Array) {
    std::string out = "[";
    for (size_t i = 0; i < v.array.size(); ++i) out += (i ? "," : "") + canon(v.array[i]);
    return out + "]";
  }
  if (v.type == Json::Type::Object) {
    std::map<std::string, std::string> sorted;
    for (const auto& m : v.object) sorted[m.first] = canon(m.second);
    std::string out = "{";
    for (const auto& [k, text] : sorted) out += (out.size() > 1 ? "," : "") + Json::string_value(k).stringify() + ":" + text;
    return out + "}";
  }
  return v.stringify();
}
std::string canon(J v) { return v.raw() ? canon(*v.raw()) : "undefined"; }

const std::string kZero = "{ hp = 0, atk = 0, def = 0, mag = 0, res = 0, spd = 0 }";

// ---------------------------------------------------------------- JSON Schema subset (TS validate)
//
// A port of the test's own small validator (the keywords the rpg schemas use). The shared
// schema_check (kit_test.h) only resolves "#/..." refs inside one file, while these schemas use
// "common.json#/$defs/..." across files, and the TS test asserts this validator's exact messages.
// (Could move to kit_test.h if another kit needs cross-file refs.)

const Json& load_schema(const std::string& file) {
  static std::map<std::string, Json> cache;
  auto it = cache.find(file);
  if (it == cache.end()) it = cache.emplace(file, read_json("kits/rpg/schemas/" + file)).first;
  return it->second;
}

bool js_type(const Json& v, const std::string& t) {
  if (t == "integer") return v.type == Json::Type::Number && std::floor(v.number) == v.number;
  if (t == "number") return v.type == Json::Type::Number;
  if (t == "array") return v.type == Json::Type::Array;
  if (t == "object") return v.type == Json::Type::Object;
  if (t == "string") return v.type == Json::Type::String;
  if (t == "boolean") return v.type == Json::Type::Bool;
  return false;  // typeof never equals anything else
}

void validate(J schema, const Json& value, const Json* root, const std::string& path, std::vector<std::string>& errs) {
  if (!schema.exists() || (schema.is_bool() && schema.b()) || (schema.is_object() && schema.size() == 0)) return;
  if (J ref = schema["$ref"]; ref.is_string()) {
    std::string r = ref.str();
    size_t hash = r.find('#');
    std::string file = r.substr(0, hash), frag = hash == std::string::npos ? "" : r.substr(hash + 1);
    const Json* doc = file.empty() ? root : &load_schema(file);
    J sub(doc);
    for (std::string_view part : pkg::split(frag, '/'))
      if (!part.empty()) sub = sub[std::string(part)];
    validate(sub, value, doc, path, errs);
    return;
  }
  if (J any = schema["anyOf"]; any.is_array()) {
    bool ok = false;
    for (const J& s : any.values()) {
      std::vector<std::string> sub;
      validate(s, value, root, path, sub);
      ok = ok || sub.empty();
    }
    if (!ok) errs.push_back(path + ": matches none of anyOf");
    return;
  }
  if (schema.has("const") && schema["const"].dump() != J(&value).dump()) errs.push_back(path + ": expected " + schema["const"].dump());
  if (J e = schema["enum"]; e.is_array()) {
    bool ok = false;
    std::string list;
    for (const J& x : e.values()) {
      ok = ok || x.dump() == J(&value).dump();
      list += (list.empty() ? "" : "|") + (x.is_string() ? x.str() : x.dump());
    }
    if (!ok) errs.push_back(path + ": " + value.stringify() + " not in " + list);
  }
  if (J t = schema["type"]; t.is_string() && !js_type(value, t.str())) {
    errs.push_back(path + ": expected " + t.str());
    return;
  }
  if (value.type == Json::Type::Number) {
    if (J m = schema["minimum"]; m.is_number() && value.number < m.num()) errs.push_back(path + ": < " + m.dump());
    if (J m = schema["maximum"]; m.is_number() && value.number > m.num()) errs.push_back(path + ": > " + m.dump());
  }
  if (value.type == Json::Type::String) {
    if (J p = schema["pattern"]; p.is_string() && !matches(value.string, p.str()))
      errs.push_back(path + ": \"" + value.string + "\" !~ " + p.str());
    if (J m = schema["maxLength"]; m.is_number() && m.num() > 0 && static_cast<double>(value.string.size()) > m.num())
      errs.push_back(path + ": too long");
  }
  if (value.type == Json::Type::Array) {
    if (J m = schema["minItems"]; m.is_number() && static_cast<double>(value.array.size()) < m.num())
      errs.push_back(path + ": fewer than " + m.dump() + " items");
    if (J m = schema["maxItems"]; m.is_number() && static_cast<double>(value.array.size()) > m.num())
      errs.push_back(path + ": more than " + m.dump() + " items");
    for (size_t i = 0; i < value.array.size(); ++i) {
      J item = schema["prefixItems"][i];
      validate(item.exists() ? item : schema["items"], value.array[i], root, path + "[" + std::to_string(i) + "]", errs);
    }
  } else if (value.type == Json::Type::Object) {
    J obj(&value);
    for (const J& r : schema["required"].values())
      if (!obj.has(r.str())) errs.push_back(path + ": missing \"" + r.str() + "\"");
    J extra = schema["additionalProperties"];
    for (const auto& m : value.object) {
      if (J p = schema["properties"][m.first]; p.truthy()) validate(p, m.second, root, path + "." + m.first, errs);
      else if (extra.is_bool() && !extra.b()) errs.push_back(path + ": unknown key \"" + m.first + "\"");
      else if (extra.is_object()) validate(extra, m.second, root, path + "." + m.first, errs);
    }
  }
}
std::vector<std::string> validate(const std::string& schema_file, const Json& value) {
  const Json& s = load_schema(schema_file);
  std::vector<std::string> errs;
  validate(J(&s), value, &s, "$", errs);
  return errs;
}

}  // namespace

TEST_SUITE("kit rpg") {

// ---------------------------------------------------------------- content

TEST_CASE("rpg: content: loads every content kind with no cross-reference issues") {
  Run r = lua(R"(
      out.issues = rpg.content.issues
      out.counts = {}
      for _, k in rpg.content.KINDS do out.counts[k] = U.count(rpg.content[k]) end
      out.types = U.keys(rpg.content.types)
    )");
  CHECK_NO_ERRORS(r.g);
  J o = r.out();
  CHECK(o["issues"].values().size() == 0);
  CHECK(o["counts"]["creatures"].num() == 8);
  CHECK(o["counts"]["moves"].num() == 12);
  CHECK(o["counts"]["quests"].num() == 2);
  CHECK(o["counts"]["maps"].num() == 5);
  CHECK(o["counts"]["trainers"].num() == 3);
  CHECK(o["counts"]["shops"].num() == 1);
  CHECK(o["types"].strs() == std::vector<std::string>{"moon", "star", "sun"});
}

TEST_CASE("rpg: content: reports broken references") {
  Run r = lua(R"(
      rpg.content.add("creatures", "bad", { name = "Bad", types = { "void" }, learnset = { { level = 1, move = "nope" } }, evolution = { into = "ghost", level = 3 } })
      out.issues = rpg.content.validate()
    )");
  std::string issues = join(r.out()["issues"].strs());
  CHECK(matches(issues, R"(creature bad: unknown type "void")"));
  CHECK(matches(issues, R"(learnset move "nope" does not exist)"));
  CHECK(matches(issues, R"(evolves into unknown creature "ghost")"));
}

// ---------------------------------------------------------------- creatures, battle math

TEST_CASE("rpg: creatures, battle math: stat formulas, XP curves and level-up learning") {
  Run r = lua(R"(
      local C = rpg.creatures
      local m = C.create("sunnip", 10, nil, { genes = )" + kZero + R"( })
      out.stats = m.stats
      out.xp = { C.xpForLevel("medium", 10), C.xpForLevel("fast", 10), C.xpForLevel("slow", 10), C.xpForLevel("medium", 1) }
      out.moves10 = {}
      for _, mv in m.moves do table.insert(out.moves10, mv.id) end
      local y = C.create("sunnip", 5, nil, { genes = )" + kZero + R"( })
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
    )");
  CHECK_NO_ERRORS(r.g);
  J o = r.out();
  // floor((2*base + 0) * L / 100) + 5; hp + L + 10
  auto st = [](double b, double L) { return std::floor((2 * b * L) / 100) + 5; };
  CHECK(o["stats"].size() == 6);
  CHECK(o["stats"]["hp"].num() == std::floor((2 * 45 * 10) / 100.0) + 10 + 10);
  CHECK(o["stats"]["atk"].num() == st(52, 10));
  CHECK(o["stats"]["def"].num() == st(43, 10));
  CHECK(o["stats"]["mag"].num() == st(55, 10));
  CHECK(o["stats"]["res"].num() == st(45, 10));
  CHECK(o["stats"]["spd"].num() == st(60, 10));
  CHECK(o["xp"].dump() == "[1000,800,1250,0]");
  CHECK(o["moves10"].strs() == std::vector<std::string>{"flare_tap", "warm_up", "scorch", "sunbeam"});
  CHECK(o["moves5"].num() == 2);
  CHECK(o["levels"].dump() == "[6,7]");
  CHECK(o["learned"].str() == "scorch");
  CHECK(o["evo8"].str() == "none");
  CHECK(o["evo9"].str() == "solarch");
  CHECK(o["evolved"].dump() == R"(["solarch",true])");
}

TEST_CASE("rpg: creatures, battle math: damage formula, STAB, type effectiveness, crits, burn") {
  Run r = lua(R"(
      local C = rpg.creatures
      local a = C.create("sunnip", 20, nil, { genes = )" + kZero + R"( })
      local moth = C.create("mothlet", 20, nil, { genes = )" + kZero + R"( })
      local glim = C.create("glimmet", 20, nil, { genes = )" + kZero + R"( })
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
    )");
  CHECK_NO_ERRORS(r.g);
  J o = r.out();
  J A = o["stats"]["a"], M = o["stats"]["moth"];
  // JS: Math.floor(Math.floor(Math.floor((2 * L) / 5 + 2) * pw * at / df) / 50) + 2
  auto base = [](double L, double pw, double at, double df) {
    return std::floor(std::floor(std::floor((2 * L) / 5 + 2) * pw * at / df) / 50) + 2;
  };
  CHECK(o["vsMoon"].num() == std::floor(base(20, 40, A["atk"].num(), M["def"].num()) * 1.5 * 2));
  // (TS also has `expect(vsStar).toBe(Math.floor(... * 0) || vsStar)`, which is always true; the
  // real check on vsStar is the last one below.)
  CHECK(o["neutralNoStab"].num() == std::floor(base(20, 40, A["atk"].num(), M["def"].num()) * 0.5));
  CHECK(o["crit"].num() == std::floor(base(20, 40, A["atk"].num(), M["def"].num()) * 1.5 * 2 * 1.5));
  CHECK(o["burned"].num() == std::floor(base(20, 40, A["atk"].num(), M["def"].num()) * 1.5 * 2 * 0.5));
  CHECK(o["magicBurned"].num() == o["magic"].num());  // burn only halves physical
  CHECK(o["magic"].num() == std::floor(base(20, 65, A["mag"].num(), M["res"].num()) * 1.5 * 2));
  CHECK(o["eff"].dump() == "[2,0.5,2]");
  CHECK(o["status"].num() == 0);
  CHECK(o["vsStar"].num() < o["vsMoon"].num() / 3);
}

TEST_CASE("rpg: creatures, battle math: accuracy with a seeded RNG: reproducible, ~70% for a 70-accuracy move") {
  Run r = lua(R"(
      local C = rpg.creatures
      local function trial(seed)
        local rng = U.rng(seed)
        local hits = 0
        for i = 1, 600 do
          local me = C.create("mothlet", 30, rng, { genes = )" + kZero + R"(, moves = { "lull" } })
          local foe = C.create("duskmole", 30, rng, { genes = )" + kZero + R"(, moves = { "night_nip" } })
          local b = Core.new({ kind = "wild", rng = rng, player = { party = { me } }, enemy = { party = { foe } } })
          b:submit({ kind = "move", slot = 1 })
          for _, e in b.events do if e.t == "status" and e.status == "sleep" and e.side == 2 then hits += 1 end end
        end
        return hits
      end
      out.a = trial(42) out.b = trial(42) out.c = trial(7)
    )");
  CHECK_NO_ERRORS(r.g);
  J o = r.out();
  CHECK(o["a"].num() == o["b"].num());
  CHECK(o["a"].num() / 600 > 0.64);
  CHECK(o["a"].num() / 600 < 0.76);
  CHECK(o["c"].num() != o["a"].num());
}

TEST_CASE("rpg: creatures, battle math: status effects: burn/poison ticks, sleep blocks actions, stat stages") {
  Run r = lua(R"(
      local C = rpg.creatures
      local rng = U.rng(3)
      local me = C.create("sunnip", 20, rng, { genes = )" + kZero + R"(, moves = { "warm_up" } })
      local foe = C.create("duskmole", 20, rng, { genes = )" + kZero + R"(, moves = { "night_nip" } })
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
    )");
  CHECK_NO_ERRORS(r.g);
  J o = r.out();
  CHECK(o["poisonTick"].num() == std::floor(o["maxhp"].num() / 8));
  CHECK(o["burnTick"].num() == std::floor(o["maxhp"].num() / 16));
  CHECK(o["stage"].num() == 1);
  CHECK(o["sleptNoAttack"].b());
  CHECK(o["stageMults"].dump() == "[2,0.5,0.75]");
}

TEST_CASE("rpg: creatures, battle math: wild battle to the end: XP, level-up events, win; faint forces a switch; losing ends it") {
  Run r = lua(R"(
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
    )");
  CHECK_NO_ERRORS(r.g);
  J o = r.out();
  CHECK(o["result"].str() == "win");
  CHECK(o["xpGain"].num() == o["expectedXp"].num());
  CHECK(o["needSwitch"].b());
  CHECK(o["switched"].num() == 2);
  CHECK(o["r2"].str() == "win");
  CHECK(o["money"].num() == 30 * 40);
  CHECK(o["r3"].str() == "lose");
}

TEST_CASE("rpg: creatures, battle math: catch chance formula and empirical odds; run chance; trainer creatures can't be caught") {
  Run r = lua(R"(
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
    )");
  CHECK_NO_ERRORS(r.g);
  J o = r.out();
  const double cr = 190.0 / 255;
  const double max = o["max"].num(), low = o["low"].num(), full = o["full"].num();
  CHECK_CLOSE(full, (1.0 / 3) * cr, 6);
  CHECK_CLOSE(low, ((3 * max - 2) / (3 * max)) * cr, 6);
  CHECK_CLOSE(o["sleep"].num(), std::min(1.0, low * 2), 6);
  CHECK_CLOSE(o["bright"].num(), std::min(1.0, low * 1.8), 6);
  CHECK(o["rate"].num() > full - 0.035);
  CHECK(o["rate"].num() < full + 0.035);
  CHECK(o["run"].dump() == "[1,0.5,1]");
  CHECK(o["trainerCatch"].is_bool());
  CHECK_FALSE(o["trainerCatch"].b());
  CHECK(o["trainerRunAllowed"].is_bool());
  CHECK_FALSE(o["trainerRunAllowed"].b());
}

TEST_CASE("rpg: creatures, battle math: AI: smart picks the super-effective move; random spreads over usable moves") {
  Run r = lua(R"(
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
    )");
  CHECK_NO_ERRORS(r.g);
  J o = r.out();
  CHECK(o["smartTop"].num() >= 40);  // flare_tap: sun vs moon x2 + STAB (10% runner-up noise)
  CHECK(o["random"].size() == 4);
  for (double n : o["random"].nums()) CHECK(n > 60);
  CHECK(o["struggle"].num() == 0);
  CHECK(o["hook"].num() == 2);
}

TEST_CASE("rpg: creatures, battle math: custom move effects via hooks") {
  Run r = lua(R"(
      local C = rpg.creatures
      rpg.content.add("moves", "gift", { name = "Gift", type = "star", category = "status", pp = 5, effects = { { type = "custom", id = "gift" } } })
      rpg.hooks.moveEffect.gift = function(ctx) ctx.say("A present!") ctx.target.hp = 1 end
      local rng = U.rng(1)
      local b = Core.new({ kind = "wild", rng = rng, player = { party = { C.create("glimmet", 50, rng, { moves = { "gift" } }) } }, enemy = { party = { C.create("duskmole", 10, rng, { moves = { "lull" } }) } } })
      b:submit({ kind = "move", slot = 1 })
      out.hp = b:active(2).hp
      out.said = false
      for _, e in b.events do if e.text == "A present!" then out.said = true end end
    )");
  CHECK_NO_ERRORS(r.g);
  CHECK(r.out()["hp"].num() <= 1);
  CHECK(r.out()["said"].b());
}

// ---------------------------------------------------------------- dialog, quests, inventory, save

TEST_CASE("rpg: dialog, quests, inventory, save: conditions") {
  Run r = lua(R"(
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
    )");
  CHECK_NO_ERRORS(r.g);
  CHECK(r.out()["r"].dump() == "[true,false,false,true,true,true,false,true,true,true,false]");
  CHECK(r.out()["hook"].b());
}

TEST_CASE("rpg: dialog, quests, inventory, save: dialog tree: branches, choices, effects (creature, items, flags, quest start)") {
  Run r = lua(R"(
      rpg.state.reset()
      rpg.runDialog("elder", nil, function(ok) save.set("done", ok) end)
    )");
  REQUIRE(dialog(r.g));
  CHECK(matches(dialog(r.g)->lines[0].text, "^Ah, Nova!"));
  CHECK(dialog(r.g)->lines[0].speaker.value_or("") == "Elder Moss");
  talk(r.g, {1});  // Mothlet
  CHECK_NO_ERRORS(r.g);
  CHECK(r.save()["done"].b());
  // state snapshot through the save API
  Run r2 = lua(R"(
      rpg.state.reset()
      rpg.runDialog("elder", nil, function()
        local s = rpg.state.get()
        save.set("st", { party = #s.party, species = s.party[1] and s.party[1].id, jars = s.bag.star_jar, flag = s.flags.got_starter, q = rpg.quests.state("first_steps") })
        -- second talk takes the "again" branch
        rpg.runDialog("elder", nil, function() end)
      end)
    )");
  talk(r2.g, {2});
  CHECK_NO_ERRORS(r2.g);
  J st = r2.save()["st"];
  CHECK(st.size() == 5);
  CHECK(st["party"].num() == 1);
  CHECK(st["species"].str() == "glimmet");
  CHECK(st["jars"].num() == 5);
  CHECK(st["flag"].b());
  CHECK(st["q"].str() == "active");
}

TEST_CASE("rpg: dialog, quests, inventory, save: quest progression: catch counter -> step -> flag -> completion rewards; item quests consume") {
  Run r = lua(R"(
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
    )");
  CHECK_NO_ERRORS(r.g);
  J o = r.out();
  CHECK(o["s1"].str() == "catch");
  CHECK(o["s2"].str() == "report");
  CHECK(o["state"].str() == "done");
  CHECK(o["reward"].num() == 300);
  CHECK(o["tonics"].num() == 2 + 3);
  CHECK(o["c1"].str() == "return");
  CHECK(o["c2"].str() == "done");
  CHECK(o["charm"].num() == 0);
  CHECK(o["log"].strs() == std::vector<std::string>{"first_steps:active:catch", "first_steps:active:report", "first_steps:done:nil",
                                                    "lost_charm:active:find", "lost_charm:active:return", "lost_charm:done:nil"});
  std::vector<std::string> states;
  for (const J& q : o["qlog"].values()) states.push_back(q["state"].str());
  CHECK(states == std::vector<std::string>{"done", "done"});
}

TEST_CASE("rpg: dialog, quests, inventory, save: inventory: field items, shop buy/sell, party/box") {
  Run r = lua(R"(
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
    )");
  CHECK_NO_ERRORS(r.g);
  J o = r.out();
  CHECK(o["heal"][0].b());
  CHECK(o["hp"].num() == std::min(23.0, o["hp"].num()));
  CHECK(o["noEffect"].is_bool());
  CHECK_FALSE(o["noEffect"].b());
  CHECK(o["buy"][0].b());
  CHECK(o["spent"].num() == 300);
  CHECK(o["locked"].is_bool());
  CHECK_FALSE(o["locked"].b());
  CHECK(o["sell"].dump() == R"([true,"Sold for $75."])");
  CHECK(o["sizes"].dump() == "[6,2]");
  CHECK(o["deposit"].b());
  CHECK(o["withdraw"].b());
}

TEST_CASE("rpg: dialog, quests, inventory, save: save/load round trip across a relaunch (engine save API)") {
  Run first = lua(R"(
      rpg.newGame()
      rpg.giveCreature("sunnip", 7)
      rpg.give("wake_mint", 2)
      rpg.setFlag("x")
      rpg.quests.start("lost_charm")
      rpg.party()[1].hp = 4
      rpg.state.get().playtime = 125.5
      out.ok = rpg.save()
      out.snap = rpg.savefile.snapshot()
    )");
  CHECK_NO_ERRORS(first.g);
  CHECK(first.out()["ok"].b());
  CHECK(first.save()["rpg"].truthy());
  CHECK_FALSE(first.save()["rpg"]["party"][0].has("stats"));  // derived fields are not saved
  // relaunch with the same save data: continue restores everything
  Run r = lua(R"(
      out.has = rpg.hasSave()
      out.ok = rpg.continueGame()
      out.snap = rpg.savefile.snapshot()
      out.hp = rpg.party()[1].hp
      out.maxhp = rpg.party()[1].maxhp
    )",
              first.g.save(), 1, 10);
  CHECK_NO_ERRORS(r.g);
  J o = r.out();
  CHECK(o["has"].b());
  CHECK(o["ok"].b());
  for (const char* k : {"party", "box", "bag", "flags", "money", "player", "seen", "caught", "vars", "nextUid"}) {
    CAPTURE(k);
    CHECK(canon(o["snap"][k]) == canon(first.out()["snap"][k]));
  }
  CHECK(o["snap"]["quests"]["lost_charm"]["state"].str() == "active");
  CHECK(o["snap"]["playtime"].num() == 125);
  CHECK(o["hp"].num() == 4);
  CHECK(o["maxhp"].num() > 4);
  CHECK_FALSE(player_entity(r.g).is_null());
}

// ---------------------------------------------------------------- overworld

namespace {
Run in_town() {
  Run r = lua("rpg.newGame()", Json::object_value(), 1, 5);
  CHECK_NO_ERRORS(r.g);
  return r;
}
}  // namespace

TEST_CASE("rpg: overworld: grid movement is tile-locked and smooth; trees and NPCs block; tap turns in place") {
  Run r = in_town();
  Game& g = r.g;
  CHECK(cell(g) == Cell{9, 12});
  // mid-step the player is between cells, then snaps to the next cell center
  g.axis("move_x", 1);
  g.step(8);
  double mid = player_pos(g).x;
  CHECK(mid > 9 * 16 + 8);
  CHECK(mid < 10 * 16 + 8);
  g.axis("move_x", 0);
  g.step(20);
  CHECK(player_pos(g).x == 10 * 16 + 8);
  CHECK(player_pos(g).y == 12 * 16 + 8);
  // walk right into the tree border: stops at col 15
  walk(g, "right", 10, 300);
  CHECK(cell(g) == Cell{15, 12});
  // row 13 is open, row 14 col 15 is water
  walk(g, "down", 5, 200);
  CHECK(cell(g) == Cell{15, 13});
  CHECK_NO_ERRORS(g);
}

TEST_CASE("rpg: overworld: warps: door into the lodge and back out to the spawn point") {
  Run r = in_town();
  Game& g = r.g;
  walk(g, "left", 1); walk(g, "up", 5);  // (8,7)
  walk(g, "left", 4); walk(g, "up", 1);  // (4,6)
  CHECK(cell(g) == Cell{4, 6});
  walk(g, "up", 1);  // door (4,5)
  g.step(60);
  CHECK(has_text(g, "MENU"));
  CHECK(cell(g) == Cell{6, 7});  // lodge "door" spawn
  walk(g, "down", 1);
  g.step(60);
  CHECK(cell(g) == Cell{4, 6});  // town "from_lodge"
  CHECK_NO_ERRORS(g);
}

TEST_CASE("rpg: overworld: interacting: sign text, elder gives a starter, guard NPC disappears after the flag") {
  Run r = in_town();
  Game& g = r.g;
  walk(g, "up", 3);    // (9,9)
  walk(g, "left", 1);  // (8,9)
  face(g, "up");
  walk(g, "left", 1);  // (7,9)
  face(g, "up");
  press_a(g);
  REQUIRE(dialog(g));
  CHECK(matches(dialog(g)->lines[0].text, "DAWNMERE"));
  talk(g);
  // to the elder at (11,9): stand at (11,10) facing up
  walk(g, "right", 4);  // blocked by the elder -> stops at (10,9)
  walk(g, "down", 1);
  walk(g, "right", 1);
  face(g, "up");
  press_a(g);
  REQUIRE(dialog(g));
  CHECK(dialog(g)->lines[0].speaker.value_or("") == "Elder Moss");
  talk(g, {0});
  g.step(30);
  CHECK_NO_ERRORS(g);
  // the kid blocking the north exit is gone: walk to (8,0) -> Glimmer Path
  walk(g, "left", 3);
  walk(g, "up", 12);
  g.step(80);
  CHECK(contains(join(texts(g), " "), "MENU"));
  CHECK(cell(g).second > 15);  // route1 south spawn (8,19)
  CHECK_NO_ERRORS(g);
}

TEST_CASE("rpg: overworld: ledges hop down only; encounters start wild battles in tagged grass") {
  Run r = lua(R"(
      rpg.newGame()
      rpg.giveCreature("solarch", 30)
      rpg.enterMap("route1", "north")
    )",
              Json::object_value(), 1, 10);
  Game& g = r.g;
  CHECK_NO_ERRORS(g);
  CHECK(cell(g) == Cell{8, 1});
  walk(g, "down", 7);  // (8,8) ... trainer at (12,8) facing left sees the path at row 8
  // the ranger spots us
  wait_for(g, [&] { return dialog(g).has_value(); }, 200);
  REQUIRE(dialog(g));
  CHECK(dialog(g)->lines[0].speaker.value_or("") == "Ranger Kit");
  talk(g);
  CHECK(wait_for(g, [&] { return !button(g, "FIGHT").is_null(); }, 600));
  // win the trainer battle with our strong partner
  int guard = 0;
  while (guard++ < 60) {
    if (!wait_for(g, [&] { return !button(g, "FIGHT").is_null() || !has_text(g, "HP"); }, 900)) break;
    if (button(g, "FIGHT").is_null()) break;
    attack(g);
    g.step(2);
  }
  wait_for(g, [&] { return !has_text(g, "HP"); }, 1500);
  talk(g);
  g.step(60);
  CHECK_NO_ERRORS(g);
  // now hop the ledge at row 9 (from row 8 at col 6 -> row 10)
  walk(g, "left", 2);  // (6,8)
  Cell before = cell(g);
  walk(g, "down", 1);
  CHECK(cell(g) == Cell{before.first, before.second + 2});
  walk(g, "up", 1);  // can't go back up the ledge
  CHECK(cell(g) == Cell{before.first, before.second + 2});
  // tall grass at rows 11-13, cols 1-5: pace until a battle starts
  walk(g, "left", 3);  // (3,10)
  walk(g, "down", 1);
  bool found = false;
  for (int i = 0; i < 60 && !found; ++i) {
    walk(g, i % 2 ? "up" : "down", 1, 60);
    found = in_battle(g);
  }
  CHECK(found);
  CHECK_NO_ERRORS(g);
}

// ---------------------------------------------------------------- example end-to-end

TEST_CASE("rpg: example end-to-end: title -> starter -> route encounter -> battle -> catch -> (grind via save) -> cave -> trial boss -> win") {
  script::HostOptions opts;
  opts.seed = 21;
  opts.budget_ms = budget(250);
  Game g = start_dir(kExample, {}, opts);
  g.step(20);
  CHECK(g->scene() == "scenes/title.scene.json");
  g.press("btn_new");
  g.step(30);
  CHECK(g->scene() == "scenes/world.scene.json");
  // starter from the elder
  walk(g, "up", 2); walk(g, "right", 2); face(g, "up");  // (11,10) below the elder
  press_a(g);
  REQUIRE(dialog(g));
  CHECK(dialog(g)->lines[0].speaker.value_or("") == "Elder Moss");
  talk(g, {0});  // Sunnip
  g.step(30);
  // north to Glimmer Path
  walk(g, "left", 3); walk(g, "up", 12);
  g.step(80);
  CHECK(cell(g).second >= 17);  // Glimmer Path south entrance (8,19)
  // tall grass at the bottom right (rows 16-17, cols 11-15)
  walk(g, "up", 2); walk(g, "right", 3);
  bool caught = false;
  int battles = 0;
  for (int round = 0; round < 40 && !caught; ++round) {
    // pace until an encounter
    for (int i = 0; i < 80 && !in_battle(g); ++i) walk(g, i % 2 ? "up" : "down", 1, 60);
    if (!in_battle(g)) break;
    ++battles;
    // weaken resisted foes with one hit (a Sunnip one-shots Moon creatures), then throw jars
    bool hit = false;
    int guard = 0;
    while (guard++ < 40) {
      if (!wait_for(g, [&] { return !button(g, "FIGHT").is_null() || !has_text(g, "HP"); }, 1200)) break;
      if (button(g, "FIGHT").is_null()) break;
      std::string foe;
      for (const std::string& t : texts(g))
        if (foe.empty() && (t == "Mothlet" || t == "Glimmet" || t == "Sunbeak")) foe = t;
      if (!hit && foe != "Mothlet") {
        attack(g, {"Flare Tap"});
        hit = true;
      } else {
        g->press(button(g, "BAG"));
        g.step(2);
        if (!tap_row(g, "Star Jar")) {
          world::EntityId back = button(g, "BACK");
          if (!back.is_null()) g->press(back);
          g.step(2);
          g->press(button(g, "RUN"));
        }
      }
      g.step(5);
    }
    // scripts/client/main.luau prints on rpg.events.creatureCaught
    for (const std::string& l : g.logs()) caught = caught || matches(l, R"(^caught\s)");
    wait_for(g, [&] { return !has_text(g, "HP") || dialog(g).has_value(); }, 2000);
    talk(g);
    g.step(40);
    if (!caught) g.step(20);  // learn prompts / evolutions may be up; keep going
  }
  CHECK_NO_ERRORS(g);
  MESSAGE("e2e: " << battles << " wild battle(s) until a catch");
  CHECK(battles > 0);
  REQUIRE(caught);
  // save at the menu
  g->press(button(g, "MENU")); g.step(3);
  g->press(button(g, "SAVE")); g.step(3);
  REQUIRE(J(&g.save())["rpg"].truthy());
  Json data = g.save();
  Json& save = member(data, "rpg");
  CHECK(J(&save)["party"].size() >= 2);
  CHECK(J(&save)["quests"]["first_steps"]["step"].num() == 2);  // catch step done
  // "grind": edit the save like a long play session would (levels), stand at the cave's north exit
  Json& lead = member(save, "party").array.at(0);
  lead.set("level", Json::number_value(22));
  lead.set("xp", Json::number_value(22 * 22 * 22));
  lead.set("hp", Json::number_value(999));
  lead.set("moves", parse_json(R"([{"id":"flare_tap","pp":30},{"id":"sunbeam","pp":15},{"id":"scorch","pp":25},{"id":"warm_up","pp":20}])"));
  Json& player = member(save, "player");
  player.set("map", Json::string_value("cave"));
  player.set("x", Json::number_value(8));
  player.set("y", Json::number_value(1));
  player.set("facing", Json::string_value("up"));
  const double money_before = J(&save)["money"].num();
  // relaunch -> continue
  script::HostOptions opts2;
  opts2.seed = 5;
  opts2.save = data;
  opts2.budget_ms = budget(250);
  Game g2 = start_dir(kExample, {}, opts2);
  g2.step(10);
  g2.press("btn_continue");
  g2.step(30);
  CHECK(cell(g2) == Cell{8, 1});
  walk(g2, "up", 1);  // into the trial (own scene)
  g2.step(80);
  CHECK(g2->scene() == "scenes/trial.scene.json");
  CHECK(cell(g2) == Cell{7, 11});
  walk(g2, "up", 1);  // trigger at (7,10)
  wait_for(g2, [&] { return dialog(g2).has_value(); }, 60);
  REQUIRE(dialog(g2));
  CHECK(matches(dialog(g2)->lines[0].text, "The air hums"));
  talk(g2);
  walk(g2, "up", 6);  // to (7,4)
  face(g2, "up");
  press_a(g2);
  wait_for(g2, [&] { return dialog(g2).has_value(); }, 120);  // "!" pops over the trainer first
  REQUIRE(dialog(g2));
  CHECK(dialog(g2)->lines[0].speaker.value_or("") == "Warden Vela");
  talk(g2);
  CHECK(wait_for(g2, [&] { return !button(g2, "FIGHT").is_null(); }, 800));
  int guard = 0;
  while (guard++ < 80) {
    if (!wait_for(g2, [&] { return !button(g2, "FIGHT").is_null() || !has_text(g2, "HP"); }, 1500)) break;
    if (button(g2, "FIGHT").is_null()) break;
    attack(g2);
    g2.step(5);
  }
  wait_for(g2, [&] { return !has_text(g2, "HP"); }, 3000);
  talk(g2);
  g2.step(120);
  CHECK_NO_ERRORS(g2);
  g2->press(button(g2, "MENU")); g2.step(3);
  g2->press(button(g2, "SAVE")); g2.step(3);
  J after = J(&g2.save())["rpg"];
  CHECK(after["flags"]["trial_1"].b());
  CHECK(after["flags"]["beat_warden_vela"].b());
  CHECK(after["money"].num() > money_before);
  CHECK_NO_ERRORS(g2);
}

// ---------------------------------------------------------------- content schemas (kits/rpg/schemas)

TEST_CASE("rpg: schemas: every example content file validates against its schema") {
  const std::vector<std::pair<std::string, std::string>> kinds = {
      {"creatures", "creature.json"}, {"moves", "move.json"}, {"items", "item.json"}, {"trainers", "trainer.json"},
      {"dialog", "dialog.json"},      {"quests", "quest.json"}, {"maps", "map.json"},   {"shops", "shop.json"}};
  FileMap ex = read_dir(kExample);
  std::vector<std::string> errs;
  int n = 0;
  auto check = [&](const std::string& file, const std::string& schema) {
    for (const std::string& e : validate(schema, parse_json(ex.at(file)))) errs.push_back(file + " " + e);
    ++n;
  };
  check("data/rpg.json", "rpg.json");
  check("data/types.json", "types.json");
  for (const auto& [kind, schema] : kinds)
    for (const std::string& f : paths_with(ex, "data/" + kind + "/")) check(f, schema);
  CHECK_MESSAGE(errs.empty(), join(errs));
  CHECK(n > 40);
}

TEST_CASE("rpg: schemas: schemas catch typos and bad values") {
  Json bad = parse_json(
      R"({"name":"X","types":["sun"],"base":{"hp":1,"atk":1,"def":1,"mag":1,"res":1,"spd":1},"learnset":[{"level":1,"move":"a"}],"sprites":{"front":"asset:x"},"catchrate":3})");
  CHECK(validate("creature.json", bad) == std::vector<std::string>{R"($: unknown key "catchrate")"});
  CHECK(matches(join(validate("move.json", parse_json(R"({"name":"A","type":"sun","category":"special","pp":5})")), ","), "category"));
  CHECK(matches(join(validate("map.json", parse_json(R"({"spawns":{"a":[1,2,"north"]}})")), ","), R"(spawns\.a\[2\])"));
}

}  // TEST_SUITE
