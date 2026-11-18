#include "render/atlas.h"

#include <algorithm>
#include <cstring>
#include <string>

#include "stb_rect_pack.h"

namespace dreamsy::render {

struct Atlas::Page {
  AtlasPage data;
  stbrp_context packer{};
  std::vector<stbrp_node> nodes;  // the packer's working memory; must not move (hence unique_ptr)
  bool dedicated = false;         // holds one oversized image; never packed into again
};

Atlas::Atlas(AtlasOptions options) : options_(options) {
  options_.page_size = std::clamp(options_.page_size, 16, kMaxImageSide);
  options_.padding = std::clamp(options_.padding, 0, 8);
  options_.max_pages = std::max(1, options_.max_pages);
}

Atlas::~Atlas() = default;
Atlas::Atlas(Atlas&&) noexcept = default;
Atlas& Atlas::operator=(Atlas&&) noexcept = default;

size_t Atlas::page_count() const { return pages_.size(); }
const AtlasPage& Atlas::page(size_t index) const { return pages_.at(index)->data; }

size_t Atlas::memory_bytes() const {
  size_t n = 0;
  for (const auto& p : pages_) n += p->data.pixels.size();
  return n;
}

Atlas::Page* Atlas::new_page(int width, int height) {
  auto page = std::make_unique<Page>();
  page->data.width = width;
  page->data.height = height;
  page->data.pixels.assign(static_cast<size_t>(width) * height * 4, 0);
  page->nodes.resize(static_cast<size_t>(width));
  stbrp_init_target(&page->packer, width, height, page->nodes.data(), static_cast<int>(page->nodes.size()));
  pages_.push_back(std::move(page));
  return pages_.back().get();
}

namespace {

// Copies img into the page at (x, y) (the padded slot's top-left) and repeats its edge pixels
// into the `pad`-pixel ring around it.
void blit_extruded(AtlasPage& page, const Image& img, int x, int y, int pad) {
  const int pw = page.width;
  auto px = [&](int col, int row) { return page.pixels.data() + (static_cast<size_t>(row) * pw + col) * 4; };
  for (int row = -pad; row < img.height + pad; row++) {
    const int src_row = std::clamp(row, 0, img.height - 1);
    const uint8_t* src = img.pixels.data() + static_cast<size_t>(src_row) * img.width * 4;
    uint8_t* dst = px(x + pad, y + pad + row);
    std::memcpy(dst, src, static_cast<size_t>(img.width) * 4);
    for (int i = 1; i <= pad; i++) {
      std::memcpy(dst - i * 4, src, 4);                                         // left edge
      std::memcpy(dst + (img.width - 1 + i) * 4, src + (img.width - 1) * 4, 4);  // right edge
    }
  }
}

}  // namespace

Result<AtlasRegion> Atlas::add(const Image& img) {
  if (img.empty() || img.pixels.size() != static_cast<size_t>(img.width) * img.height * 4) {
    return Error{"bad image for the atlas"};
  }
  const int pad = options_.padding;
  const int slot_w = img.width + 2 * pad;
  const int slot_h = img.height + 2 * pad;
  if (slot_w > kMaxImageSide || slot_h > kMaxImageSide) return Error{"image too large for a texture"};

  Page* target = nullptr;
  int x = 0, y = 0;
  if (slot_w <= options_.page_size && slot_h <= options_.page_size) {
    stbrp_rect r{};
    r.w = slot_w;
    r.h = slot_h;
    for (auto& p : pages_) {
      if (p->dedicated) continue;
      if (stbrp_pack_rects(&p->packer, &r, 1) && r.was_packed) {
        target = p.get();
        break;
      }
    }
    if (!target) {
      if (static_cast<int>(pages_.size()) >= options_.max_pages) {
        return Error{"texture atlas is full (" + std::to_string(options_.max_pages) + " pages)"};
      }
      target = new_page(options_.page_size, options_.page_size);
      if (!stbrp_pack_rects(&target->packer, &r, 1) || !r.was_packed) return Error{"atlas packing failed"};
    }
    x = r.x;
    y = r.y;
  } else {
    // Oversized: a page of its own, exactly as big as the image.
    if (static_cast<int>(pages_.size()) >= options_.max_pages) return Error{"texture atlas is full"};
    target = new_page(slot_w, slot_h);
    target->dedicated = true;
  }

  blit_extruded(target->data, img, x, y, pad);
  target->data.version++;

  AtlasRegion region;
  region.page = static_cast<uint16_t>(std::find_if(pages_.begin(), pages_.end(),
                                                   [&](const auto& p) { return p.get() == target; }) -
                                      pages_.begin());
  region.x = x + pad;
  region.y = y + pad;
  region.w = img.width;
  region.h = img.height;
  const float pw = static_cast<float>(target->data.width);
  const float ph = static_cast<float>(target->data.height);
  const auto f = [](int v) { return static_cast<float>(v); };
  region.uv = {f(region.x) / pw, f(region.y) / ph, f(region.x + region.w) / pw, f(region.y + region.h) / ph};
  return region;
}

}  // namespace dreamsy::render
