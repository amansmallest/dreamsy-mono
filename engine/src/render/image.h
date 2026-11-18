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
#include <string>
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

  // <text> elements (nanosvg skips text): drawn by rasterize() with the bundled fonts. Only
  // plain text with x, y, font-size, text-anchor, fill and a serif/sans family is supported; no
  // transforms on the text or its parents (enough for icon labels like "?" or "x2").
  struct Text {
    float x = 0, y = 0;  // baseline anchor, in user (viewBox) units
    float size = 16;
    int anchor = 0;  // -1 start, 0 middle, 1 end
    bool serif = false;
    uint8_t rgba[4] = {0, 0, 0, 255};
    std::string text;
  };
  const std::vector<Text>& texts() const { return texts_; }

 private:
  // nanosvg is a C library: its image is freed with nsvgDelete(), which this deleter calls.
  struct Deleter {
    void operator()(NSVGimage* image) const;
  };
  explicit Svg(std::unique_ptr<NSVGimage, Deleter> image) : image_(std::move(image)) {}
  std::unique_ptr<NSVGimage, Deleter> image_;
  std::vector<Text> texts_;
  float user_to_px_ = 1;  // viewBox units -> nanosvg's image units (width attribute / viewBox width)
  float user_x0_ = 0, user_y0_ = 0;  // viewBox origin
};

// nanosvg reads unitless gradient coordinates (x1="0" y2="1", the SVG default
// gradientUnits="objectBoundingBox") as pixels instead of fractions of the shape's box, so a
// top-to-bottom sky gradient ends after one pixel. This rewrites them as percentages
// (y2="1" -> y2="100%"), which nanosvg scales correctly. Gradients in userSpaceOnUse are left alone.
// Svg::parse applies it; exposed for tests.
std::string fix_bbox_gradients(std::string_view svg);

// nanosvg ignores <use href="#id">. This replaces each <use> with a <g> that copies the referenced
// element (attributes of the <use> other than href/x/y carry over, x/y become a translate), so
// shapes defined once in <defs> and reused draw like in a browser. Svg::parse applies it.
std::string expand_svg_uses(std::string_view svg);

// nanosvg has no <pattern>. A <rect> filled with a userSpaceOnUse pattern becomes a <g> holding one
// translated copy of the pattern's content per tile over the rect (tiles at the rect's edge are not
// clipped). Other pattern uses are left alone. Svg::parse applies it.
std::string expand_svg_patterns(std::string_view svg);

// Premultiplies alpha in place (the renderer blends premultiplied colors).
void premultiply(Image& img);

}  // namespace dreamsy::render
