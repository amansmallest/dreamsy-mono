// The draw list: everything the renderer draws in one frame, as plain data.
//
// The world (E3) fills a DrawList each frame from the entities; the renderer sorts it by the
// scene's view mode (sort.h), turns it into batched quads (geometry.h) and draws them (renderer.h).
// Nothing here touches the GPU, so the world, tools and tests can build draw lists anywhere.
//
// Coordinates (same as engine-web, DREAMSY.MD §11.1):
//   - World space: world pixels, x right, y down (in every view mode). 2.5D items also have a height
//     `z` above the ground (z up). At camera zoom 1, one world pixel is one reference pixel.
//   - Screen space: reference pixels (720x1280 portrait, 1280x720 landscape), (0,0) top-left. UI.
//
// How world points reach the screen depends on the view mode (DREAMSY.MD §14.5, view.h project()):
//   side, topdown, oblique:  screen = (x, y - z)
//   iso (2:1 diamond):       screen = (x - y, (x + y) / 2 - z)
//
// Sprites and text are billboards: their anchor point is projected, then they are drawn upright.
// Tiles and ground rects lie on the ground plane: their corners are projected (diamonds in iso).
// Blocks (sprites with a `height`, in topdown/oblique/iso) are boxes: a top face at z + height over
// their footprint plus the visible side faces (the front in topdown/oblique, two faces in iso).
#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace dreamsy::render {

struct Vec2 {
  float x = 0;
  float y = 0;
};

// Straight (not premultiplied) RGBA, 0..1, in sRGB like CSS colors.
struct Color {
  float r = 1, g = 1, b = 1, a = 1;
};

// A rectangle in normalized texture coordinates (0..1) of an image; the default is the whole image.
struct UvRect {
  float u0 = 0, v0 = 0, u1 = 1, v1 = 1;
};

// An image known to the TextureStore (textures.h). 0 means "no image": the item draws as a solid
// color. Get one with TextureStore::find_asset("asset:coin") and keep it; lookups are by string.
struct ImageId {
  uint32_t value = 0;
  bool valid() const { return value != 0; }
  friend bool operator==(ImageId a, ImageId b) { return a.value == b.value; }
};

// Per scene (manifest `view`, DREAMSY.MD §14.5).
enum class ViewMode : uint8_t { Side, TopDown, Oblique, Iso };

// Alpha = normal blending; Add = additive (glows, particles). Entity prop `blend`: "normal" | "add".
enum class BlendMode : uint8_t { Alpha, Add };

// World items are depth-sorted and drawn with the camera; Screen items are UI, drawn on top.
enum class Space : uint8_t { World, Screen };

// The engine-web theme fonts (core/theme.ts). Default = the game's theme font ([ui] font).
enum class FontId : uint8_t { Default, Pixel, Rounded, Bold, Serif };

enum class TextAlign : uint8_t { Left, Center, Right };

// Where an item sits in the draw order. Every item has one.
//
// Order of drawing (sort.h), within the same Space:
//   1. `layer`   (render layers; lower first)
//   2. `z_index` (sub-layer inside a layer, like Godot: background at -1 stays behind)
//   3. then by view mode: side = submission order; topdown = y; oblique = y, then z; iso = x+y, then z
//      (blocks sort by their footprint's center; something standing on a block sorts right after it)
//   4. ties: submission order (stable), so equal items never flicker
struct SortInfo {
  int32_t layer = 0;
  int32_t z_index = 0;
  float sort_offset = 0;  // added to the depth (y or x+y) in topdown/oblique/iso
  uint32_t order = 0;     // submission order; set by DrawList::add() (scene tree order in E3)
};

// A textured (or solid) quad, drawn upright at its projected anchor.
struct SpriteCmd {
  ImageId image;  // invalid = solid `tint` rect
  UvRect src;     // region of the image (sprite sheets)

  // World transform. `position` is the anchor point on the ground (x, y) at height `z`.
  Vec2 position;
  float z = 0;  // height above the ground (2.5D)
  // 2.5D block: > 0 in topdown/oblique/iso draws a box this tall over the footprint `size` x
  // `scale`, centered on `position` (anchor and rotation are ignored), top face at z + height.
  float height = 0;
  // Height of the ground under `position` (the top of a block it stands or hovers over; 0 =
  // the floor). The drop shadow lies at this height, and an item on raised ground sorts after
  // the block it stands on.
  float ground_z = 0;
  float rotation = 0;  // radians, clockwise on screen
  Vec2 scale{1, 1};
  Vec2 size{16, 16};      // world pixels before scale
  Vec2 anchor{0.5f, 0.5f};  // which point of the quad sits on `position`: (0.5, 0.5) center, (0.5, 1) feet
  bool flip_h = false;
  bool flip_v = false;

  Color tint;
  BlendMode blend = BlendMode::Alpha;
  bool shadow = false;  // draw a drop shadow on the ground (ground_z) under the sprite when z > ground_z
  Space space = Space::World;
  SortInfo sort;
};

// A solid rectangle. `position` is the top-left corner. With `ground` set (world space only), the
// rectangle lies on the ground plane (a diamond in iso); otherwise it is upright like a sprite.
struct RectCmd {
  Vec2 position;
  Vec2 size{16, 16};
  float z = 0;
  Color color;
  bool ground = false;
  BlendMode blend = BlendMode::Alpha;
  Space space = Space::World;
  SortInfo sort;
};

// A run of text. The block is vertically centered on `position`; `align` places it horizontally
// (engine-web core/view2d.ts text2DOrigin: left edge / center / right edge at position.x).
// Lines are separated by '\n'; line height is 1.2 x size (engine-web).
struct TextCmd {
  std::string text;  // UTF-8
  FontId font = FontId::Default;
  float size = 16;  // pixels (world or reference)
  Color color;
  TextAlign align = TextAlign::Center;
  Vec2 position;
  float z = 0;
  Color outline{0, 0, 0, 0};  // alpha 0 = none
  float outline_size = 0;
  Color shadow{0, 0, 0, 0};  // alpha 0 = none
  Vec2 shadow_offset{2, 2};
  Space space = Space::World;
  SortInfo sort;
};

// One cell of a tile chunk.
struct Tile {
  uint16_t col = 0;  // inside the chunk
  uint16_t row = 0;
  ImageId image;      // invalid = solid `color`
  Color color;        // tint for images, fill for solid tiles
};

// A block of tiles on the ground plane (engine-web cuts TileMap2D into 32x32-tile chunks).
// Tile (col, row) covers world [origin + col*tile_size, origin + (col+1)*tile_size).
// A chunk sorts as one flat item: below upright items of the same layer and z_index in
// topdown/oblique/iso. Raised tile maps (TileMap2D `height` > 0) are drawn as one block
// (SpriteCmd with a height) per tile instead.
struct TileChunkCmd {
  Vec2 origin;  // world position of tile (0, 0)'s top-left corner
  float z = 0;  // height of the layer above the ground (2.5D)
  float tile_size = 16;
  std::vector<Tile> tiles;
  SortInfo sort;
};

// The camera (engine-web Game.cameraView): `center` is the world point (on the ground) at the
// center of the screen. Zoom 2 shows half as much world, twice as big.
struct Camera {
  Vec2 center;
  float zoom = 1;
};

// Drop shadows under raised sprites (z > ground_z): a soft ellipse on the ground (blocks: their
// footprint, darkened).
struct ShadowStyle {
  Color color{0, 0, 0, 0.35f};
  float width = 0.8f;    // x sprite width
  float aspect = 0.35f;  // ellipse height / width
  float fade_height = 160;  // height above the ground at which the shadow is smallest and faintest
};

// How much darker the side faces of 2.5D blocks are than the top (multiplies the tint's RGB):
// front = topdown/oblique front face and the iso left face, right = the iso right face.
struct BlockShade {
  float front = 0.62f;
  float right = 0.48f;
};

struct DrawList {
  ViewMode view = ViewMode::Side;
  Camera camera;
  Color clear_color{0.1f, 0.11f, 0.17f, 1};  // inside the game rect
  ShadowStyle shadows;
  BlockShade block_shade;

  std::vector<SpriteCmd> sprites;
  std::vector<RectCmd> rects;
  std::vector<TextCmd> texts;
  std::vector<TileChunkCmd> tile_chunks;

  // Without a Camera2D the view's top-left is (0, 0) (engine-web), so the camera centers on half
  // the reference screen.
  static Camera default_camera(int ref_w, int ref_h) {
    return Camera{{ref_w * 0.5f, ref_h * 0.5f}, 1};
  }

  // Append an item, stamping its submission order (the final tie-break, and the whole order in
  // side view after layer and z_index). Always add items through these.
  SpriteCmd& add(SpriteCmd c) { return push(sprites, std::move(c)); }
  RectCmd& add(RectCmd c) { return push(rects, std::move(c)); }
  TextCmd& add(TextCmd c) { return push(texts, std::move(c)); }
  TileChunkCmd& add(TileChunkCmd c) { return push(tile_chunks, std::move(c)); }

  void clear() {
    sprites.clear();
    rects.clear();
    texts.clear();
    tile_chunks.clear();
    next_order_ = 0;
  }
  size_t item_count() const { return sprites.size() + rects.size() + texts.size() + tile_chunks.size(); }

 private:
  template <typename T>
  T& push(std::vector<T>& list, T c) {
    c.sort.order = next_order_++;
    list.push_back(std::move(c));
    return list.back();
  }
  uint32_t next_order_ = 0;
};

}  // namespace dreamsy::render
