#include "render/image.h"

#include <cstring>
#include <string>

#include "nanosvg.h"
#include "nanosvgrast.h"
#include "stb_image.h"

namespace dreamsy::render {

namespace {

bool ends_with(std::string_view s, std::string_view suffix) {
  if (s.size() < suffix.size()) return false;
  for (size_t i = 0; i < suffix.size(); i++) {
    char c = s[s.size() - suffix.size() + i];
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    if (c != suffix[i]) return false;
  }
  return true;
}

}  // namespace

ImageFormat image_format_from_name(std::string_view name) {
  if (ends_with(name, ".png")) return ImageFormat::Png;
  if (ends_with(name, ".jpg") || ends_with(name, ".jpeg")) return ImageFormat::Jpg;
  if (ends_with(name, ".svg")) return ImageFormat::Svg;
  if (ends_with(name, ".webp")) return ImageFormat::WebP;
  return ImageFormat::Unknown;
}

Result<Image> decode_raster(std::span<const uint8_t> bytes, ImageFormat format) {
  if (format == ImageFormat::WebP) {
    return Error{"WebP images are not supported by the C++ engine yet; use PNG, JPG or SVG"};
  }
  if (format != ImageFormat::Png && format != ImageFormat::Jpg) return Error{"not a PNG or JPG image"};
  if (bytes.empty() || bytes.size() > static_cast<size_t>(INT32_MAX)) return Error{"empty or oversized image file"};

  // Check the size from the header before decoding anything (untrusted input).
  int w = 0, h = 0, channels = 0;
  const int len = static_cast<int>(bytes.size());
  if (!stbi_info_from_memory(bytes.data(), len, &w, &h, &channels)) {
    return Error{std::string("can't read image: ") + stbi_failure_reason()};
  }
  if (w <= 0 || h <= 0 || w > kMaxImageSide || h > kMaxImageSide) {
    return Error{"image is " + std::to_string(w) + "x" + std::to_string(h) + " pixels; the limit is " +
                 std::to_string(kMaxImageSide) + " per side"};
  }

  // stbi_load_* returns malloc'ed memory: copy it into our vector, then free it.
  uint8_t* data = stbi_load_from_memory(bytes.data(), len, &w, &h, &channels, 4);
  if (!data) return Error{std::string("can't decode image: ") + stbi_failure_reason()};
  Image img;
  img.width = w;
  img.height = h;
  img.pixels.assign(data, data + static_cast<size_t>(w) * h * 4);
  stbi_image_free(data);
  return img;
}

// ---------------------------------------------------------------- SVG

void Svg::Deleter::operator()(NSVGimage* image) const { nsvgDelete(image); }

Result<Svg> Svg::parse(std::string_view text) {
  // nsvgParse() edits the string it parses, so it gets a private, NUL-terminated copy.
  std::string copy(text);
  NSVGimage* image = nsvgParse(copy.data(), "px", 96.0f);
  if (!image) return Error{"can't parse SVG"};
  std::unique_ptr<NSVGimage, Deleter> owned(image);
  if (!(image->width > 0) || !(image->height > 0)) return Error{"SVG has no size (set width/height or a viewBox)"};
  return Svg(std::move(owned));
}

float Svg::width() const { return image_->width; }
float Svg::height() const { return image_->height; }

Result<Image> Svg::rasterize(int w, int h) const {
  if (w <= 0 || h <= 0 || w > kMaxImageSide || h > kMaxImageSide) return Error{"bad SVG raster size"};
  struct RastDeleter {
    void operator()(NSVGrasterizer* r) const { nsvgDeleteRasterizer(r); }
  };
  std::unique_ptr<NSVGrasterizer, RastDeleter> rast(nsvgCreateRasterizer());
  if (!rast) return Error{"out of memory"};

  Image img;
  img.width = w;
  img.height = h;
  img.pixels.assign(static_cast<size_t>(w) * h * 4, 0);
  // nanosvg scales uniformly. Callers ask for the intrinsic aspect ratio, so x and y agree;
  // if they don't, scale to fit and center (like preserveAspectRatio="xMidYMid meet").
  const float sx = static_cast<float>(w) / image_->width;
  const float sy = static_cast<float>(h) / image_->height;
  const float s = sx < sy ? sx : sy;
  const float tx = (static_cast<float>(w) - image_->width * s) * 0.5f;
  const float ty = (static_cast<float>(h) - image_->height * s) * 0.5f;
  nsvgRasterize(rast.get(), image_.get(), tx, ty, s, img.pixels.data(), w, h, w * 4);
  return img;
}

void premultiply(Image& img) {
  uint8_t* p = img.pixels.data();
  const size_t n = img.pixels.size() / 4;
  for (size_t i = 0; i < n; i++, p += 4) {
    const unsigned a = p[3];
    if (a == 255) continue;
    // (c * a + 127) / 255, rounded
    p[0] = static_cast<uint8_t>((p[0] * a + 127) / 255);
    p[1] = static_cast<uint8_t>((p[1] * a + 127) / 255);
    p[2] = static_cast<uint8_t>((p[2] * a + 127) / 255);
  }
}

}  // namespace dreamsy::render
