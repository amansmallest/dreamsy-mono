// Multiplayer offline fallback (docs/runtime.md §4.5): one local player, in-process remote events, room
// state / scores / finish, and mp-duel played solo. Port of the offline parts of
// engine-web/test/net.test.ts.
//
// Not ported: everything that needs two connected games (engine-web's LoopbackRoom: teams, puppet
// replication + interpolation, remote event routing, shared state, mp-duel and racing versus) and
// the netcode client helpers (SnapshotBuffer, ClockSync, room URLs / codes). The C++ engine has no
// network room yet: netcode is slice E8 (docs/engine.md §14.6, §14.10).
#include "kits/kit_test.h"

#include <cmath>
#include <limits>

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kScene = R"({"format": "0", "root": "world", "entities": {
  "world": {"type": "Node2D", "children": ["hero"]},
  "hero": {"type": "Body2D", "tags": ["player"], "props": {"position": [100, 100], "body": "kinematic", "size": [16, 16]},
           "children": ["hero_sprite"], "scripts": ["scripts/client/hero.luau"]},
  "hero_sprite": {"type": "Sprite2D", "props": {"size": [16, 24], "modulate": "#ffffff"}}
}})";

FileMap duel_files() {
  return {
      {"dreamsy.toml",
       "format = \"0\"\nname = \"Duel\"\ndimension = \"2d\"\nentry_scene = \"scenes/main.scene.json\"\n[players]\nmin = 1\nmax = 2\n"
       "[server]\nmode = \"rooms\"\n[style]\npreset = \"pixel\"\npalette = [\"#101020\", \"#3355ff\", \"#ffcc00\", \"#f0f0f0\"]\n"},
      {"scenes/main.scene.json", kScene},
      {"scripts/shared/net.luau", R"(return { hit = remoteEvent("hit"), ping = remoteEvent("ping"), dm = remoteEvent("dm") })"},
      {"scripts/client/hero.luau", R"(
    local net = require("../shared/net")
    local me = script.entity
    room.replicate(me)
    onTick(function(dt)
      me.position = me.position + vec2(input.axis("move_x") * 120 * dt, 0)
    end)
    net.hit:onClient(function(n, who, at) print("hit", n, who and who.name, at and at.x) end)
    net.dm:onClient(function(msg) print("dm", msg) end)
    room.ended:connect(function(r) print("ended", r.winner and r.winner.name, r.team, r.draw, r.reason) end)
    room.stateChanged:connect(function(k, v) print("state", k, v.round) end)
    room.scoreChanged:connect(function(t, v) print("score", if type(t) == "string" then t else t.name, v) end)
    room.avatarSpawned:connect(function(p, e) print("avatar", p.name, p.team, e:hasTag("remote")) end)
  )"},
      {"scripts/server/rules.luau", R"(
    local net = require("../shared/net")
    players.joined:connect(function(p) print("joined", p.name, p.team, p.isLocal) end)
    players.left:connect(function(p) print("left", p.name) end)
    net.ping:onServer(function(from, n) print("ping from", from.name, n, room.isHost) end)
    print("room", room.active, room.code, room.mode, room.isHost, players["local"].name, players["local"].team, #players.all())
  )"},
  };
}

bool has_log(const Game& g, const std::string& line) {
  for (const std::string& l : g.logs())
    if (l == line) return true;
  return false;
}

// TS bot(): steer the local avatar toward the nearest orb (Sprite2D under the root, 26 px wide).
void bot(Game& g) {
  world::World& w = g->world();
  world::EntityId me = w.by_id("hero");
  if (!w.alive(me)) return;
  const world::Point p = w.vec(*w.get(me), "position");
  bool found = false;
  world::Point best;
  double bd = std::numeric_limits<double>::infinity();
  for (world::EntityId e : g.of_type("Sprite2D")) {
    const world::Entity& ent = *w.get(e);
    if (ent.parent != w.root() || w.vec(ent, "size").x != 26) continue;
    const world::Point o = w.vec(ent, "position");
    const double d = std::hypot(o.x - p.x, o.y - p.y);
    if (d < bd) bd = d, best = o, found = true;
  }
  auto steer = [](double delta) { return (delta > 0 ? 1 : delta < 0 ? -1 : 0) * std::min(1.0, std::fabs(delta) / 20); };
  g.axis("move_x", found ? steer(best.x - p.x) : 0);
  g.axis("move_y", found ? steer(best.y - p.y) : 0);
}

}  // namespace

TEST_SUITE("api net") {

TEST_CASE("net: multiplayer: offline fallback (single player, playtests): one local player, in-process events, local finish") {
  FileMap files = duel_files();
  files["scripts/client/zz_test.luau"] = R"(
      after(0.1, function()
        room.addScore(players["local"], 5)
        room.finish(players["local"])
      end))";
  Game g = start(files);
  g.step(12);
  CHECK_NO_ERRORS(g);
  CHECK(has_log(g, "room\tfalse\tnil\tnil\ttrue\tPlayer\tnil\t1"));
  CHECK(has_log(g, "joined\tPlayer\tnil\ttrue"));
  CHECK(has_log(g, "score\tPlayer\t5"));
  CHECK(has_log(g, "ended\tPlayer\tnil\tfalse\tfinish"));
}

TEST_CASE("net: games/examples/mp-duel: plays solo (offline): orbs spawn, the player can win a round") {
  // TS reads g.net.result.winner; the C++ host has no NetSession object, so a test script logs room.ended.
  script::HostOptions o;
  o.seed = 5;
  o.budget_ms = budget(250);
  Game g = start_dir("games/examples/mp-duel",
                     {{"scripts/client/zz_result.luau",
                       R"(room.ended:connect(function(r) print("RESULT", r.winner and r.winner.id, r.draw) end))"}},
                     o);
  auto result = [&] { return g.logs_with("RESULT\t"); };
  for (int i = 0; i < 30 * 40 && result().empty(); i++) {
    bot(g);
    g.step();
  }
  CHECK_NO_ERRORS(g);
  REQUIRE(result().size() == 1);
  CHECK(result()[0] == "local\tfalse");  // winner "local"
}

}  // TEST_SUITE
