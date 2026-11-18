// Decoding package images into RGBA pixels (CPU only).
//
//   PNG, JPG  stb_image
//   SVG       nanosvg (parse + rasterize at any size; packages use SVG sprites heavily)
//   WebP      not supported yet: allowed by the format, but no package uses it, and a decoder
//             (libwebp) would cost ~100 KB of the web download. decode_raster() returns a clear
//             error; the renderer then draws the sprite as a solid rect (like a missing asset).
//
// Packages are untrusted: sizes are capped before decoding (kMaxImageSide).
#pragma once

#include <cstdint>
#include <memory>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

#include "base/result.h"

struct NSVGimage;  // nanosvg (third_party/nanosvg)

namespace dreamsy::render {

inline constexpr int kMaxImageSide = 4096;  // larger images are rejected

// 8-bit RGBA, straight alpha, rows top to bottom.
struct Image {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> pixels;  // width * height * 4

  bool empty() const { return width <= 0 || height <= 0; }
};

enum class ImageFormat { Png, Jpg, Svg, WebP, Unknown };

// From the file extension ("coin.svg" -> Svg).
ImageFormat image_format_from_name(std::string_view file_name);

// PNG / JPG (and a clear error for WebP). SVG goes through Svg below.
Result<Image> decode_raster(std::span<const uint8_t> bytes, ImageFormat format);

// A parsed SVG that can be rasterized at any size.
class Svg {
 public:
  static Result<Svg> parse(std::string_view text);

  // Intrinsic size: width/height attributes, else the viewBox (engine-web textures.ts svgSize).
  float width() const;
  float height() const;

  // Rasterize to w x h pixels (the drawing is scaled to fill, like canvas drawImage).
  Result<Image> rasterize(int w, int h) const;

 private:
  // nanosvg is a C library: its image is freed with nsvgDelete(), which this deleter calls.
  struct Deleter {
    void operator()(NSVGimage* image) const;
  };
  explicit Svg(std::unique_ptr<NSVGimage, Deleter> image) : image_(std::move(image)) {}
  std::unique_ptr<NSVGimage, Deleter> image_;
};

// Premultiplies alpha in place (the renderer blends premultiplied colors).
void premultiply(Image& img);

}  // namespace dreamsy::render
