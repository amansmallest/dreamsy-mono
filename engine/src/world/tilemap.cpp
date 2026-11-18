#include "world/tilemap.h"

#include <algorithm>

#include "pkg/formats.h"
#include "world/value.h"

namespace dreamsy::world {

TileGrid::TileGrid(int cols, int rows, std::shared_ptr<const TileKinds> kinds)
    : cols_(cols), rows_(rows), cells_(static_cast<size_t>(cols) * static_cast<size_t>(rows), 0), kinds_(std::move(kinds)) {}

const TileKind* TileGrid::kind_at(int c, int r) const {
  if (!in_bounds(c, r)) return nullptr;
  uint16_t k = cell(c, r);
  if (k == 0 || k >= kinds_->kinds.size()) return nullptr;
  return &kinds_->kinds[k];
}

const TileKind* TileGrid::by_char(char ch) const {
  auto it = kinds_->by_char.find(ch);
  return it == kinds_->by_char.end() ? nullptr : &kinds_->kinds[static_cast<size_t>(it->second)];
}

bool TileGrid::set(int c, int r, const TileKind* kind) {
  if (!in_bounds(c, r)) return false;
  uint16_t prev = cell(c, r);
  uint16_t next = kind ? static_cast<uint16_t>(kind->index) : 0;
  if (prev == next) return false;
  set_index(c, r, next);
  if (solid_at_index(prev) != (kind && kind->solid)) ++solid_rev_;
  return true;
}

std::unique_ptr<TileGrid> TileGrid::clone() const {
  auto g = std::make_unique<TileGrid>(cols_, rows_, kinds_);
  g->cells_ = cells_;
  return g;
}

std::vector<TileRect> TileGrid::solid_rects() const {
  // Same algorithm and output order as engine-web: rectangles close when a row no longer
  // continues them; `open` is keyed by start*65536+end and iterated in insertion order there,
  // so a vector (insertion order) is used here too.
  std::vector<TileRect> out;
  std::vector<std::pair<int, TileRect>> open;
  for (int r = 0; r < rows_; ++r) {
    std::vector<std::pair<int, TileRect>> next;
    int c = 0;
    while (c < cols_) {
      if (!solid_at_index(cell(c, r))) {
        ++c;
        continue;
      }
      int start = c;
      while (c < cols_ && solid_at_index(cell(c, r))) ++c;
      int key = start * 65536 + c;
      auto it = std::find_if(open.begin(), open.end(), [&](const auto& p) { return p.first == key; });
      if (it != open.end()) {
        TileRect rect = it->second;
        rect.h += 1;
        open.erase(it);
        next.emplace_back(key, rect);
      } else {
        next.emplace_back(key, TileRect{start, r, c - start, 1});
      }
    }
    for (const auto& p : open) out.push_back(p.second);
    open = std::move(next);
  }
  for (const auto& p : open) out.push_back(p.second);
  return out;
}

TileLoad load_tile_grid(const pkg::Files& files, const std::string& tileset, const std::string& data) {
  TileLoad out;
  pkg::ResolvedTileMap r = pkg::resolve_tilemap(files, tileset, data);
  out.errors = r.errors;
  if (!r.tileset) return out;

  auto kinds = std::make_shared<TileKinds>();
  kinds->kinds.push_back(TileKind{});  // 0 = empty
  for (const auto& [ch, def] : r.tileset->tiles) {
    if (pkg::is_empty_tile(static_cast<unsigned char>(ch))) continue;
    TileKind k;
    k.index = static_cast<int>(kinds->kinds.size());
    k.ch = ch;
    k.sprite = def.sprite;
    if (def.color) k.has_color = parse_color(*def.color, k.color);
    k.solid = def.solid;
    k.tags = def.tags;
    kinds->by_char[ch] = k.index;
    kinds->kinds.push_back(std::move(k));
  }
  const int rows = static_cast<int>(std::min<size_t>(r.rows.size(), pkg::kMaxTileMapRows));
  const int cols = static_cast<int>(std::min<size_t>(r.cols, pkg::kMaxTileMapCols));
  out.grid = std::make_unique<TileGrid>(cols, rows, kinds);
  for (int y = 0; y < rows; ++y) {
    const std::string& line = r.rows[static_cast<size_t>(y)];
    for (int x = 0; x < std::min<int>(cols, static_cast<int>(line.size())); ++x) {
      auto it = kinds->by_char.find(line[static_cast<size_t>(x)]);
      if (it != kinds->by_char.end()) out.grid->set_index(x, y, static_cast<uint16_t>(it->second));
    }
  }
  return out;
}

}  // namespace dreamsy::world
