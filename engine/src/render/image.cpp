#include "render/image.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <optional>
#include <string>

#include "render/font.h"
#include "render/style.h"
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

std::string fix_bbox_gradients(std::string_view svg) {
  std::string out;
  out.reserve(svg.size() + 64);
  size_t pos = 0;
  while (true) {
    // The next <linearGradient or <radialGradient start tag.
    const size_t lin = svg.find("<linearGradient", pos), rad = svg.find("<radialGradient", pos);
    const size_t start = std::min(lin, rad);
    if (start == std::string_view::npos) break;
    const size_t end = svg.find('>', start);
    if (end == std::string_view::npos) break;
    out.append(svg.substr(pos, start - pos));
    std::string tag(svg.substr(start, end - start));
    if (tag.find("userSpaceOnUse") == std::string::npos) {
      // Each coordinate attribute: name="number" (no unit, no %) -> name="number*100%".
      for (const char* name : {"x1", "y1", "x2", "y2", "cx", "cy", "r", "fx", "fy"}) {
        const std::string key = std::string(" ") + name + "=";
        const size_t at = tag.find(key);
        if (at == std::string::npos) continue;
        const size_t q = at + key.size();
        if (q >= tag.size() || (tag[q] != '"' && tag[q] != '\'')) continue;
        const size_t close = tag.find(tag[q], q + 1);
        if (close == std::string::npos) continue;
        const std::string value = tag.substr(q + 1, close - q - 1);
        char* rest = nullptr;
        const double v = std::strtod(value.c_str(), &rest);
        if (value.empty() || rest == value.c_str() || *rest != '\0') continue;  // has a unit or %
        char buf[32];
        std::snprintf(buf, sizeof buf, "%g%%", v * 100);
        tag.replace(q + 1, close - q - 1, buf);
      }
    }
    out.append(tag);
    pos = end;
  }
  out.append(svg.substr(pos));
  return out;
}

namespace {

// The value of attribute `name` in a start tag (`tag` = "<use href=... x=...>"), or nullopt.
std::optional<std::string> tag_attr(std::string_view tag, std::string_view name) {
  for (size_t at = tag.find(name); at != std::string_view::npos; at = tag.find(name, at + 1)) {
    // A whole attribute name: preceded by whitespace, followed by '='.
    if (at == 0 || !std::isspace(static_cast<unsigned char>(tag[at - 1]))) continue;
    size_t q = at + name.size();
    while (q < tag.size() && std::isspace(static_cast<unsigned char>(tag[q]))) q++;
    if (q >= tag.size() || tag[q] != '=') continue;
    q++;
    while (q < tag.size() && std::isspace(static_cast<unsigned char>(tag[q]))) q++;
    if (q >= tag.size() || (tag[q] != '"' && tag[q] != '\'')) continue;
    const size_t close = tag.find(tag[q], q + 1);
    if (close == std::string_view::npos) return std::nullopt;
    return std::string(tag.substr(q + 1, close - q - 1));
  }
  return std::nullopt;
}

// `tag` without the attributes in `drop` (each written name="..." or name='...').
std::string without_attrs(std::string tag, std::initializer_list<std::string_view> drop) {
  for (std::string_view name : drop) {
    for (size_t at = tag.find(name); at != std::string::npos; at = tag.find(name, at + 1)) {
      if (at == 0 || !std::isspace(static_cast<unsigned char>(tag[at - 1]))) continue;
      const size_t eq = at + name.size();
      if (eq + 1 >= tag.size() || tag[eq] != '=' || (tag[eq + 1] != '"' && tag[eq + 1] != '\'')) continue;
      const size_t close = tag.find(tag[eq + 1], eq + 2);
      if (close == std::string::npos) break;
      tag.erase(at - 1, close + 1 - (at - 1));  // with the space before it
      break;
    }
  }
  return tag;
}

// The whole element starting at `start` ("<name ...>...</name>" or "<name .../>"); end = one past it.
std::optional<std::pair<size_t, size_t>> element_at(std::string_view svg, size_t start) {
  const size_t tag_end = svg.find('>', start);
  if (tag_end == std::string_view::npos) return std::nullopt;
  if (svg[tag_end - 1] == '/') return std::make_pair(start, tag_end + 1);
  size_t name_end = start + 1;
  while (name_end < svg.size() && !std::isspace(static_cast<unsigned char>(svg[name_end])) && svg[name_end] != '>' &&
         svg[name_end] != '/') {
    name_end++;
  }
  const std::string name(svg.substr(start + 1, name_end - start - 1));
  // Find the matching close tag, counting nested elements of the same name.
  int depth = 1;
  size_t pos = tag_end + 1;
  while (depth > 0) {
    const size_t open = svg.find("<" + name, pos), close = svg.find("</" + name, pos);
    if (close == std::string_view::npos) return std::nullopt;
    if (open != std::string_view::npos && open < close) {
      const size_t e = svg.find('>', open);
      if (e == std::string_view::npos) return std::nullopt;
      if (svg[e - 1] != '/') depth++;
      pos = e + 1;
    } else {
      depth--;
      pos = svg.find('>', close);
      if (pos == std::string_view::npos) return std::nullopt;
      pos++;
    }
  }
  return std::make_pair(start, pos);
}

// The text content of an element body: tags stripped, the basic entities decoded, trimmed.
std::string plain_text(std::string_view body) {
  std::string out;
  bool in_tag = false;
  for (char c : body) {
    if (c == '<') in_tag = true;
    else if (c == '>') in_tag = false;
    else if (!in_tag) out += c;
  }
  const std::pair<const char*, const char*> entities[] = {{"&lt;", "<"}, {"&gt;", ">"}, {"&quot;", "\""}, {"&#39;", "'"}, {"&amp;", "&"}};
  for (const auto& [from, to] : entities) {
    for (size_t at = out.find(from); at != std::string::npos; at = out.find(from, at + 1)) out.replace(at, std::strlen(from), to);
  }
  const size_t b = out.find_first_not_of(" \t\r\n"), e = out.find_last_not_of(" \t\r\n");
  return b == std::string::npos ? std::string() : out.substr(b, e - b + 1);
}

// The <text> elements outside <defs> (see Svg::Text).
std::vector<Svg::Text> parse_texts(std::string_view svg) {
  std::vector<Svg::Text> out;
  const size_t defs_start = svg.find("<defs"), defs_end = svg.find("</defs>");
  for (size_t at = svg.find("<text"); at != std::string_view::npos; at = svg.find("<text", at + 1)) {
    if (defs_start != std::string_view::npos && at > defs_start && defs_end != std::string_view::npos && at < defs_end) continue;
    const auto el = element_at(svg, at);
    if (!el) break;
    const size_t tag_end = svg.find('>', at);
    const std::string_view tag = svg.substr(at, tag_end - at);
    Svg::Text t;
    t.x = std::strtof(tag_attr(tag, "x").value_or("0").c_str(), nullptr);
    t.y = std::strtof(tag_attr(tag, "y").value_or("0").c_str(), nullptr);
    t.size = std::strtof(tag_attr(tag, "font-size").value_or("16").c_str(), nullptr);
    const std::string anchor = tag_attr(tag, "text-anchor").value_or("start");
    t.anchor = anchor == "middle" ? 0 : anchor == "end" ? 1 : -1;
    const std::string family = tag_attr(tag, "font-family").value_or("");
    t.serif = family.find("serif") != std::string::npos && family.find("sans") == std::string::npos;
    if (auto fill = tag_attr(tag, "fill")) {
      if (auto c = parse_hex_color(*fill)) {
        const float v[4] = {c->r, c->g, c->b, c->a};
        for (int k = 0; k < 4; k++) t.rgba[k] = static_cast<uint8_t>(std::lround(std::clamp(v[k], 0.0f, 1.0f) * 255));
      }
    }
    if (tag_end + 1 < el->second) t.text = plain_text(svg.substr(tag_end + 1, el->second - tag_end - 1));
    if (!t.text.empty() && t.size > 0) out.push_back(std::move(t));
    at = el->second - 1;
  }
  return out;
}

// Draws `t` over `img` (straight alpha) at scale `s` px per image unit plus offset (tx, ty).
void draw_svg_text(Image& img, const Svg::Text& t, float s, float tx, float ty) {
  auto font = Font::load(bundled_font(t.serif ? FontId::Serif : FontId::Bold));
  if (!font) return;
  const float size = t.size * s;
  const int px = std::clamp(static_cast<int>(std::lround(size)), 1, 512);
  const TextLayout layout = layout_text(font.value(), t.text, size, TextAlign::Left);
  float pen_x = tx + t.x * s - (t.anchor == 0 ? layout.width * 0.5f : t.anchor == 1 ? layout.width : 0.0f);
  const float base_y = ty + t.y * s;
  for (const PlacedGlyph& g : layout.glyphs) {
    const Font* face = g.fallback ? symbol_font() : &font.value();
    if (!face) continue;
    const Font::Bitmap bmp = face->rasterize(g.glyph, px);
    const int ox = static_cast<int>(std::lround(pen_x + g.x)) + bmp.x0, oy = static_cast<int>(std::lround(base_y)) + bmp.y0;
    for (int y = 0; y < bmp.height; y++) {
      for (int x = 0; x < bmp.width; x++) {
        const int dx = ox + x, dy = oy + y;
        if (dx < 0 || dy < 0 || dx >= img.width || dy >= img.height) continue;
        const float a = bmp.alpha[static_cast<size_t>(y) * bmp.width + x] / 255.0f * (t.rgba[3] / 255.0f);
        if (a <= 0) continue;
        uint8_t* p = &img.pixels[(static_cast<size_t>(dy) * img.width + dx) * 4];
        const float da = p[3] / 255.0f, oa = a + da * (1 - a);
        for (int k = 0; k < 3; k++) p[k] = static_cast<uint8_t>(std::lround((t.rgba[k] * a + p[k] * da * (1 - a)) / oa));
        p[3] = static_cast<uint8_t>(std::lround(oa * 255));
      }
    }
  }
}

}  // namespace

std::string expand_svg_uses(std::string_view svg) {
  std::string cur(svg);
  for (int pass = 0; pass < 4 && cur.find("<use") != std::string::npos; pass++) {  // nested uses
    std::string out;
    size_t pos = 0;
    while (true) {
      const size_t start = cur.find("<use", pos);
      if (start == std::string::npos) break;
      const auto use = element_at(cur, start);
      if (!use) break;
      out.append(cur, pos, start - pos);
      pos = use->second;
      const std::string tag = cur.substr(start, cur.find('>', start) - start);
      std::optional<std::string> href = tag_attr(tag, "href");
      if (!href) href = tag_attr(tag, "xlink:href");
      if (!href || href->empty() || (*href)[0] != '#') continue;  // drop uses we can't resolve
      // The referenced element: the start tag holding id="<name>".
      const std::string id_attr = "id=\"" + href->substr(1) + "\"";
      size_t id_at = cur.find(id_attr);
      if (id_at == std::string::npos) id_at = cur.find("id='" + href->substr(1) + "'");
      if (id_at == std::string::npos) continue;
      const size_t ref_start = cur.rfind('<', id_at);
      const auto ref = element_at(cur, ref_start);
      if (!ref || ref_start == start) continue;
      std::string body = cur.substr(ref->first, ref->second - ref->first);
      body = without_attrs(body.substr(0, body.find('>')), {"id"}) + body.substr(body.find('>'));  // no duplicate id
      // <g [use's other attributes] transform="[use's transform] translate(x y)">copy</g>
      std::string g = "<g" + without_attrs(tag.substr(4), {"href", "xlink:href", "x", "y", "width", "height", "transform"});
      if (!g.empty() && g.back() == '/') g.pop_back();
      std::string transform = tag_attr(tag, "transform").value_or("");
      const std::string x = tag_attr(tag, "x").value_or("0"), y = tag_attr(tag, "y").value_or("0");
      if (x != "0" || y != "0") transform += " translate(" + x + " " + y + ")";
      if (!transform.empty()) g += " transform=\"" + transform + "\"";
      out += g + ">" + body + "</g>";
    }
    out.append(cur, pos, std::string::npos);
    cur = std::move(out);
  }
  return cur;
}

std::string expand_svg_patterns(std::string_view svg) {
  std::string cur(svg);
  for (size_t at = cur.find("<pattern"); at != std::string::npos; at = cur.find("<pattern", at + 1)) {
    const auto el = element_at(cur, at);
    if (!el) break;
    const size_t tag_end = cur.find('>', at);
    const std::string tag = cur.substr(at, tag_end - at);
    const auto id = tag_attr(tag, "id");
    if (!id || tag_attr(tag, "patternUnits").value_or("") != "userSpaceOnUse") continue;
    const float pw = std::strtof(tag_attr(tag, "width").value_or("0").c_str(), nullptr);
    const float ph = std::strtof(tag_attr(tag, "height").value_or("0").c_str(), nullptr);
    if (!(pw > 0) || !(ph > 0)) continue;
    const std::string content = cur.substr(tag_end + 1, cur.rfind("</pattern", el->second) - tag_end - 1);
    // Every <rect ... fill="url(#id)" .../> in the document.
    const std::string fill = "url(#" + *id + ")";
    for (size_t r = cur.find("<rect"); r != std::string::npos; r = cur.find("<rect", r + 1)) {
      const size_t r_end = cur.find('>', r);
      if (r_end == std::string::npos) break;
      const std::string rtag = cur.substr(r, r_end - r);
      if (tag_attr(rtag, "fill").value_or("") != fill || rtag.back() != '/') continue;
      const float x = std::strtof(tag_attr(rtag, "x").value_or("0").c_str(), nullptr);
      const float y = std::strtof(tag_attr(rtag, "y").value_or("0").c_str(), nullptr);
      const float w = std::strtof(tag_attr(rtag, "width").value_or("0").c_str(), nullptr);
      const float h = std::strtof(tag_attr(rtag, "height").value_or("0").c_str(), nullptr);
      if (!(w > 0) || !(h > 0) || (w / pw) * (h / ph) > 4096) continue;  // nothing, or absurdly many tiles
      std::string g = "<g" + without_attrs(rtag.substr(5, rtag.size() - 6), {"fill", "x", "y", "width", "height", "rx", "ry"}) + ">";
      for (float ty = std::floor(y / ph) * ph; ty < y + h; ty += ph) {
        for (float tx = std::floor(x / pw) * pw; tx < x + w; tx += pw) {
          char buf[64];
          std::snprintf(buf, sizeof buf, "<g transform=\"translate(%g %g)\">", tx, ty);
          g += buf + content + "</g>";
        }
      }
      g += "</g>";
      cur.replace(r, r_end + 1 - r, g);
      r += g.size() - 1;
    }
  }
  return cur;
}

Result<Svg> Svg::parse(std::string_view text) {
  // nsvgParse() edits the string it parses, so it gets a private, NUL-terminated copy (with the
  // gradient fix applied).
  std::string copy = fix_bbox_gradients(expand_svg_patterns(expand_svg_uses(text)));
  NSVGimage* image = nsvgParse(copy.data(), "px", 96.0f);
  if (!image) return Error{"can't parse SVG"};
  std::unique_ptr<NSVGimage, Deleter> owned(image);
  if (!(image->width > 0) || !(image->height > 0)) return Error{"SVG has no size (set width/height or a viewBox)"};
  Svg svg(std::move(owned));
  svg.texts_ = parse_texts(text);
  if (!svg.texts_.empty()) {
    // Text coordinates are in viewBox units; nanosvg's image is in width/height units.
    const size_t root = text.find("<svg");
    const std::string_view root_tag = text.substr(root, text.find('>', root) - root);
    if (auto vb = tag_attr(root_tag, "viewBox")) {
      float v[4] = {0, 0, 0, 0};
      std::sscanf(vb->c_str(), "%f%*[ ,]%f%*[ ,]%f%*[ ,]%f", &v[0], &v[1], &v[2], &v[3]);
      if (v[2] > 0) svg.user_to_px_ = svg.image_->width / v[2];
      svg.user_x0_ = v[0];
      svg.user_y0_ = v[1];
    }
  }
  return svg;
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
  for (const Text& t : texts_) {
    draw_svg_text(img, t, s * user_to_px_, tx - user_x0_ * s * user_to_px_, ty - user_y0_ * s * user_to_px_);
  }
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
