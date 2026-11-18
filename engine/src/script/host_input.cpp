// The host's pointer, tap and UI entry points (a port of engine-web core/game.ts pointerDown,
// pointerMove, pointerUp, tapScreen, tapWorld, tapEntity, press). The gesture math (pointer
// grace, swipe thresholds) lives in input/input_state.cpp; UI layout in ui/layout.cpp.
#include <cmath>
#include <limits>

#include "script/host.h"
#include "script/lua_util.h"
#include "ui/layout.h"

namespace dreamsy::script {

using world::Entity;
using world::EntityId;

namespace {

// Signals with a Vec2 argument get x, y (the prelude rebuilds the Vec2).
int push_xy(lua_State* L, double x, double y) {
  lua_pushnumber(L, x);
  lua_pushnumber(L, y);
  return 2;
}

input::Vec2 vec(double x, double y) { return {static_cast<float>(x), static_cast<float>(y)}; }

}  // namespace

double Host::ref_width() const { return pkg_->manifest.reference_width(); }
double Host::ref_height() const { return pkg_->manifest.reference_height(); }

void Host::pointer_down(double x, double y, std::optional<double> time) {
  input_.pointer_down(vec(x, y), time);
  fire({}, "pointerDown", [&](lua_State* L) { return push_xy(L, x, y); });
}

void Host::pointer_move(double x, double y) { input_.pointer_move(vec(x, y)); }

void Host::pointer_up(double x, double y, std::optional<double> time) {
  const std::optional<input::Swipe> swipe = input_.pointer_up(vec(x, y), time);
  fire({}, "pointerUp", [&](lua_State* L) { return push_xy(L, x, y); });
  if (!swipe) return;
  fire({}, "swipe", [&](lua_State* L) {
    lua_pushstring(L, input::swipe_dir_name(swipe->dir));
    push_xy(L, swipe->velocity.x, swipe->velocity.y);
    return 3;
  });
}

std::string Host::tap_screen(double x, double y) {
  pointer_down(x, y);
  pointer_up(x, y);
  input_.hold_pointer(vec(x, y), 5);  // engine-web: visible until tick + 6
  if (dialogs_.open()) {
    dialogs_.tap(-1);
    return "dialog";
  }
  const EntityId ui = ui::ui_hit_headless(world_, x, y, ref_width(), ref_height());
  if (const Entity* e = world_.get(ui)) {
    const std::string id = e->id;  // the handlers may destroy it
    if (e->type->name == "UIButton") press(ui);
    tap_entity(ui);
    return id;
  }
  const world::Point p = ref_to_world(x, y);
  const EntityId hit = tap_world(p.x, p.y);
  const Entity* e = world_.get(hit);
  return e ? e->id : "";
}

world::Point Host::ref_to_world(double x, double y) {
  const CameraView v = camera_view();
  return {v.x + (x - ref_width() / 2) / v.zoom, v.y + (y - ref_height() / 2) / v.zoom};
}

void Host::press(EntityId e) {
  if (world_.alive(e) && effective_visible(e)) fire(e, "pressed", [](lua_State*) { return 0; });
}

bool Host::tap_entity(EntityId e) {
  if (!world_.alive(e) || !has_conn(e, "tapped")) return false;
  fire(e, "tapped", [&](lua_State* L) {
    lua_getref(L, refs_.player);
    return 1;
  });
  return true;
}

// The topmost visible entity under the point that listens for tapped / tileTapped / tappedAt
// (or has a listening ancestor: taps bubble up to it). "Topmost" = accumulated z_index, then tree
// order. TileMap2D cells hit inside the grid; other 2D entities inside their `size` box.
EntityId Host::tap_world(double x, double y) {
  std::set<EntityId, ui::EntityIdLess> listeners;
  for (const auto& [id, c] : conns_) {
    if ((c.signal == "tapped" || c.signal == "tileTapped" || c.signal == "tappedAt") && !c.entity.is_null())
      listeners.insert(c.entity);
  }
  if (listeners.empty()) return {};

  EntityId best;
  double best_key = -std::numeric_limits<double>::infinity();
  double order = 0;
  std::optional<std::pair<int, int>> best_cell;
  std::function<void(EntityId, double, bool, EntityId)> visit = [&](EntityId id, double z, bool vis, EntityId inherited) {
    const Entity* e = world_.get(id);
    if (!e) return;
    const bool v = vis && world_.visible(*e);
    const double zz = z + (world::prop_index(*e->type, "z_index") >= 0 ? world_.num(*e, "z_index") : 0);
    const EntityId target = listeners.count(id) ? id : inherited;
    order++;
    if (v && !target.is_null() && e->type->name == "TileMap2D" && e->tiles) {
      const world::Point l = world::apply(world::invert(world_.global(id)), x, y);
      const double ts = world_.num(*e, "tile_size");
      const int c = static_cast<int>(std::floor(l.x / ts)), r = static_cast<int>(std::floor(l.y / ts));
      if (e->tiles->in_bounds(c, r)) {
        const double key = zz * 1e6 + order;
        if (key > best_key) {
          best_key = key;
          best = target;
          best_cell = target == id ? std::optional<std::pair<int, int>>({c, r}) : std::nullopt;
        }
      }
    } else if (v && !target.is_null() && world::prop_index(*e->type, "size") >= 0 && e->is_2d()) {
      const world::Point l = world::apply(world::invert(world_.global(id)), x, y);
      const world::Point s = world_.vec(*e, "size");
      if (std::abs(l.x) <= s.x / 2 && std::abs(l.y) <= s.y / 2) {
        const double key = zz * 1e6 + order;
        if (key > best_key) {
          best_key = key;
          best = target;
          best_cell.reset();
        }
      }
    }
    const std::vector<EntityId> children = e->children;
    for (EntityId c : children) visit(c, zz, v, target);
  };
  visit(world_.root(), 0, true, {});

  const Entity* hit = world_.get(best);
  if (!hit) return {};
  if (best_cell && hit->tiles) {
    const auto [c, r] = *best_cell;
    const world::TileKind* k = hit->tiles->kind_at(c, r);
    fire(best, "tileTapped", [&](lua_State* L) {
      lua_pushnumber(L, c);
      lua_pushnumber(L, r);
      if (k) lua_pushlstring(L, &k->ch, 1);
      else lua_pushnil(L);
      return 3;
    });
  }
  if (world_.alive(best) && has_conn(best, "tappedAt")) {
    // Local position inside the target: (0,0) = top-left corner of its `size` box.
    const Entity* t = world_.get(best);
    const world::Point l = world::apply(world::invert(world_.global(best)), x, y);
    world::Point off;
    if (t->type->name != "TileMap2D" && world::prop_index(*t->type, "size") >= 0) {
      const world::Point s = world_.vec(*t, "size");
      off = {s.x / 2, s.y / 2};
    }
    fire(best, "tappedAt", [&](lua_State* L) { return push_xy(L, l.x + off.x, l.y + off.y); });
  }
  tap_entity(best);
  return best;
}

}  // namespace dreamsy::script
