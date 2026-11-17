// Parsers for the package's data files. Each is a port of its TypeScript counterpart in
// format/src (named in the comment) and reports the same problems, worded for the model.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "pkg/files.h"
#include "pkg/package.h"

namespace dreamsy::pkg {

template <typename T>
struct Parsed {
  std::optional<T> value;
  std::vector<std::string> errors;
  std::vector<std::string> warnings;
};

// ---- tile maps (format/src/tilemap.ts)

inline constexpr size_t kMaxTileMapCols = 1024;
inline constexpr size_t kMaxTileMapRows = 256;

Parsed<Tileset> parse_tileset(std::string_view text);  // data/tilesets/<name>.json
std::vector<std::string> grid_rows(std::string_view text);  // \r removed, trailing blank lines dropped
bool is_empty_tile(char32_t c);  // "." and " "

struct ResolvedTileMap {
  std::optional<Tileset> tileset;
  std::vector<std::string> rows;
  size_t cols = 0;
  std::vector<std::string> errors;
  std::vector<std::string> warnings;
};
// Loads the tileset and the grid (inline text or "file:data/levels/<name>.txt") of a TileMap2D.
ResolvedTileMap resolve_tilemap(const Files& files, std::string_view tileset_path, std::string_view data);

// ---- sprite animations (format/src/anims.ts)

Parsed<AnimSet> parse_anims(std::string_view text);  // data/anims/<name>.json

// ---- synthesized audio (format/src/audio.ts)

Parsed<Sfx> parse_sfx(std::string_view text);      // data/sfx/<id>.json
Parsed<Music> parse_music(std::string_view text);  // data/music/<id>.json
std::optional<double> note_frequency(std::string_view note);  // "A4" -> 440

// ---- SVG sprites (format/src/validate.ts checkSvg)

inline constexpr size_t kMaxSvgBytes = 256 * 1024;
// Allows plain drawing only. Returns a problem, or nullopt when the SVG is safe.
std::optional<std::string> check_svg(std::string_view svg);

// ---- path patterns (format/src/*.ts *_PATH_RE)

bool is_tileset_path(std::string_view p);  // ^data/tilesets/[a-z0-9_\-]+\.json$
bool is_level_path(std::string_view p);    // ^data/levels/[a-z0-9_\-/]+\.txt$
bool is_anims_path(std::string_view p);    // ^data/anims/[a-z][a-z0-9_]*\.json$
bool is_sfx_path(std::string_view p);      // ^data/sfx/[a-z][a-z0-9_]*\.json$
bool is_music_path(std::string_view p);    // ^data/music/[a-z][a-z0-9_]*\.json$

}  // namespace dreamsy::pkg
