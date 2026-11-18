// 2D physics on Box2D v3, plus engine-handled height (z) for 2.5D (DREAMSY.MD §14.5).
//
// A port of engine-web/core/physics2d.ts (Rapier). Same bodies, shapes, events and rules:
//
//   Body2D    static / dynamic / kinematic body with one rect, circle or capsule shape
//   Area2D    a sensor (detects bodies, never pushes them); fires bodyEntered/bodyExited
//   TileMap2D one static body, one box per merged rectangle of solid tiles
//
// Units: scripts and entities use pixels, +y down, angles in degrees clockwise. Box2D runs in
// meters with kPixelsPerMeter = 32 (the same "meter" Rapier was given as its length unit in
// engine-web), so its tolerances (linear slop 0.005 m = 0.16 px, speculative distance, sleep
// speed) are tuned for 32 px characters. Gravity is 980 px/s² (30.625 m/s²) down, like Godot.
//
// Friction and restitution combine as the average of the two shapes, which is Rapier's default
// rule (Box2D's own default is sqrt(a*b) for friction and max for restitution).
//
// Event timing follows Rapier: contacts begin/end when Box2D updates contacts at the start of a
// step, and Area2D overlaps are evaluated here at the start of the step too (Box2D's own sensor
// events come at the end of the step, which would fire bodyEntered one tick early).
//
// 2.5D height. Every entity has `z` (base height above the ground) and `height` (vertical
// extent), both 0 by default. The planar simulation is Box2D's; z is integrated here:
//   - Two shapes interact (contacts and Area2D overlaps) only when their z ranges overlap:
//     a.z < b.z + b.height and b.z < a.z + a.height. A shape with height 0 is "flat" and
//     interacts with everything, so plain 2D games are unaffected.
//   - Moving bodies (dynamic, kinematic) fall with kZGravity (scaled by z_gravity_scale) when
//     above the ground, and land on the ground height: the highest top (z + height) of a static
//     or kinematic body under their footprint that is at or below them, else 0. Walking off a
//     ledge makes the ground lower, so the body falls. A script/engine jump sets z_velocity > 0.
//   - Semi-implicit Euler per tick, in a fixed order (body creation order): deterministic.
//   - The z rule is applied to contacts (pre-solve), continuous collision (pre-continuous) and
//     Area2D overlaps.
// Planar gravity applies in the `side` view only; topdown/oblique/iso scenes have no planar
// gravity (y is depth there), and z gravity takes its role.
#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "base/hash.h"
#include "base/result.h"
#include "box2d/box2d.h"
#include "world/world.h"

namespace dreamsy::physics {

inline constexpr double kPixelsPerMeter = 32;
inline constexpr double kGravity = 980;   // px/s², +y (side view)
inline constexpr double kZGravity = 980;  // px/s², pulls z down
inline constexpr int kSubSteps = 4;

struct ContactEvent {
  world::EntityId a;  // receiver
  world::EntityId b;  // other
  bool started = false;
};

struct Aabb {
  double x0 = 0, y0 = 0, x1 = 0, y1 = 0;  // world px
};

// Collision filter bits from `layer` / `mask` (unset = all 16 layers).
struct Groups {
  uint32_t member = 0xffff;
  uint32_t filter = 0xffff;
};

class Physics2D {
 public:
  // `layers`: the manifest's [physics] layers (index = bit).
  Physics2D(world::World& world, double dt, std::vector<std::string> layers);
  ~Physics2D();
  Physics2D(const Physics2D&) = delete;
  Physics2D& operator=(const Physics2D&) = delete;

  static bool is_physical(const world::Entity& e);

  // Layer bits for an entity; unknown layer names are an error worded for the script author.
  Result<Groups> groups(const world::Entity& e) const;

  // Bodies are (re)built lazily, before the next step or query, so spawn() can set props first.
  void mark_dirty(world::EntityId e);
  void flush();
  void remove(world::EntityId e);
  // Enables or disables the body from the entity's own `visible` prop.
  void apply_enabled(world::EntityId e);
  // Teleports the body to the entity's current global transform (a script set position/rotation).
  void sync_transform(world::EntityId e);

  world::Point velocity(world::EntityId e);  // px/s
  void set_velocity(world::EntityId e, double vx, double vy);
  void apply_impulse(world::EntityId e, double ix, double iy);
  // Touching something below: a contact whose normal points down from this body (ny > 0.6).
  bool on_floor(world::EntityId e);

  // One step of `dt` seconds: simulate, write moved bodies back to their entities, integrate z.
  // Returns contact begin/end events (receiver first).
  std::vector<ContactEvent> step(double dt);

  // World-space bounds of a body (not tile maps), for tile touch queries.
  std::optional<Aabb> aabb(world::EntityId e);
  // Enabled dynamic and kinematic bodies, in creation order.
  std::vector<world::EntityId> moving_bodies() const;
  // Colliders a TileMap2D was merged into (diagnostics).
  int collider_count(world::EntityId e) const;

  // Adds every body's state (creation order) to a state hash.
  void hash_into(Hasher& h) const;

 private:
  enum class Kind : uint8_t { Static, Dynamic, Kinematic, Area, Tiles };
  struct BodyRec {
    world::EntityId entity;
    uint32_t handle = 0;  // entity handle (stable for the entity's lifetime)
    b2BodyId body{};
    std::vector<b2ShapeId> shapes;
    Kind kind = Kind::Static;
    std::vector<b2ShapeId> overlaps;  // Area2D: shapes overlapping it after the last step, sorted
  };

  BodyRec* rec(world::EntityId e);  // builds the body first when dirty
  BodyRec* find(uint32_t handle);
  const BodyRec* find(uint32_t handle) const;
  BodyRec* find_shape(b2ShapeId shape);
  void build(world::EntityId e);
  void build_tiles(world::EntityId e, bool rebuilt);
  void insert(BodyRec rec);
  void remove_rec(uint32_t handle);
  Groups safe_groups(const world::Entity& e) const;
  b2Filter filter_of(const world::Entity& e) const;
  void step_z(double dt);
  double ground_height(const BodyRec& mover, double z);
  void push_events(std::vector<ContactEvent>& out, b2ShapeId s1, b2ShapeId s2, bool started);
  void update_areas(std::vector<ContactEvent>& out);
  bool shapes_overlap(b2ShapeId a, b2ShapeId b) const;

  static bool z_overlap(const world::Entity& a, const world::Entity& b);
  static void pre_solve(b2ShapeId a, b2ShapeId b, b2Manifold* manifold, void* context);
  static bool pre_continuous(b2ShapeId a, b2ShapeId b, b2Pos point, b2Vec2 normal, void* context);
  bool z_allows(b2ShapeId a, b2ShapeId b) const;
  const world::Entity* entity_of_shape(b2ShapeId s) const;

  world::World& world_;
  std::vector<std::string> layers_;
  b2WorldId b2world_{};
  int64_t next_seq_ = 0;
  std::map<int64_t, BodyRec> recs_;                // creation order
  std::unordered_map<uint32_t, int64_t> by_handle_;  // entity handle -> recs_ key
  std::vector<world::EntityId> dirty_;             // insertion order, unique

  // TileMap2D <-> entity contact counts (many colliders, one bodyEntered/Exited per pair).
  std::map<std::pair<uint32_t, uint32_t>, int> tile_pairs_;
  // Pairs active before a tile map's colliders were rebuilt; confirmed silently by the new ones.
  std::vector<std::pair<std::pair<uint32_t, uint32_t>, std::pair<world::EntityId, world::EntityId>>> stale_tile_pairs_;
};

}  // namespace dreamsy::physics
