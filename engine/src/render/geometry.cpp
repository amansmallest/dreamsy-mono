#include "render/geometry.h"

#include <algorithm>
#include <cmath>

#include "render/view.h"

namespace dreamsy::render {

uint32_t pack_color(Color c, BlendMode blend) {
  auto to8 = [](float v) {
    if (!(v > 0)) return 0u;  // also catches NaN
    if (v >= 1) return 255u;
    return static_cast<uint32_t>(std::lround(v * 255.0f));
  };
  const float a = std::clamp(c.a, 0.0f, 1.0f);
  const uint32_t r = to8(c.r * a), g = to8(c.g * a), b = to8(c.b * a);
  const uint32_t alpha = blend == BlendMode::Add ? 0u : to8(a);
  return r | (g << 8) | (b << 16) | (alpha << 24);
}

void push_quad(FrameGeometry& geo, std::vector<Batch>& batches, uint16_t page, const Vec2 corners[4], const UvRect& uv,
               uint32_t color, const ClipRect& clip) {
  const uint32_t quad = geo.quad_count();
  if (batches.empty() || batches.back().page != page || batches.back().first_quad + batches.back().quad_count != quad ||
      batches.back().quad_count >= kMaxQuadsPerBatch || !(batches.back().clip == clip)) {
    batches.push_back(Batch{page, quad, 0, clip});
  }
  batches.back().quad_count++;
  // Corners: top-left, top-right, bottom-right, bottom-left.
  geo.vertices.push_back({corners[0].x, corners[0].y, uv.u0, uv.v0, color});
  geo.vertices.push_back({corners[1].x, corners[1].y, uv.u1, uv.v0, color});
  geo.vertices.push_back({corners[2].x, corners[2].y, uv.u1, uv.v1, color});
  geo.vertices.push_back({corners[3].x, corners[3].y, uv.u0, uv.v1, color});
}

namespace {

// Per-pass state while building geometry.
struct Builder {
  const DrawList& list;
  TextureStore& textures;
  FontStore& fonts;
  const GeometryParams& params;
  FrameGeometry& out;

  // The pass being built.
  std::vector<Batch>* batches = nullptr;
  ClipRect clip{};  // the current item's clip (set per item in item())
  bool world = true;
  float zoom = 1;          // world pass: camera zoom; screen pass: 1
  float raster_scale = 1;  // real pixels per reference px in this pass
  Vec2 cam{0, 0};          // projected camera center (world pass)

  // World point -> reference px (identity in the screen pass, where z is ignored).
  Vec2 to_ref(float x, float y, float z) const {
    if (!world) return {x, y};
    const Vec2 p = project(list.view, x, y, z);
    return {(p.x - cam.x) * zoom + params.ref_w * 0.5f, (p.y - cam.y) * zoom + params.ref_h * 0.5f};
  }

  // Rounds to whole real pixels of this pass (pixel art).
  float snap(float v) const { return params.pixel_snap ? snap_to_grid(v, raster_scale) : v; }

  bool off_screen(const Vec2 c[4]) const {
    float x0 = c[0].x, x1 = c[0].x, y0 = c[0].y, y1 = c[0].y;
    for (int i = 1; i < 4; i++) {
      x0 = std::min(x0, c[i].x);
      x1 = std::max(x1, c[i].x);
      y0 = std::min(y0, c[i].y);
      y1 = std::max(y1, c[i].y);
    }
    return x1 < 0 || y1 < 0 || x0 > static_cast<float>(params.ref_w) || y0 > static_cast<float>(params.ref_h);
  }

  bool clipped_out(const Vec2 c[4]) const {
    if (!clip.enabled) return false;
    float x0 = c[0].x, x1 = c[0].x, y0 = c[0].y, y1 = c[0].y;
    for (int i = 1; i < 4; i++) {
      x0 = std::min(x0, c[i].x);
      x1 = std::max(x1, c[i].x);
      y0 = std::min(y0, c[i].y);
      y1 = std::max(y1, c[i].y);
    }
    return x1 < clip.x || y1 < clip.y || x0 > clip.x + clip.w || y0 > clip.y + clip.h;
  }

  void quad(uint16_t page, const Vec2 c[4], const UvRect& uv, uint32_t color) {
    if (off_screen(c) || clipped_out(c)) {
      out.culled++;
      return;
    }
    push_quad(out, *batches, page, c, uv, color, clip);
  }

  // An axis-aligned quad (optionally rotated about `pivot`).
  void rect_quad(uint16_t page, float x, float y, float w, float h, const UvRect& uv, uint32_t color, float rotation = 0,
                 Vec2 pivot = {}) {
    Vec2 c[4] = {{x, y}, {x + w, y}, {x + w, y + h}, {x, y + h}};
    if (rotation != 0) {
      const float cs = std::cos(rotation), sn = std::sin(rotation);
      for (Vec2& p : c) {
        const float dx = p.x - pivot.x, dy = p.y - pivot.y;
        p = {pivot.x + dx * cs - dy * sn, pivot.y + dx * sn + dy * cs};
      }
    }
    quad(page, c, uv, color);
  }

  AtlasRegion white() { return *textures.region(TextureStore::kWhite); }

  void sprite(const SpriteCmd& s) {
    const float w = s.size.x * s.scale.x * zoom;  // negative scale mirrors, like engine-web
    const float h = s.size.y * s.scale.y * zoom;
    if (w == 0 || h == 0 || !(s.tint.a > 0)) return;

    std::optional<AtlasRegion> region;
    if (s.image.valid()) region = textures.region(s.image, std::max(std::abs(w), std::abs(h)) * raster_scale);
    UvRect uv;
    if (region) {
      // The sub-rectangle `src` of the image, inside the image's atlas rectangle.
      const UvRect& r = region->uv;
      uv = {r.u0 + (r.u1 - r.u0) * s.src.u0, r.v0 + (r.v1 - r.v0) * s.src.v0, r.u0 + (r.u1 - r.u0) * s.src.u1,
            r.v0 + (r.v1 - r.v0) * s.src.v1};
    } else {
      region = white();  // no image, or it failed to load: a solid rect
      uv = region->uv;
    }
    if (s.flip_h) std::swap(uv.u0, uv.u1);
    if (s.flip_v) std::swap(uv.v0, uv.v1);

    const Vec2 a = to_ref(s.position.x, s.position.y, s.z);
    float x = a.x - s.anchor.x * w;
    float y = a.y - s.anchor.y * h;
    if (s.rotation == 0) {
      x = snap(x);
      y = snap(y);
    }
    rect_quad(region->page, x, y, w, h, uv, pack_color(s.tint, s.blend), s.rotation, a);
  }

  void shadow(const SpriteCmd& s) {
    const ShadowStyle& st = list.shadows;
    const float t = std::clamp(s.z / std::max(1.0f, st.fade_height), 0.0f, 1.0f);
    const float w = std::abs(s.size.x * s.scale.x) * st.width * (1.0f - 0.5f * t) * zoom;
    const float h = w * st.aspect;
    Color c = st.color;
    c.a *= 1.0f - 0.7f * t;
    if (w <= 0 || !(c.a > 0)) return;
    const AtlasRegion r = *textures.region(TextureStore::kShadow);
    const Vec2 g = to_ref(s.position.x, s.position.y, 0);  // on the ground under the sprite
    rect_quad(r.page, g.x - w * 0.5f, g.y - h * 0.5f, w, h, r.uv, pack_color(c));
  }

  void rect(const RectCmd& r) {
    if (!(r.color.a > 0) || r.size.x == 0 || r.size.y == 0) return;
    const AtlasRegion wr = white();
    const uint32_t color = pack_color(r.color, r.blend);
    if (world && r.ground) {
      // Lies on the ground: project all four corners (a diamond in iso).
      const float x0 = r.position.x, y0 = r.position.y, x1 = x0 + r.size.x, y1 = y0 + r.size.y;
      const Vec2 c[4] = {to_ref(x0, y0, r.z), to_ref(x1, y0, r.z), to_ref(x1, y1, r.z), to_ref(x0, y1, r.z)};
      quad(wr.page, c, wr.uv, color);
      return;
    }
    // Upright: stands on its bottom-center point (identical to a plain rect in side/topdown).
    const Vec2 feet = to_ref(r.position.x + r.size.x * 0.5f, r.position.y + r.size.y, r.z);
    const float w = r.size.x * zoom, h = r.size.y * zoom;
    rect_quad(wr.page, snap(feet.x - w * 0.5f), snap(feet.y - h), w, h, wr.uv, color);
  }

  // Glyph quads for one text color at an offset (outline, shadow and fill all use this).
  void text_glyphs(const TextCmd& t, const TextLayout& layout, Vec2 origin, float k, int px, Vec2 offset,
                   uint32_t color) {
    // k: reference px per text px. Glyph bitmaps are `px` em pixels; one bitmap pixel is
    // size/px text px.
    const float bitmap_to_ref = t.size / static_cast<float>(px) * k;
    for (const PlacedGlyph& pg : layout.glyphs) {
      const auto g = fonts.glyph(t.font, pg.glyph, px);
      if (!g || g->blank) continue;
      // Pen position in reference px, snapped to real pixels so glyphs stay crisp.
      const float pen_x = snap_to_grid(origin.x + (pg.x + offset.x) * k, raster_scale);
      const float pen_y = snap_to_grid(origin.y + (pg.y + offset.y) * k, raster_scale);
      rect_quad(g->region.page, pen_x + g->x0 * bitmap_to_ref, pen_y + g->y0 * bitmap_to_ref, g->w * bitmap_to_ref,
                g->h * bitmap_to_ref, g->region.uv, color);
    }
  }

  void text(const TextCmd& t) {
    if (t.text.empty() || !(t.size > 0)) return;
    const Font& font = fonts.font(t.font);
    const TextLayout layout = layout_text(font, t.text, t.size, t.align);
    const float k = zoom;  // reference px per text px
    const int px = std::clamp(static_cast<int>(std::lround(t.size * k * raster_scale)), 1, 256);
    const Vec2 a = to_ref(t.position.x, t.position.y, t.z);
    const Vec2 o = text_block_origin({0, 0}, t.align, layout.width, layout.height);
    const Vec2 origin{a.x + o.x * k, a.y + o.y * k};

    const bool outline = t.outline.a > 0 && t.outline_size > 0;
    auto outlined = [&](Vec2 offset, Color fill, Color edge) {
      if (outline) {
        // 8 offset copies approximate a stroke (MSDF text, with real outlines, is later work).
        const float d = t.outline_size;
        const Vec2 dirs[8] = {{-d, 0}, {d, 0}, {0, -d}, {0, d}, {-d * 0.7f, -d * 0.7f}, {d * 0.7f, -d * 0.7f},
                              {-d * 0.7f, d * 0.7f}, {d * 0.7f, d * 0.7f}};
        for (const Vec2& dir : dirs) {
          text_glyphs(t, layout, origin, k, px, {offset.x + dir.x, offset.y + dir.y}, pack_color(edge));
        }
      }
      text_glyphs(t, layout, origin, k, px, offset, pack_color(fill));
    };
    if (t.shadow.a > 0) outlined(t.shadow_offset, t.shadow, t.shadow);
    outlined({0, 0}, t.color, t.outline);
  }

  void tiles(const TileChunkCmd& c) {
    const float ts = c.tile_size;
    if (!(ts > 0)) return;
    const AtlasRegion wr = white();
    for (const Tile& tile : c.tiles) {
      std::optional<AtlasRegion> region;
      if (tile.image.valid()) region = textures.region(tile.image, ts * zoom * raster_scale);
      if (!region) {
        if (tile.image.valid() || !(tile.color.a > 0)) continue;  // broken image, or invisible
        region = wr;
      }
      const float x0 = c.origin.x + tile.col * ts, y0 = c.origin.y + tile.row * ts;
      const float x1 = x0 + ts, y1 = y0 + ts;
      Vec2 q[4] = {to_ref(x0, y0, 0), to_ref(x1, y0, 0), to_ref(x1, y1, 0), to_ref(x0, y1, 0)};
      if (params.pixel_snap && list.view != ViewMode::Iso) {
        for (Vec2& p : q) p = {snap(p.x), snap(p.y)};
      }
      quad(region->page, q, region->uv, pack_color(tile.color));
    }
  }

  // Routes the item to its batch list and clip, then builds its quads.
  void item(const DrawRef& ref) {
    clip = {};
    bool emissive = false;
    switch (ref.kind) {
      case DrawKind::Sprite: clip = list.sprites[ref.index].clip; emissive = list.sprites[ref.index].emissive; break;
      case DrawKind::Shadow: clip = list.sprites[ref.index].clip; break;
      case DrawKind::Rect: clip = list.rects[ref.index].clip; break;
      case DrawKind::Text: clip = list.texts[ref.index].clip; emissive = list.texts[ref.index].emissive; break;
      case DrawKind::TileChunk: break;
    }
    if (world) batches = emissive && list.lighting.enabled ? &out.emissive : &out.world;
    switch (ref.kind) {
      case DrawKind::Sprite: sprite(list.sprites[ref.index]); break;
      case DrawKind::Shadow: shadow(list.sprites[ref.index]); break;
      case DrawKind::Rect: rect(list.rects[ref.index]); break;
      case DrawKind::Text: text(list.texts[ref.index]); break;
      case DrawKind::TileChunk: tiles(list.tile_chunks[ref.index]); break;
    }
  }
};

}  // namespace

void build_geometry(const DrawList& list, const SortedDrawList& sorted, TextureStore& textures, FontStore& fonts,
                    const GeometryParams& params, FrameGeometry& out) {
  out.clear();
  Builder b{list, textures, fonts, params, out};

  // World pass. The background (clear_color) is the first quad, covering the reference screen.
  b.batches = &out.world;
  b.world = true;
  b.zoom = list.camera.zoom > 0 ? list.camera.zoom : 1;
  b.raster_scale = params.world_raster_scale;
  b.cam = snapped_camera_center(list.view, list.camera, params.pixel_snap);
  {
    const AtlasRegion wr = *textures.region(TextureStore::kWhite);
    const float w = static_cast<float>(params.ref_w), h = static_cast<float>(params.ref_h);
    const Vec2 c[4] = {{0, 0}, {w, 0}, {w, h}, {0, h}};
    push_quad(out, out.world, wr.page, c, wr.uv, pack_color(list.clear_color));
  }
  for (const DrawRef& ref : sorted.world) b.item(ref);

  // Screen (UI) pass: reference px, no camera.
  b.batches = &out.screen;
  b.world = false;
  b.zoom = 1;
  b.raster_scale = params.screen_raster_scale;
  for (const DrawRef& ref : sorted.screen) b.item(ref);
}

}  // namespace dreamsy::render
