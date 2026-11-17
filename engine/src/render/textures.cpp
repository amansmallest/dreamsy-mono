#include "render/textures.h"

#include <algorithm>
#include <cmath>

#include "base/log.h"
#include "pkg/package.h"

namespace dreamsy::render {

namespace {

Image solid_white(int size) {
  Image img;
  img.width = size;
  img.height = size;
  img.pixels.assign(static_cast<size_t>(size) * size * 4, 255);
  return img;
}

// A white disc whose alpha falls off smoothly towards the edge (the drop-shadow blob).
Image soft_disc(int size) {
  Image img;
  img.width = size;
  img.height = size;
  img.pixels.resize(static_cast<size_t>(size) * size * 4);
  const float r = size * 0.5f;
  for (int y = 0; y < size; y++) {
    for (int x = 0; x < size; x++) {
      const float dx = (x + 0.5f - r) / r, dy = (y + 0.5f - r) / r;
      const float d = std::sqrt(dx * dx + dy * dy);  // 0 center .. 1 edge
      const float a = std::clamp((1.0f - d) / 0.35f, 0.0f, 1.0f);  // solid core, soft 35% rim
      uint8_t* p = img.pixels.data() + (static_cast<size_t>(y) * size + x) * 4;
      p[0] = p[1] = p[2] = 255;
      p[3] = static_cast<uint8_t>(std::lround(a * 255));
    }
  }
  return img;
}

}  // namespace

TextureStore::TextureStore(const pkg::Package* package, Atlas& atlas, bool pixel_art)
    : package_(package), atlas_(atlas), pixel_art_(pixel_art) {
  // Ids 1 and 2 are the built-ins (kWhite, kShadow). They are tiny and can't fail to pack.
  auto white = add_image("<white>", solid_white(4));
  auto shadow = add_image("<shadow>", soft_disc(64));
  DREAMSY_CHECK(white.ok() && white.value() == kWhite, "built-in white image");
  DREAMSY_CHECK(shadow.ok() && shadow.value() == kShadow, "built-in shadow image");
}

int TextureStore::svg_raster_bucket(float screen_px) {
  int px = 32;
  while (px < screen_px && px < 1024) px *= 2;
  return px;
}

ImageId TextureStore::find_asset(std::string_view ref) {
  if (ref.substr(0, 6) == "asset:") ref.remove_prefix(6);
  if (auto it = by_asset_.find(ref); it != by_asset_.end()) return it->second;
  ImageId id;  // invalid until proven otherwise
  if (package_) {
    auto it = package_->assets.find(std::string(ref));
    if (it != package_->assets.end() && it->second.kind == pkg::AssetKind::Image) {
      Entry e;
      e.name = it->second.id;
      e.file = "assets/" + it->second.file;
      e.format = image_format_from_name(it->second.file);
      entries_.push_back(std::move(e));
      id = ImageId{static_cast<uint32_t>(entries_.size())};
    }
  }
  if (!id.valid()) log_warn("render: no image asset \"" + std::string(ref) + "\"");
  by_asset_.emplace(std::string(ref), id);  // remembered either way, so the warning prints once
  return id;
}

Result<ImageId> TextureStore::add_image(std::string name, Image image) {
  Entry e;
  e.name = std::move(name);
  e.size = {static_cast<float>(image.width), static_cast<float>(image.height)};
  premultiply(image);
  auto region = atlas_.add(image);
  if (!region) return Error{region.error()};
  e.region = region.value();
  e.loaded = true;
  entries_.push_back(std::move(e));
  return ImageId{static_cast<uint32_t>(entries_.size())};
}

bool TextureStore::fail(Entry& e, const std::string& why) {
  e.failed = true;
  log_warn("render: image \"" + e.name + "\": " + why);
  return false;
}

bool TextureStore::load(Entry& e, float screen_px) {
  if (e.failed) return false;
  if (!package_ || e.file.empty()) return e.loaded;

  // SVG: parse once; (re)rasterize when the wanted size grows (smooth mode only).
  if (e.format == ImageFormat::Svg) {
    if (!e.svg) {
      auto text = package_->files.text(e.file);
      if (!text) return fail(e, "file missing");
      auto svg = Svg::parse(*text);
      if (!svg) return fail(e, svg.error());
      e.size = {svg.value().width(), svg.value().height()};
      e.svg = std::move(svg).value();
    }
    int w = 0, h = 0, px = 0;
    if (pixel_art_) {
      w = static_cast<int>(std::ceil(e.size.x));
      h = static_cast<int>(std::ceil(e.size.y));
    } else {
      px = svg_raster_bucket(screen_px);
      if (e.loaded && e.raster_px >= px) return true;
      const float k = px / std::max(e.size.x, e.size.y);
      w = std::max(1, static_cast<int>(std::lround(e.size.x * k)));
      h = std::max(1, static_cast<int>(std::lround(e.size.y * k)));
    }
    if (e.loaded && pixel_art_) return true;
    w = std::clamp(w, 1, kMaxImageSide);
    h = std::clamp(h, 1, kMaxImageSide);
    auto img = e.svg->rasterize(w, h);
    if (!img) return fail(e, img.error());
    premultiply(img.value());
    // A re-rasterized SVG takes a new slot; the old one stays unused until the atlas is rebuilt
    // (a few KB per resize; sizes only grow and are capped at 1024).
    auto region = atlas_.add(img.value());
    if (!region) return fail(e, region.error());
    e.region = region.value();
    e.raster_px = px;
    e.loaded = true;
    return true;
  }

  if (e.loaded) return true;
  auto bytes = package_->files.bytes(e.file);
  if (!bytes) return fail(e, "file missing");
  auto img = decode_raster(*bytes, e.format);
  if (!img) return fail(e, img.error());
  e.size = {static_cast<float>(img.value().width), static_cast<float>(img.value().height)};
  premultiply(img.value());
  auto region = atlas_.add(img.value());
  if (!region) return fail(e, region.error());
  e.region = region.value();
  e.loaded = true;
  return true;
}

std::optional<AtlasRegion> TextureStore::region(ImageId id, float screen_px) {
  if (!id.valid() || id.value > entries_.size()) return std::nullopt;
  Entry& e = entries_[id.value - 1];
  if (!load(e, screen_px)) return std::nullopt;
  return e.region;
}

std::optional<Vec2> TextureStore::intrinsic_size(ImageId id) {
  if (!id.valid() || id.value > entries_.size()) return std::nullopt;
  Entry& e = entries_[id.value - 1];
  if (!load(e, 0)) return std::nullopt;
  return e.size;
}

}  // namespace dreamsy::render
