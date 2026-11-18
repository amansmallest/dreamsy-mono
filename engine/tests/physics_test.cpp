// Physics (E3): Box2D bodies, events, layers, onFloor, and engine-handled height (z).
// Feel parity with engine-web's Rapier is measured by tests/conformance/run_compare.py --games.
#include <cmath>
#include <cstdio>
#include <map>
#include <memory>
#include <string>

#include "doctest.h"
#include "physics/physics2d.h"
#include "pkg/validate.h"
#include "script/host.h"

using namespace dreamsy;
using namespace dreamsy::world;
using physics::ContactEvent;
using physics::Physics2D;

namespace {

const std::string kRoot = DREAMSY_REPO_ROOT;
constexpr double kDt = 1.0 / 60;

EntityId body(World& w, EntityId parent, const char* type, double x, double y, double sw, double sh, const char* kind = nullptr) {
  auto e = w.create("", type);
  REQUIRE(e.ok());
  w.attach(e.value(), parent);
  Entity& ent = *w.get(e.value());
  w.set_raw(ent, "position", Value::vec(x, y));
  w.set_raw(ent, "size", Value::vec(sw, sh));
  if (kind) w.set_raw(ent, "body", Value::string(kind));
  return e.value();
}

struct Scene {
  World w;
  EntityId root;
  std::unique_ptr<Physics2D> physics;
  explicit Scene(std::vector<std::string> layers = {}) {
    root = w.create("", "Node2D").value();
    physics = std::make_unique<Physics2D>(w, kDt, std::move(layers));
  }
  EntityId add(const char* type, double x, double y, double sw, double sh, const char* kind = nullptr) {
    EntityId e = body(w, root, type, x, y, sw, sh, kind);
    physics->mark_dirty(e);
    return e;
  }
  std::vector<ContactEvent> run(int ticks) {
    std::vector<ContactEvent> all;
    for (int i = 0; i < ticks; ++i) {
      auto ev = physics->step(kDt);
      all.insert(all.end(), ev.begin(), ev.end());
    }
    return all;
  }
  double y(EntityId e) { return w.vec(*w.get(e), "position").y; }
};

bool has_event(const std::vector<ContactEvent>& evs, EntityId a, EntityId b, bool started) {
  for (const ContactEvent& e : evs)
    if (e.a == a && e.b == b && e.started == started) return true;
  return false;
}

std::shared_ptr<const pkg::Package> package_dir(const std::string& rel) {
  auto f = pkg::Files::from_dir(kRoot + "/" + rel);
  REQUIRE(f.ok());
  pkg::LoadResult r = pkg::load_package(std::move(f).value());
  REQUIRE(r.ok);
  return std::shared_ptr<const pkg::Package>(std::move(r.package));
}

}  // namespace

TEST_CASE("a dynamic body falls at 980 px/s², lands on a static floor and is onFloor") {
  Scene s;
  EntityId floor = s.add("Body2D", 0, 200, 400, 20);
  EntityId box = s.add("Body2D", 0, 0, 16, 16, "dynamic");
  s.run(30);  // 0.5 s of free fall
  // semi-implicit Euler over 4 substeps per tick: y = g h² n(n+1)/2 with h = dt/4, n = 120
  const double h = kDt / 4;
  CHECK(s.y(box) == doctest::Approx(980 * h * h * 120 * 121 / 2).epsilon(0.002));
  CHECK_FALSE(s.physics->on_floor(box));
  auto evs = s.run(60);
  CHECK(s.y(box) == doctest::Approx(200 - 10 - 8).epsilon(0.002));  // resting on the floor's top
  CHECK(s.physics->on_floor(box));
  CHECK(has_event(evs, box, floor, true));  // both bodies get bodyEntered
  CHECK(has_event(evs, floor, box, true));
  CHECK(std::fabs(s.physics->velocity(box).y) < 1);
}

TEST_CASE("Area2D reports enter/exit for bodies, never for other areas; velocity, impulses, kinematic") {
  Scene s;
  EntityId area = s.add("Area2D", 100, 0, 20, 20);
  EntityId other_area = s.add("Area2D", 100, 0, 20, 20);
  EntityId ball = s.add("Body2D", 0, 0, 10, 10, "dynamic");
  s.w.set_raw(*s.w.get(ball), "gravity_scale", Value::number(0));
  s.physics->mark_dirty(ball);
  s.physics->set_velocity(ball, 300, 0);  // builds the (dirty) body first, then sets it
  auto evs = s.run(60);
  CHECK(has_event(evs, area, ball, true));
  CHECK(has_event(evs, area, ball, false));
  CHECK_FALSE(has_event(evs, ball, area, true));  // areas receive, bodies don't
  for (const ContactEvent& e : evs) CHECK_FALSE((e.a == area && e.b == other_area));
  CHECK(s.physics->velocity(ball).x == doctest::Approx(300));
  s.physics->apply_impulse(ball, -600, 0);  // mass 1 kg: Δv = -600 px/s
  CHECK(s.physics->velocity(ball).x == doctest::Approx(-300));

  EntityId mover = s.add("Body2D", 0, 300, 10, 10, "kinematic");
  s.physics->set_velocity(mover, 0, -60);
  s.run(60);
  CHECK(s.y(mover) == doctest::Approx(240).epsilon(0.001));  // kinematic: no gravity
}

TEST_CASE("collision layers and masks filter contacts; unknown layers are errors") {
  Scene s({"player", "enemy", "world"});
  EntityId floor = s.add("Body2D", 0, 100, 400, 20);
  s.w.set_raw(*s.w.get(floor), "layer", Value::string("world"));
  EntityId ghost = s.add("Body2D", 0, 0, 10, 10, "dynamic");
  s.w.set_raw(*s.w.get(ghost), "layer", Value::string("enemy"));
  s.w.set_raw(*s.w.get(ghost), "mask", Value::string("player"));  // ignores the world
  EntityId walker = s.add("Body2D", 50, 0, 10, 10, "dynamic");
  s.w.set_raw(*s.w.get(walker), "mask", Value::string("world, enemy"));
  s.run(90);
  CHECK(s.y(ghost) > 150);              // fell through the floor
  CHECK(s.y(walker) == doctest::Approx(85).epsilon(0.002));  // stood on it

  s.w.set_raw(*s.w.get(walker), "mask", Value::string("lava"));
  auto g = s.physics->groups(*s.w.get(walker));
  CHECK(g.error() == "Body2D \"rt_4\".mask: unknown collision layer \"lava\" (layers: player, enemy, world)");
}

TEST_CASE("2.5D: z ranges gate collisions; flat bodies collide with everything") {
  Scene s;
  s.w.view = ViewMode::TopDown;
  s.physics = std::make_unique<Physics2D>(s.w, kDt, std::vector<std::string>{});  // no planar gravity in topdown
  EntityId wall = s.add("Body2D", 100, 0, 20, 100);
  EntityId high = s.add("Body2D", 0, 0, 10, 10, "dynamic");
  EntityId flat = s.add("Body2D", 0, 40, 10, 10, "dynamic");
  s.w.get(wall)->height = 16;
  s.w.get(high)->height = 8;
  s.w.get(high)->z = 30;  // hovering above the wall's top...
  s.w.get(high)->z_gravity_scale = 0;  // ...and staying there
  s.physics->set_velocity(high, 120, 0);
  s.physics->set_velocity(flat, 120, 0);
  auto evs = s.run(90);
  CHECK(s.w.vec(*s.w.get(high), "position").x > 150);   // passed over the wall
  CHECK(s.w.vec(*s.w.get(flat), "position").x < 90.5);  // flat (height 0): blocked
  CHECK_FALSE(has_event(evs, high, wall, true));
  CHECK(has_event(evs, flat, wall, true));
  CHECK(s.y(high) == doctest::Approx(0));  // topdown: no planar gravity
}

TEST_CASE("2.5D z-jump scene: jump onto a crate, walk off, blocked by a ledge; deterministic") {
  auto pkg = package_dir("engine/tests/scenes/z_jump");
  auto run = [&](std::vector<double>* zs) {
    script::HostOptions o;
    o.view = ViewMode::TopDown;
    auto h = script::Host::create(pkg, o);
    REQUIRE(h.ok());
    script::Host& host = *h.value();
    World& w = host.world();
    w.get(w.by_id("player"))->height = 16;
    w.get(w.by_id("crate"))->height = 16;
    w.get(w.by_id("ledge"))->height = 48;
    for (int i = 1; i <= 260; ++i) {
      if (i == 50) w.get(w.by_id("player"))->z_velocity = 300;
      host.step();
      if (zs) zs->push_back(w.get(w.by_id("player"))->z);
    }
    std::string logs;
    for (const script::LogLine& l : host.logs()) logs += l.text + "\n";
    return std::make_pair(host.state_hash(), logs);
  };
  std::vector<double> zs;
  auto [hash, logs] = run(&zs);
  double peak = 0;
  for (double z : zs) peak = std::max(peak, z);
  // semi-implicit Euler per tick: z_n = dt * sum(300 - k g dt), highest at n = 18 (v²/2g = 45.9 in the limit)
  CHECK(peak == doctest::Approx((18 * 300 - 980.0 / 60 * 171) / 60));
  CHECK(zs[49] > 0);           // jumped on tick 50
  CHECK(zs[99] == 16);         // standing on the crate's top
  CHECK(zs[139] == 0);         // walked off and fell back to the ground
  CHECK(logs.find("crossed the pad") != std::string::npos);  // made it past the crate
  CHECK(logs.find("bumped ledge") != std::string::npos);     // too high to clear
  CHECK(logs.find("bumped crate at tick 6") == std::string::npos);  // didn't hit the crate on the way up
  // Same inputs, same state, bit for bit. The golden value guards cross-platform determinism
  // (§14.4): it must be the same on every platform and build type that runs this test.
  CHECK(run(nullptr).first == hash);
  char hex[17];
  std::snprintf(hex, sizeof hex, "%016llx", static_cast<unsigned long long>(hash));
  MESSAGE("z_jump state hash: " << hex);
  CHECK(std::string(hex) == "05d49a68880dccb1");
}
