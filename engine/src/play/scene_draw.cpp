#include "play/scene_draw.h"

#include <algorithm>
#include <cmath>

#include "physics/physics2d.h"
#include "render/sort.h"
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
      : world_(host.world()), physics_(host.physics()), textures_(textures), out_(out) {}

  // z_acc: accumulated z_index; height_acc: the parent's height above the ground (2.5D `z`).
  void visit(EntityId id, int z_acc, double height_acc) {
    Entity* e = world_.get(id);
    if (!e || !world_.visible(*e)) return;  // hides the whole subtree, like engine-web
    int z = z_acc;
    if (world::prop_index(*e->type, "z_index") >= 0) z += static_cast<int>(world_.num(*e, "z_index"));
    const double gz = height_acc + e->z;  // this entity's height above the ground

    const std::string& type = e->type->name;
    if (type == "Sprite2D") sprite(*e, id, z, gz);
    else if (type == "Text2D") text(*e, id, z, gz);
    else if (type == "TileMap2D") tilemap(*e, id, z, gz);
    else if (type == "Particles2D") particles(*e, z);

    if (type.rfind("UI", 0) == 0) return;  // UI trees: play::PlatformUi::draw (ui/layout.h, ui/overlay.h)
    for (EntityId child : e->children) visit(child, z, gz);
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

  // The ground under a point for something at height gz: the top of a raised body/tile (physics),
  // else the floor. Only matters in the 2.5D views.
  double ground_under(float x, float y, double gz) const {
    if (!physics_ || out_.view == render::ViewMode::Side || gz <= 0) return 0;
    return physics_->ground_below(x, y, gz);
  }

  void sprite(const Entity& e, EntityId id, int z, double gz) {
    Placement p = place(id);
    render::SpriteCmd s;
    std::string tex = world_.str(e, "texture");
    if (!tex.empty()) s.image = textures_.find_asset(tex);
    world::Point size = world_.vec(e, "size");
    s.position = p.position;
    s.rotation = p.rotation;
    s.scale = p.scale;
    s.size = {static_cast<float>(size.x), static_cast<float>(size.y)};
    if (world_.str(e, "anchor") == "bottom") s.anchor = {0.5f, 1.0f};  // stands on its position (feet)
    s.flip_h = world_.flag(e, "flip_h") != p.mirrored;
    s.flip_v = world_.flag(e, "flip_v");
    s.tint = color_of(world_.get_prop(e, "modulate"));
    s.blend = blend(e);
    s.z = static_cast<float>(gz);
    s.height = static_cast<float>(e.height);
    s.sort = sort(z);
    s.ground_z = static_cast<float>(ground_under(s.position.x, s.position.y, gz));
    s.shadow = gz > s.ground_z + 0.5;
    if (render::is_block(out_.view, s) && out_.view == render::ViewMode::Iso) {
      add_iso_cells(std::move(s));
      return;
    }
    out_.add(std::move(s));
  }

  // Iso depth sorting needs square blocks (render/sort.h): a long block becomes a row of square
  // cells, each showing its slice of the image.
  void add_iso_cells(render::SpriteCmd s) {
    const float w = std::abs(s.size.x * s.scale.x), d = std::abs(s.size.y * s.scale.y);
    const float cell = std::min(w, d);
    if (!(cell > 0)) return;
    const int nx = std::clamp(static_cast<int>(std::lround(w / cell)), 1, 64);
    const int ny = std::clamp(static_cast<int>(std::lround(d / cell)), 1, 64);
    if (nx == 1 && ny == 1) {
      out_.add(std::move(s));
      return;
    }
    const float cw = w / static_cast<float>(nx), cd = d / static_cast<float>(ny);
    const float x0 = s.position.x - w * 0.5f, y0 = s.position.y - d * 0.5f;
    const render::UvRect src = s.src;
    for (int j = 0; j < ny; ++j) {
      for (int i = 0; i < nx; ++i) {
        render::SpriteCmd c = s;
        c.position = {x0 + (static_cast<float>(i) + 0.5f) * cw, y0 + (static_cast<float>(j) + 0.5f) * cd};
        c.size = {cw, cd};
        c.scale = {1, 1};
        const float u = src.u1 - src.u0, v = src.v1 - src.v0;
        c.src = {src.u0 + u * static_cast<float>(i) / nx, src.v0 + v * static_cast<float>(j) / ny,
                 src.u0 + u * static_cast<float>(i + 1) / nx, src.v0 + v * static_cast<float>(j + 1) / ny};
        out_.add(std::move(c));
      }
    }
  }

  void text(const Entity& e, EntityId id, int z, double gz) {
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
    t.z = static_cast<float>(gz);
    t.sort = sort(z);
    out_.add(std::move(t));
  }

  void tilemap(const Entity& e, EntityId id, int z, double gz) {
    if (!e.tiles) return;
    const world::TileGrid& grid = *e.tiles;
    Placement p = place(id);
    const float size = static_cast<float>(world_.num(e, "tile_size"));
    if (e.height > 0 && out_.view != render::ViewMode::Side) {
      tile_blocks(e, p, size, z, gz);
      return;
    }
    // engine-web cuts maps into 32x32-tile chunks; the renderer batches each chunk as one item.
    constexpr int kChunk = 32;
    for (int cr = 0; cr < grid.rows(); cr += kChunk) {
      for (int cc = 0; cc < grid.cols(); cc += kChunk) {
        render::TileChunkCmd chunk;
        chunk.origin = {p.position.x + static_cast<float>(cc) * size, p.position.y + static_cast<float>(cr) * size};
        chunk.z = static_cast<float>(gz);
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

  // A raised tile map (2.5D terrain): one block per visible tile, as tall as the map's height.
  void tile_blocks(const Entity& e, const Placement& p, float size, int z, double gz) {
    const world::TileGrid& grid = *e.tiles;
    for (int r = 0; r < grid.rows(); ++r) {
      for (int c = 0; c < grid.cols(); ++c) {
        const world::TileKind* kind = grid.kind_at(c, r);
        if (!kind || (!kind->sprite && !kind->has_color)) continue;  // empty or invisible
        render::SpriteCmd s;
        if (kind->sprite) s.image = textures_.find_asset(*kind->sprite);
        if (kind->has_color) {
          s.tint = {static_cast<float>(kind->color[0]), static_cast<float>(kind->color[1]),
                    static_cast<float>(kind->color[2]), static_cast<float>(kind->color[3])};
        }
        s.position = {p.position.x + (static_cast<float>(c) + 0.5f) * size, p.position.y + (static_cast<float>(r) + 0.5f) * size};
        s.size = {size, size};
        s.z = static_cast<float>(gz);
        s.height = static_cast<float>(e.height);
        s.sort = sort(z);
        out_.add(std::move(s));
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
  physics::Physics2D* physics_;  // ground heights for shadows (may be null)
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
  Builder(host, textures, out).visit(w.root(), 0, 0);
}

}  // namespace dreamsy::play
