// The live tile grid of a TileMap2D (DREAMSY.MD §3.5): parsed once from the package, edited by
// scripts with setTile. A port of engine-web/core/tilemap.ts.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "pkg/files.h"

namespace dreamsy::world {

struct TileKind {
  int index = 0;  // in TileKinds::kinds; 0 = empty
  char ch = '.';
  std::optional<std::string> sprite;  // "asset:<id>"
  bool has_color = false;
  double color[4] = {1, 1, 1, 1};  // fill (no sprite) or tint (sprite)
  bool solid = false;
  std::vector<std::string> tags;
};

// The tileset's tile kinds (a handful per tileset, so grids and their clones keep their own copy).
struct TileKinds {
  std::vector<TileKind> kinds;  // [0] = empty
  std::map<char, int> by_char;
};

struct TileRect {
  int col = 0, row = 0, w = 0, h = 0;
};

class TileGrid {
 public:
  TileGrid(int cols, int rows, TileKinds kinds);

  int cols() const { return cols_; }
  int rows() const { return rows_; }
  bool in_bounds(int c, int r) const { return c >= 0 && r >= 0 && c < cols_ && r < rows_; }
  // nullptr for empty or out-of-bounds cells.
  const TileKind* kind_at(int c, int r) const;
  const TileKind* by_char(char ch) const;
  const TileKinds& kinds() const { return kinds_; }
  uint16_t cell(int c, int r) const { return cells_[static_cast<size_t>(r) * cols_ + c]; }

  // Returns true if the cell changed. `kind` nullptr = empty.
  bool set(int c, int r, const TileKind* kind);
  void set_index(int c, int r, uint16_t index) { cells_[static_cast<size_t>(r) * cols_ + c] = index; }
  std::unique_ptr<TileGrid> clone() const;

  // Bumped when solidity changes (physics rebuilds the map's colliders).
  uint32_t solid_rev() const { return solid_rev_; }

  // Solid tiles merged into rectangles: maximal horizontal runs per row, then runs with the same
  // [start, end) stacked vertically. Floors are one rectangle, so bodies never snag on seams.
  std::vector<TileRect> solid_rects() const;

 private:
  bool solid_at_index(uint16_t i) const { return i < kinds_.kinds.size() && kinds_.kinds[i].solid; }

  int cols_, rows_;
  std::vector<uint16_t> cells_;
  TileKinds kinds_;
  uint32_t solid_rev_ = 0;
};

struct TileLoad {
  std::unique_ptr<TileGrid> grid;  // null when the tileset could not be loaded
  std::vector<std::string> errors;
};

// Builds a grid from a TileMap2D's `tileset` and `data` props (engine-web loadTileGrid).
TileLoad load_tile_grid(const pkg::Files& files, const std::string& tileset, const std::string& data);

}  // namespace dreamsy::world
