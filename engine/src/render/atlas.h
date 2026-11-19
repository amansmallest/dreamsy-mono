// Runtime texture atlas: packs many small images into a few big pages (stb_rect_pack), so the
// renderer can draw sprites from different images in one draw call (docs/engine.md §14.12).
//
// CPU only. Each page keeps its pixels and a version number that changes whenever an image is
// added; the renderer re-uploads a page when its version changes. Images are packed on the fly
// as the game first uses them (shelf/skyline packing, no repacking of what is already placed).
//
// Each image gets `padding` pixels of its own edge pixels around it ("extrusion"), so linear
// filtering never blends in a neighbor. Images bigger than a page get a page of their own.
#pragma once

#include <cstdint>
#include <memory>
#include <vector>

#include "base/result.h"
#include "render/draw_list.h"
#include "render/image.h"

namespace dreamsy::render {

struct AtlasRegion {
  uint16_t page = 0;
  int x = 0, y = 0, w = 0, h = 0;  // pixels inside the page (without padding)
  UvRect uv;                       // the same rectangle in 0..1 texture coordinates
};

struct AtlasPage {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> pixels;  // RGBA8, premultiplied
  uint32_t version = 0;         // bumps on every change
};

struct AtlasOptions {
  int page_size = 2048;  // WebGL2 guarantees at least 2048x2048 textures
  int padding = 1;
  int max_pages = 16;
};

class Atlas {
 public:
  explicit Atlas(AtlasOptions options = {});
  ~Atlas();
  Atlas(Atlas&&) noexcept;
  Atlas& operator=(Atlas&&) noexcept;

  // Copies `img` (premultiplied RGBA) into a page and returns where it went.
  Result<AtlasRegion> add(const Image& img);

  size_t page_count() const;
  const AtlasPage& page(size_t index) const;
  const AtlasOptions& options() const { return options_; }

  // Bytes of pixel memory held by all pages.
  size_t memory_bytes() const;

 private:
  struct Page;  // AtlasPage + the packer's state (atlas.cpp)
  Page* new_page(int width, int height);

  AtlasOptions options_;
  std::vector<std::unique_ptr<Page>> pages_;  // unique_ptr: the packer keeps pointers into a Page
};

}  // namespace dreamsy::render
