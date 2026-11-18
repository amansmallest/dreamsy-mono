#include "play/scene_draw.h"

#include <algorithm>
#include <cmath>

#include "world/value.h"

namespace dreamsy::play {

namespace {

using world::Entity;
using world::EntityId;

render::Color color_of(const std::optional<world::Value>& v, render::Color fallback = {}) {
  if (!v || v->kind != world::ValueKind::Vec || v->n != 4) return fallback;
  return {static_cast<float>(v->v[0]), static_cast<float>(v->v[1]), static_cast<float>(v->v[2]),
          static_cast<float>(v->v[3])};
}

render::Color hex_color(const std::string& hex) {
  double c[4] = {1, 1, 1, 1};
  world::parse_color(hex, c);
  return {static_cast<float>(c[0]), static_cast<float>(c[1]), static_cast<float>(c[2]), static_cast<float>(c[3])};
}

render::ViewMode view_of(world::ViewMode v) {
  switch (v) {
    case world::ViewMode::Side: return render::ViewMode::Side;
    case world::ViewMode::TopDown: return render::ViewMode::TopDown;
    case world::ViewMode::Oblique: return render::ViewMode::Oblique;
    case world::ViewMode::Iso: return render::ViewMode::Iso;
  }
  return render::ViewMode::Side;
}

render::FontId font_of(const std::string& name) {
  if (name == "pixel") return render::FontId::Pixel;
  if (name == "rounded") return render::FontId::Rounded;
  if (name == "bold") return render::FontId::Bold;
  if (name == "serif") return render::FontId::Serif;
  return render::FontId::Default;
}

float lerp(double a, double b, double t) { return static_cast<float>(a + (b - a) * t); }

class Builder {
 public:
  Builder(script::Host& host, render::TextureStore& textures, render::DrawList& out)
      : world_(host.world()), textures_(textures), out_(out) {}

  void visit(EntityId id, int z_acc) {
    Entity* e = world_.get(id);
    if (!e || !world_.visible(*e)) return;  // hides the whole subtree, like engine-web
    int z = z_acc;
    if (world::prop_index(*e->type, "z_index") >= 0) z += static_cast<int>(world_.num(*e, "z_index"));

    const std::string& type = e->type->name;
    if (type == "Sprite2D") sprite(*e, id, z);
    else if (type == "Text2D") text(*e, id, z);
    else if (type == "TileMap2D") tilemap(*e, id, z);
    else if (type == "Particles2D") particles(*e, z);

    if (type.rfind("UI", 0) == 0) return;  // UI trees are laid out by the UI system (E5)
    for (EntityId child : e->children) visit(child, z);
  }

 private:
  struct Placement {
    render::Vec2 position;
    float rotation = 0;
    render::Vec2 scale{1, 1};
    bool mirrored = false;
  };

  Placement place(EntityId id) const {
    world::Mat2D m = world_.global(id);
    world::Point p = world::apply(m, 0, 0);
    Placement out;
    out.position = {static_cast<float>(p.x), static_cast<float>(p.y)};
    out.rotation = static_cast<float>(world::rotation_of(m));
    out.scale = {static_cast<float>(std::hypot(m.a, m.b)), static_cast<float>(std::hypot(m.c, m.d))};
    out.mirrored = m.a * m.d - m.b * m.c < 0;
    return out;
  }

  render::SortInfo sort(int z) const {
    render::SortInfo s;
    s.z_index = z;
    return s;
  }

  render::BlendMode blend(const Entity& e) const {
    return world::prop_index(*e.type, "blend") >= 0 && world_.str(e, "blend") == "add" ? render::BlendMode::Add
                                                                                       : render::BlendMode::Alpha;
  }

  void sprite(const Entity& e, EntityId id, int z) {
    Placement p = place(id);
    render::SpriteCmd s;
    std::string tex = world_.str(e, "texture");
    if (!tex.empty()) s.image = textures_.find_asset(tex);
    world::Point size = world_.vec(e, "size");
    s.position = p.position;
    s.rotation = p.rotation;
    s.scale = p.scale;
    s.size = {static_cast<float>(size.x), static_cast<float>(size.y)};
    s.flip_h = world_.flag(e, "flip_h") != p.mirrored;
    s.flip_v = world_.flag(e, "flip_v");
    s.tint = color_of(world_.get_prop(e, "modulate"));
    s.blend = blend(e);
    s.z = static_cast<float>(e.z);
    s.height = static_cast<float>(e.height);
    s.shadow = e.z > 0;
    s.sort = sort(z);
    out_.add(std::move(s));
  }

  void text(const Entity& e, EntityId id, int z) {
    render::TextCmd t;
    t.text = world_.str(e, "text");
    if (t.text.empty()) return;
    Placement p = place(id);
    t.position = p.position;
    t.size = static_cast<float>(world_.num(e, "font_size")) * p.scale.y;
    t.color = color_of(world_.get_prop(e, "color"));
    std::string align = world_.str(e, "align");
    t.align = align == "left" ? render::TextAlign::Left : align == "right" ? render::TextAlign::Right : render::TextAlign::Center;
    t.font = font_of(world_.str(e, "font"));
    t.outline = color_of(world_.get_prop(e, "outline"), {0, 0, 0, 0});
    t.outline_size = static_cast<float>(world_.num(e, "outline_size"));
    t.shadow = color_of(world_.get_prop(e, "shadow"), {0, 0, 0, 0});
    world::Point off = world_.vec(e, "shadow_offset");
    t.shadow_offset = {static_cast<float>(off.x), static_cast<float>(off.y)};
    t.z = static_cast<float>(e.z);
    t.sort = sort(z);
    out_.add(std::move(t));
  }

  void tilemap(const Entity& e, EntityId id, int z) {
    if (!e.tiles) return;
    const world::TileGrid& grid = *e.tiles;
    Placement p = place(id);
    const float size = static_cast<float>(world_.num(e, "tile_size"));
    // engine-web cuts maps into 32x32-tile chunks; the renderer batches each chunk as one item.
    constexpr int kChunk = 32;
    for (int cr = 0; cr < grid.rows(); cr += kChunk) {
      for (int cc = 0; cc < grid.cols(); cc += kChunk) {
        render::TileChunkCmd chunk;
        chunk.origin = {p.position.x + static_cast<float>(cc) * size, p.position.y + static_cast<float>(cr) * size};
        chunk.tile_size = size;
        chunk.sort = sort(z);
        for (int r = cr; r < std::min(cr + kChunk, grid.rows()); ++r) {
          for (int c = cc; c < std::min(cc + kChunk, grid.cols()); ++c) {
            const world::TileKind* kind = grid.kind_at(c, r);
            if (!kind || (!kind->sprite && !kind->has_color)) continue;  // empty or invisible
            render::Tile t;
            t.col = static_cast<uint16_t>(c - cc);
            t.row = static_cast<uint16_t>(r - cr);
            if (kind->sprite) t.image = textures_.find_asset(*kind->sprite);
            if (kind->has_color) {
              t.color = {static_cast<float>(kind->color[0]), static_cast<float>(kind->color[1]),
                         static_cast<float>(kind->color[2]), static_cast<float>(kind->color[3])};
            }
            chunk.tiles.push_back(t);
          }
        }
        if (!chunk.tiles.empty()) out_.add(std::move(chunk));
      }
    }
  }

  void particles(Entity& e, int z) {
    if (!e.emitter || e.emitter->count() == 0) return;
    const world::Emitter& em = *e.emitter;
    render::Color c0 = color_of(world_.get_prop(e, "start_color")), c1 = color_of(world_.get_prop(e, "end_color"));
    double s0 = world_.num(e, "start_size"), s1 = world_.num(e, "end_size");
    std::string tex = world_.str(e, "texture");
    render::ImageId image = !tex.empty() ? textures_.find_asset(tex)
                            : world_.str(e, "shape") == "circle" ? render::TextureStore::kShadow
                                                                 : render::ImageId{};
    render::BlendMode mode = blend(e);
    for (int i = 0; i < em.count(); ++i) {
      double t = em.life(i) > 0 ? std::clamp(static_cast<double>(em.age(i)) / em.life(i), 0.0, 1.0) : 1.0;
      render::SpriteCmd s;  // particles live in world space (engine-web ParticlesView)
      s.image = image;
      s.position = {em.x(i), em.y(i)};
      float size = lerp(s0, s1, t);
      s.size = {size, size};
      s.tint = {lerp(c0.r, c1.r, t), lerp(c0.g, c1.g, t), lerp(c0.b, c1.b, t), lerp(c0.a, c1.a, t)};
      s.blend = mode;
      s.sort = sort(z);
      out_.add(std::move(s));
    }
  }

  world::World& world_;
  render::TextureStore& textures_;
  render::DrawList& out_;
};

}  // namespace

void draw_world(script::Host& host, render::TextureStore& textures, render::DrawList& out) {
  out.clear();
  world::World& w = host.world();
  out.view = view_of(w.view);
  script::Host::CameraView cam = host.camera_view();
  out.camera = {{static_cast<float>(cam.x), static_cast<float>(cam.y)}, static_cast<float>(cam.zoom)};
  // engine-web renderer2d: the first palette color, else the style's default.
  const pkg::Manifest& m = host.package().manifest;
  out.clear_color = hex_color(m.style.palette && !m.style.palette->empty() ? m.style.palette->front()
                              : m.style.preset == "pixel"                   ? "#1a1c2c"
                                                                            : "#20232a");
  Builder(host, textures, out).visit(w.root(), 0);
}

}  // namespace dreamsy::play
