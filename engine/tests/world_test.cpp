// World (E3): entities, props, scene trees, transforms, tile grids, tweens, particles.
// Behavior parity with engine-web is checked by tests/conformance/run_compare.py; these tests
// cover the world natively.
#include <cmath>
#include <map>
#include <memory>
#include <string>

#include "doctest.h"
#include "pkg/validate.h"
#include "world/particles.h"
#include "world/tilemap.h"
#include "world/tween.h"
#include "world/world.h"

using namespace dreamsy;
using namespace dreamsy::world;

namespace {

std::shared_ptr<const pkg::Package> package_with(std::map<std::string, std::string> files) {
  files["dreamsy.toml"] = "format = \"0\"\nname = \"t\"\ndimension = \"2d\"\nentry_scene = \"scenes/main.scene.json\"\n";
  auto f = pkg::Files::from_map(files);
  REQUIRE(f.ok());
  pkg::LoadResult r = pkg::load_package(std::move(f).value());
  REQUIRE(r.ok);
  return std::shared_ptr<const pkg::Package>(std::move(r.package));
}

EntityId make(World& w, const char* type, EntityId parent = {}) {
  auto e = w.create("", type);
  REQUIRE(e.ok());
  if (!parent.is_null()) w.attach(e.value(), parent);
  return e.value();
}

}  // namespace

TEST_CASE("entities: sequential handles, auto ids, tree order, stale ids after removal") {
  World w;
  EntityId root = make(w, "Node2D");
  EntityId a = make(w, "Node2D", root);
  EntityId b = make(w, "Sprite2D", root);
  EntityId c = make(w, "Node2D", a);
  CHECK(w.get(root)->handle == 1);
  CHECK(w.get(c)->handle == 4);
  CHECK(w.get(b)->id == "rt_3");
  CHECK(w.by_handle(2) == a);
  CHECK(w.by_id("rt_4") == c);

  std::vector<EntityId> order = w.walk(root);
  REQUIRE(order.size() == 4);
  CHECK(order[1] == a);
  CHECK(order[2] == c);  // depth first
  CHECK(order[3] == b);

  w.attach(b, root, 0);  // move to the front
  CHECK(w.get(root)->children.front() == b);

  w.get(c)->add_tag("enemy");
  w.get(c)->add_tag("enemy");
  CHECK(w.get(c)->tags.size() == 1);
  CHECK(w.get(c)->has_tag("enemy"));  // (World::tagged walks a scene's root; see the scene tests)

  std::vector<EntityId> removed = w.remove(a);
  CHECK(removed == std::vector<EntityId>{c, a});  // children first
  CHECK_FALSE(w.alive(a));
  CHECK(w.get(c) == nullptr);
  CHECK(w.by_handle(4).is_null());
  // a new entity never reuses a handle, and the stale id doesn't resolve to it
  EntityId d = make(w, "Node2D", root);
  CHECK(w.get(d)->handle == 5);
  CHECK(w.get(a) == nullptr);
  CHECK_FALSE(w.create("rt_5", "Node2D").ok());  // duplicate id
  CHECK_FALSE(w.create("", "Nope").ok());        // unknown type
}

TEST_CASE("props: catalog defaults, coercion and errors worded like engine-web") {
  World w;
  EntityId s = make(w, "Sprite2D");
  const Entity& e = *w.get(s);
  CHECK(w.vec(e, "size").x == 32);
  auto mod = w.get_prop(e, "modulate");  // "#ffffff" default -> RGBA
  REQUIRE(mod);
  CHECK(mod->is_vec(4));
  CHECK(mod->v[3] == 1);
  CHECK_FALSE(w.get_prop(e, "texture"));  // no default

  auto z = w.coerce(e, "z_index", Value::number(5000.4));  // int: rounded, clamped to 4096
  REQUIRE(z.ok());
  CHECK(z.value().v[0] == 4096);
  auto c = w.coerce(e, "modulate", Value::string("#ff000080"));
  REQUIRE(c.ok());
  CHECK(c.value().v[0] == 1);
  CHECK(std::fabs(c.value().v[3] - 128 / 255.0) < 1e-12);

  auto bad = w.coerce(e, "size", Value::number(3));
  CHECK(bad.error() == "Sprite2D.size expects a Vec2 (use vec2(x, y)), got 3");
  CHECK(w.coerce(e, "blend", Value::string("mul")).error() == "Sprite2D.blend expects one of \"normal\", \"add\", got \"mul\"");
  CHECK(w.coerce(e, "texture", Value::string("x")).error() == "Sprite2D.texture expects \"asset:<id>\", got \"x\"");
  CHECK(w.coerce(e, "nope", Value::number(1)).error() == "Sprite2D \"rt_1\" has no property \"nope\"");

  EntityId cam = make(w, "Camera2D");
  auto follow = w.coerce(*w.get(cam), "follow", Value::number(w.get(s)->handle));  // an entity handle
  REQUIRE(follow.ok());
  CHECK(follow.value().s == "rt_1");
  CHECK(w.coerce(*w.get(cam), "follow", Value::string("ghost")).error() == "Camera2D.follow: no entity \"ghost\"");
  CHECK(js_round(-2.5) == -2);
  CHECK(js_round(0.49999999999999994) == 0);
}

TEST_CASE("scene build: tree, tags, prop normalization, entity refs, 2.5D defaults") {
  auto pkg = package_with({{"scenes/main.scene.json", R"({"format": "0", "root": "world", "entities": {
      "world": {"type": "Node2D", "children": ["hero", "cam"]},
      "hero": {"type": "Sprite2D", "props": {"position": [10, 20], "color": "#00ff00"}, "tags": ["player"]},
      "cam": {"type": "Camera2D", "props": {"follow": "hero"}}}})"}});
  World w;
  std::vector<std::string> warnings;
  std::vector<EntityId> made = w.load_scene(pkg->scenes.at("scenes/main.scene.json"), [&](const std::string& m) { warnings.push_back(m); });
  CHECK(warnings.empty());
  REQUIRE(made.size() == 3);
  EntityId hero = w.by_id("hero");
  const Entity& h = *w.get(hero);
  CHECK(w.root() == w.by_id("world"));
  CHECK(h.has_tag("player"));
  CHECK(w.get_prop(h, "modulate")->v[1] == 1);  // Sprite2D color is stored as modulate
  CHECK(w.str(*w.get(w.by_id("cam")), "follow") == "hero");
  CHECK(h.z == 0);
  CHECK(h.height == 0);
  CHECK(w.view == ViewMode::Side);
}

TEST_CASE("transforms compose parent rotation and scale") {
  World w;
  EntityId p = make(w, "Node2D");
  EntityId c = make(w, "Node2D", p);
  w.set_raw(*w.get(p), "position", Value::vec(100, 50));
  w.set_raw(*w.get(p), "rotation", Value::number(90));
  w.set_raw(*w.get(p), "scale", Value::vec(2, 2));
  w.set_raw(*w.get(c), "position", Value::vec(10, 0));
  Mat2D m = w.global(c);
  CHECK(std::fabs(m.tx - 100) < 1e-9);
  CHECK(std::fabs(m.ty - 70) < 1e-9);  // +x of a 90° (clockwise, y down) parent points down
  Point back = apply(invert(w.global(p)), m.tx, m.ty);
  CHECK(std::fabs(back.x - 10) < 1e-9);
  CHECK(std::fabs(back.y) < 1e-9);
}

TEST_CASE("tile grids merge solid tiles into rectangles and track solidity") {
  auto pkg = package_with({{"scenes/main.scene.json", R"({"format": "0", "root": "r", "entities": {"r": {"type": "Folder"}}})"},
                           {"data/tilesets/t.json", R"({"tiles": {"#": {"color": "#808080", "solid": true}, "^": {"tags": ["spike"]}}})"}});
  TileLoad r = load_tile_grid(pkg->files, "data/tilesets/t.json", "##..\n##^.\n####");
  REQUIRE(r.grid);
  CHECK(r.errors.empty());
  TileGrid& g = *r.grid;
  CHECK(g.cols() == 4);
  CHECK(g.rows() == 3);
  std::vector<TileRect> rects = g.solid_rects();
  REQUIRE(rects.size() == 2);  // a 2x2 block over the first two rows, then the full bottom row
  CHECK((rects[0].col == 0 && rects[0].row == 0 && rects[0].w == 2 && rects[0].h == 2));
  CHECK((rects[1].col == 0 && rects[1].row == 2 && rects[1].w == 4 && rects[1].h == 1));
  CHECK(g.kind_at(2, 1)->tags == std::vector<std::string>{"spike"});
  uint32_t rev = g.solid_rev();
  CHECK(g.set(2, 1, g.by_char('#')));
  CHECK(g.solid_rev() != rev);
  CHECK_FALSE(g.set(9, 9, nullptr));
  CHECK_FALSE(load_tile_grid(pkg->files, "data/tilesets/missing.json", "#").grid);
}

TEST_CASE("tweens: easing endpoints, yoyo, loop and delay") {
  for (std::string_view name : easing_names()) {
    Easing e = find_easing(name);
    REQUIRE(e);
    CHECK(std::fabs(e(0)) < 1e-9);
    CHECK(std::fabs(e(1) - 1) < 1e-9);
  }
  CHECK_FALSE(find_easing("wobble"));
  Tween tw;
  tw.duration = 1;
  tw.ease = find_easing("linear");
  tw.delay = 0.5;
  tw.t = 0.25;
  CHECK(tween_progress(tw).k < 0);  // still delayed
  tw.t = 1.0;
  CHECK(tween_progress(tw).k == doctest::Approx(0.5));
  tw.t = 1.5;
  CHECK(tween_progress(tw).finished);
  tw.yoyo = true;
  tw.t = 1.5;  // halfway through there-and-back
  CHECK(tween_progress(tw).k == doctest::Approx(1));
  tw.loop = true;
  tw.yoyo = false;
  tw.t = 2.75;
  CHECK(tween_progress(tw).k == doctest::Approx(0.25));
  TweenTrack tr{"modulate", TweenTrack::Kind::Color, {0, 0, 0, 1}, {2, 1, 1, 1}};
  CHECK(track_value(tr, 1).v[0] == 1);  // colors clamp
}

TEST_CASE("particles are deterministic and respect lifetime and caps") {
  EmitterParams p;
  p.max_particles = 10;
  p.lifetime = 0.1;
  p.lifetime_random = 0;
  p.rate = 0;
  Emitter a(42), b(42);
  a.emit(p, 25, 0, 0, 0);
  b.emit(p, 25, 0, 0, 0);
  CHECK(a.count() == 10);  // capped
  for (int i = 0; i < 3; ++i) {
    a.step(p, 1 / 60.0, 0, 0, 0, true);
    b.step(p, 1 / 60.0, 0, 0, 0, true);
  }
  CHECK(a.count() == 10);
  CHECK(a.x(3) == b.x(3));
  for (int i = 0; i < 6; ++i) a.step(p, 1 / 60.0, 0, 0, 0, true);
  CHECK(a.count() == 0);  // 0.1 s lifetime has passed
  p.rate = 60;
  a.step(p, 1 / 60.0, 0, 0, 0, true);
  CHECK(a.count() == 1);
  a.step(p, 1 / 60.0, 0, 0, 0, false);  // invisible: no new particles
  CHECK(a.count() == 1);
}
