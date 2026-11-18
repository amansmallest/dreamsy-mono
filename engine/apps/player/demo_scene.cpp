#include "demo_scene.h"

#include <cmath>
#include <string>

#include "base/log.h"
#include "pkg/formats.h"

namespace dreamsy::player {

using namespace dreamsy::render;

namespace {

constexpr float kTile = 16;
constexpr float kPi = 3.14159265f;

Color rgb(uint32_t hex, float a = 1) {
  return {static_cast<float>((hex >> 16) & 255) / 255.0f, static_cast<float>((hex >> 8) & 255) / 255.0f,
          static_cast<float>(hex & 255) / 255.0f, a};
}

float fsin(double v) { return static_cast<float>(std::sin(v)); }
float fcos(double v) { return static_cast<float>(std::cos(v)); }

}  // namespace

const char* view_mode_name(ViewMode view) {
  switch (view) {
    case ViewMode::Side: return "side";
    case ViewMode::TopDown: return "topdown";
    case ViewMode::Oblique: return "oblique";
    case ViewMode::Iso: return "iso";
  }
  return "?";
}

DemoScene::DemoScene(const pkg::Package& package, TextureStore& textures, const RenderStyle& style)
    : package_(package), textures_(textures), style_(style) {
  // The package's level: the first TileMap2D's tileset + grid (feature-demo: world.json + level.txt).
  pkg::ResolvedTileMap map =
      pkg::resolve_tilemap(package.files, "data/tilesets/world.json", "file:data/levels/level.txt");
  if (!map.tileset) {
    log_warn("demo: the package has no data/tilesets/world.json + data/levels/level.txt; no level shown");
    return;
  }
  level_cols_ = static_cast<int>(map.cols);
  level_rows_ = static_cast<int>(map.rows.size());
  for (int row = 0; row < level_rows_; row++) {
    const std::string& line = map.rows[static_cast<size_t>(row)];
    for (int col = 0; col < static_cast<int>(line.size()); col++) {
      auto it = map.tileset->tiles.find(line[static_cast<size_t>(col)]);
      if (it == map.tileset->tiles.end()) continue;
      Tile t;
      t.col = static_cast<uint16_t>(col);
      t.row = static_cast<uint16_t>(row);
      if (it->second.sprite) t.image = textures_.find_asset(*it->second.sprite);
      if (it->second.color) t.color = parse_hex_color(*it->second.color).value_or(Color{});
      level_tiles_.push_back(t);
    }
  }
}

void DemoScene::build(DrawList& out, ViewMode view, double t, const FrameStats& stats) const {
  out.clear();
  out.view = view;
  out.clear_color = style_.clear_color;
  if (view == ViewMode::Side) {
    build_side(out, t);
  } else {
    build_ground(out, view, t);
  }
  build_ui(out, view, stats);
}

// Side view: the package's platformer level, as engine-web draws it today.
void DemoScene::build_side(DrawList& out, double t) const {
  const float level_w = static_cast<float>(level_cols_) * kTile;
  const float level_h = static_cast<float>(level_rows_) * kTile;
  out.camera = {{level_w * 0.5f, level_h * 0.5f + 8}, static_cast<float>(style_.ref_w) / std::max(level_w, 1.0f)};

  TileChunkCmd chunk;
  chunk.tile_size = kTile;
  chunk.tiles = level_tiles_;
  out.add(chunk);

  const float ground = 17 * kTile;  // top of the grass row
  // A fox running back and forth on the ground (run animation, flips when turning).
  {
    const float phase = static_cast<float>(std::fmod(t * 0.25, 1.0));
    const bool right = phase < 0.5f;
    const float k = right ? phase * 2 : (1 - phase) * 2;
    SpriteCmd fox;
    const char* run[] = {"fox_run_1", "fox_idle_1", "fox_run_2", "fox_idle_1"};
    fox.image = image(run[static_cast<int>(t * 12) % 4]);
    fox.position = {40 + k * (level_w - 80), ground};
    fox.anchor = {0.5f, 1};
    fox.flip_h = !right;
    fox.sort.z_index = 1;
    out.add(fox);
  }
  // A fox jumping in place: height z with a drop shadow on the ground.
  {
    SpriteCmd fox;
    const float z = 56 * std::abs(fsin(t * 2.6));
    fox.image = image(z > 4 ? "fox_jump" : "fox_idle_1");
    fox.position = {level_w * 0.5f, ground};
    fox.z = z;
    fox.anchor = {0.5f, 1};
    fox.shadow = true;
    fox.sort.z_index = 1;
    out.add(fox);
  }
  // Slimes on the platforms (2-frame animation).
  const Vec2 platforms[] = {{19.5f * kTile, 9 * kTile}, {11 * kTile, 11 * kTile}, {5 * kTile, 13 * kTile},
                            {23 * kTile, 13 * kTile}};
  for (int i = 0; i < 4; i++) {
    SpriteCmd slime;
    slime.image = image(static_cast<int>(t * 4 + i) % 2 ? "slime_1" : "slime_2");
    slime.position = platforms[i];
    slime.anchor = {0.5f, 1};
    slime.flip_h = i % 2 == 1;
    out.add(slime);
    // A spinning coin above each platform, with additive sparks orbiting it.
    SpriteCmd coin;
    coin.image = image("coin");
    coin.position = {platforms[i].x, platforms[i].y - 34 + 3 * fsin(t * 3 + i)};
    coin.rotation = static_cast<float>(t * 1.5 + i);
    out.add(coin);
    for (int s = 0; s < 3; s++) {
      SpriteCmd spark;
      spark.image = image("spark");
      const double a = t * 2.5 + s * 2.1 + i;
      spark.position = {coin.position.x + 13 * fcos(a), coin.position.y + 13 * fsin(a)};
      spark.size = {6, 6};
      spark.tint = rgb(0xffcd75, 0.9f);
      spark.blend = BlendMode::Add;
      spark.sort.z_index = 2;
      out.add(spark);
    }
  }
  // An owl flying across in front of everything (z_index 3).
  {
    SpriteCmd owl;
    owl.image = image("owl");
    owl.position = {level_w * 0.5f + level_w * 0.4f * fsin(t * 0.7), 70 + 20 * fsin(t * 2.1)};
    owl.flip_h = fcos(t * 0.7) < 0;
    owl.scale = {1.5f, 1.5f};
    owl.sort.z_index = 3;
    out.add(owl);
  }
  // World text (a Text2D): pixel font, outline + shadow.
  TextCmd title;
  title.text = "SIDE VIEW";
  title.font = FontId::Pixel;
  title.size = 16;
  title.position = {level_w * 0.5f, 32};
  title.color = rgb(0xffcd75);
  title.outline = rgb(0x1a1c2c);
  title.outline_size = 1;
  title.shadow = rgb(0x000000, 0.5f);
  title.shadow_offset = {1, 1};
  title.sort.z_index = 4;
  out.add(title);
}

// Topdown / oblique / iso: a grass field with walkers circling pillars, so items keep passing
// in front of and behind each other (depth sorting), plus jumpers with shadows.
void DemoScene::build_ground(DrawList& out, ViewMode view, double t) const {
  constexpr int kN = 12;  // field size in tiles
  const float field = kN * kTile;
  const float zoom = view == ViewMode::Iso ? static_cast<float>(style_.ref_w) * 0.95f / (2 * field)
                                           : static_cast<float>(style_.ref_w) * 0.85f / field;
  out.camera = {{field * 0.5f, field * 0.5f}, zoom};

  // Ground: grass with a stone border and a dirt path, one chunk.
  TileChunkCmd chunk;
  chunk.tile_size = kTile;
  // The package's tiles are side-view art, so the field is solid-color tiles (a checkerboard of
  // two greens and a sand path) inside a border of the package's stone tile.
  const ImageId stone = image("tile_stone");
  for (int r = 0; r < kN; r++) {
    for (int c = 0; c < kN; c++) {
      Tile tile;
      tile.col = static_cast<uint16_t>(c);
      tile.row = static_cast<uint16_t>(r);
      const bool border = r == 0 || c == 0 || r == kN - 1 || c == kN - 1;
      if (border) {
        tile.image = stone;
      } else if (c == kN / 2 || r == kN / 2) {
        tile.color = rgb(0xc9a46a);
      } else {
        tile.color = (r + c) % 2 ? rgb(0x38b764) : rgb(0x2fa15a);
      }
      chunk.tiles.push_back(tile);
    }
  }
  out.add(chunk);

  // A translucent zone painted on the ground (a diamond in iso).
  RectCmd zone;
  zone.position = {2 * kTile, 2 * kTile};
  zone.size = {3 * kTile, 3 * kTile};
  zone.color = rgb(0x41a6f6, 0.35f);
  zone.ground = true;
  out.add(zone);

  // Pillars: upright rects standing on the ground.
  const Vec2 pillars[] = {{field * 0.5f, field * 0.5f}, {field * 0.25f, field * 0.7f}, {field * 0.75f, field * 0.3f}};
  for (const Vec2& p : pillars) {
    RectCmd top;  // lighter cap so the pillar reads as a block
    top.size = {12, 30};
    top.position = {p.x - 6, p.y - 30};
    top.color = rgb(0x566c86);
    out.add(top);
  }

  // Walkers on a circle around the middle pillar.
  const char* walkers[] = {"fox_run_1", "slime_1", "fox_run_2", "owl", "slime_2", "fox_idle_1", "coin", "fox_jump"};
  for (int i = 0; i < 8; i++) {
    const double a = t * 0.6 + i * (2.0 * kPi / 8);
    SpriteCmd s;
    s.image = image(walkers[i]);
    s.position = {field * 0.5f + 52 * fcos(a), field * 0.5f + 52 * fsin(a)};
    s.anchor = {0.5f, 1};
    s.flip_h = fsin(a) > 0;
    out.add(s);
  }
  // Jumpers with drop shadows (oblique/iso show the height best).
  for (int i = 0; i < 3; i++) {
    SpriteCmd s;
    const float z = 36 * std::abs(fsin(t * 2.2 + i * 0.9));
    s.image = image(z > 3 ? "fox_jump" : "fox_idle_1");
    s.position = {field * (0.3f + 0.2f * static_cast<float>(i)), field * 0.88f - static_cast<float>(i) * 6};
    s.z = z;
    s.anchor = {0.5f, 1};
    s.shadow = true;
    out.add(s);
  }
  // A row of coins along a diagonal, each with an additive glow.
  for (int i = 0; i < 6; i++) {
    SpriteCmd coin;
    coin.image = image("coin");
    coin.position = {field * 0.12f + static_cast<float>(i) * 14, field * 0.18f + static_cast<float>(i) * 8};
    coin.z = 6 + 2 * fsin(t * 3 + i);
    coin.size = {12, 12};
    coin.anchor = {0.5f, 1};
    coin.shadow = true;
    out.add(coin);
    SpriteCmd glow;
    glow.image = image("spark");
    glow.position = coin.position;
    glow.z = coin.z + 4;
    glow.size = {10, 10};
    glow.tint = rgb(0xffcd75, 0.6f + 0.3f * fsin(t * 5 + i));
    glow.blend = BlendMode::Add;
    glow.anchor = {0.5f, 1};
    glow.sort.sort_offset = 0.1f;  // just in front of its coin
    out.add(glow);
  }
  // A world label floating over the middle pillar.
  TextCmd label;
  label.text = view_mode_name(view);
  label.font = FontId::Pixel;
  label.size = 8;
  label.position = {field * 0.5f, field * 0.5f};
  label.z = 44;
  label.color = rgb(0xf4f4f4);
  label.outline = rgb(0x1a1c2c);
  label.outline_size = 1;
  label.sort.sort_offset = 1;
  out.add(label);
}

void DemoScene::build_ui(DrawList& out, ViewMode view, const FrameStats& stats) const {
  const float w = static_cast<float>(style_.ref_w), h = static_cast<float>(style_.ref_h);
  RectCmd panel;
  panel.space = Space::Screen;
  panel.position = {24, 24};
  panel.size = {w - 48, 132};
  panel.color = rgb(0x333c57, 0.85f);
  out.add(panel);
  RectCmd accent = panel;
  accent.size = {w - 48, 6};
  accent.color = rgb(0x3b5dc9);
  out.add(accent);

  TextCmd title;
  title.space = Space::Screen;
  title.text = package_.manifest.name + " - renderer";
  title.font = FontId::Pixel;
  title.size = 24;
  title.align = TextAlign::Left;
  title.position = {48, 66};
  title.color = rgb(0xf4f4f4);
  title.shadow = rgb(0x000000, 0.6f);
  title.shadow_offset = {3, 3};
  out.add(title);

  TextCmd mode = title;
  mode.text = std::string("view: ") + view_mode_name(view) + "    keys 1-4 / Tab";
  mode.font = FontId::Bold;
  mode.size = 26;
  mode.position = {48, 116};
  mode.color = rgb(0xffcd75);
  out.add(mode);

  // The other three fonts, bottom of the screen, with live stats.
  const char* samples[] = {"Rounded: Nunito ExtraBold", "Bold: Inter Bold", "Serif: Source Serif 4"};
  const FontId fonts[] = {FontId::Rounded, FontId::Bold, FontId::Serif};
  for (int i = 0; i < 3; i++) {
    TextCmd t;
    t.space = Space::Screen;
    t.text = samples[i];
    t.font = fonts[i];
    t.size = 28;
    t.position = {w * 0.5f, h - 190 + 40 * static_cast<float>(i)};
    t.color = rgb(0xf4f4f4);
    t.outline = rgb(0x1a1c2c);
    t.outline_size = 2;
    out.add(t);
  }
  TextCmd s;
  s.space = Space::Screen;
  s.text = std::to_string(stats.draw_calls) + " draw calls   " + std::to_string(stats.quads) + " quads   " +
           std::to_string(stats.atlas_pages) + " atlas page" + (stats.atlas_pages == 1 ? "" : "s");
  s.font = FontId::Pixel;
  s.size = 16;
  s.position = {w * 0.5f, h - 50};
  s.color = rgb(0x94b0c2);
  out.add(s);
}

}  // namespace dreamsy::player
