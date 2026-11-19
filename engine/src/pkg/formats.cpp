#include "pkg/formats.h"

#include <algorithm>
#include <cmath>
#include <map>

#include "pkg/json.h"
#include "pkg/text.h"

namespace dreamsy::pkg {

bool is_tileset_path(std::string_view p) { return matches_path(p, "data/tilesets/", kNameChars, ".json"); }
bool is_level_path(std::string_view p) { return matches_path(p, "data/levels/", kPathChars, ".txt"); }
bool is_anims_path(std::string_view p) { return matches_snake_path(p, "data/anims/", ".json"); }
bool is_sfx_path(std::string_view p) { return matches_snake_path(p, "data/sfx/", ".json"); }
bool is_music_path(std::string_view p) { return matches_snake_path(p, "data/music/", ".json"); }

namespace {

bool is_asset_ref_any(std::string_view s) { return starts_with(s, "asset:") && is_tag(s.substr(6)); }    // ^asset:[a-z][a-z0-9_]*$
bool is_asset_ref_64(std::string_view s) { return starts_with(s, "asset:") && is_id(s.substr(6)); }      // ^asset:[a-z][a-z0-9_]{0,63}$
bool is_anim_name(std::string_view s) { return is_id(s); }                                                // ^[a-z][a-z0-9_]{0,63}$

}  // namespace

// ================================================================ tile maps

bool is_empty_tile(char32_t c) { return c == U'.' || c == U' '; }

Parsed<Tileset> parse_tileset(std::string_view text) {
  Parsed<Tileset> out;
  auto doc = JsonDoc::parse(text);
  if (!doc) {
    out.errors.push_back(doc.error());
    return out;
  }
  Problems problems;
  ObjectView root(doc.value().root(), "", problems);
  yyjson_val* tiles = root.valid() ? root.take("tiles") : nullptr;
  if (root.valid() && !tiles) problems.add("tiles", "is required");
  std::vector<std::pair<std::string_view, TileDef>> defs;
  if (tiles && !yyjson_is_obj(tiles)) problems.add("tiles", "expected an object, got " + json_text(tiles));
  for (auto [key, val] : entries(tiles)) {
    ObjectView t(val, child_path("tiles", key), problems);
    TileDef def;
    if (yyjson_val* s = t.take("sprite"); s && !yyjson_is_null(s)) {
      def.sprite = check_string(s, child_path(t.path(), "sprite"), problems,
                                {.pattern = is_asset_ref_any, .pattern_message = "sprite must be \"asset:<id>\" or null"});
    }
    def.color = read_string(t, "color", {.pattern = is_color, .pattern_message = "color must be \"#rrggbb\" or \"#rrggbbaa\""});
    def.solid = read_bool(t, "solid").value_or(false);
    read_array(t, "tags", 0, 16, [&](yyjson_val* v, const std::string& path) {
      if (auto tag = check_string(v, path, problems, {.pattern = is_tag, .pattern_message = "tags are lowercase_snake"}))
        def.tags.push_back(*tag);
    });
    t.reject_unknown();
    defs.emplace_back(key, std::move(def));
  }
  root.reject_unknown();
  if (!problems.empty()) {
    out.errors.push_back(problems.joined());
    return out;
  }

  Tileset tileset;
  for (auto& [key, def] : defs) {
    if (key == "." || key == " ") {
      if (def.sprite || def.color || def.solid || !def.tags.empty()) {
        out.warnings.push_back("tile " + quote(key) + " is always empty; its sprite/color/solid/tags are ignored");
      }
      continue;
    }
    if (key.size() != 1 || key[0] < '!' || key[0] > '~') {
      out.errors.push_back("tile key " + quote(key) +
                           " must be exactly one printable ASCII character (e.g. \"#\", \"G\", \"^\")");
      continue;
    }
    tileset.tiles[key[0]] = std::move(def);
  }
  out.value = std::move(tileset);
  return out;
}

std::vector<std::string> grid_rows(std::string_view text) {
  std::string clean;
  clean.reserve(text.size());
  for (char c : text)
    if (c != '\r') clean += c;
  std::vector<std::string> rows;
  for (std::string_view row : split(clean, '\n')) rows.emplace_back(row);
  while (!rows.empty() && trim(rows.back()).empty()) rows.pop_back();
  return rows;
}

ResolvedTileMap resolve_tilemap(const Files& files, std::string_view tileset_path, std::string_view data) {
  ResolvedTileMap out;
  const std::string ts(tileset_path);
  if (tileset_path.empty()) {
    out.errors.push_back("tileset is not set (use \"data/tilesets/<name>.json\")");
  } else if (!is_tileset_path(tileset_path)) {
    out.errors.push_back("tileset " + quote(tileset_path) + " must be \"data/tilesets/<name>.json\"");
  } else if (auto text = files.text(tileset_path); !text) {
    out.errors.push_back("tileset " + ts + " does not exist");
  } else {
    auto t = parse_tileset(*text);
    out.tileset = std::move(t.value);
    for (const std::string& e : t.errors) out.errors.push_back(ts + ": " + e);
  }

  // Grid source: inline text, or "file:data/levels/<name>.txt".
  std::string grid_text;
  std::string where = "data";
  if (starts_with(data, "file:")) {
    std::string file(trim(data.substr(5)));
    if (!is_level_path(file)) {
      out.errors.push_back("data " + quote(data) + ": level files must be \"file:data/levels/<name>.txt\"");
      return out;
    }
    auto text = files.text(file);
    if (!text) {
      out.errors.push_back("level file " + file + " does not exist");
      return out;
    }
    grid_text = std::string(*text);
    where = file;
  } else {
    grid_text = std::string(data);
  }

  out.rows = grid_rows(grid_text);
  for (const std::string& row : out.rows) out.cols = std::max(out.cols, utf16_length(row));
  if (out.rows.empty()) out.warnings.push_back(where + ": the grid is empty");
  if (out.rows.size() > kMaxTileMapRows || out.cols > kMaxTileMapCols) {
    out.errors.push_back(where + ": grid is " + std::to_string(out.cols) + "×" + std::to_string(out.rows.size()) +
                         " tiles; max " + std::to_string(kMaxTileMapCols) + "×" + std::to_string(kMaxTileMapRows) +
                         " (split the level into scenes)");
  }
  if (out.tileset) {
    // First occurrence of each unknown character, in reading order; report at most 8.
    std::vector<std::pair<char32_t, std::pair<size_t, size_t>>> unknown;
    for (size_t r = 0; r < out.rows.size(); ++r) {
      size_t col = 0;
      for (char32_t ch : code_points(out.rows[r])) {
        ++col;
        bool known = ch < 0x80 && out.tileset->tiles.count(static_cast<char>(ch));
        if (is_empty_tile(ch) || known) continue;
        if (std::none_of(unknown.begin(), unknown.end(), [&](auto& u) { return u.first == ch; })) {
          unknown.push_back({ch, {r + 1, col}});
        }
        if (ch > 0xFFFF) ++col;  // UTF-16 columns, like the TS engine
      }
    }
    for (size_t i = 0; i < unknown.size() && i < 8; ++i) {
      std::string ch;
      char32_t cp = unknown[i].first;
      // Re-encode as UTF-8 for the message.
      if (cp < 0x80) ch += static_cast<char>(cp);
      else if (cp < 0x800) ch += {static_cast<char>(0xC0 | (cp >> 6)), static_cast<char>(0x80 | (cp & 0x3F))};
      else if (cp < 0x10000)
        ch += {static_cast<char>(0xE0 | (cp >> 12)), static_cast<char>(0x80 | ((cp >> 6) & 0x3F)),
               static_cast<char>(0x80 | (cp & 0x3F))};
      else
        ch += {static_cast<char>(0xF0 | (cp >> 18)), static_cast<char>(0x80 | ((cp >> 12) & 0x3F)),
               static_cast<char>(0x80 | ((cp >> 6) & 0x3F)), static_cast<char>(0x80 | (cp & 0x3F))};
      out.errors.push_back(where + ": character " + quote(ch) + " (first at line " +
                           std::to_string(unknown[i].second.first) + ", column " +
                           std::to_string(unknown[i].second.second) + ") is not defined in " + ts +
                           "; add it to \"tiles\" or use \".\" for empty");
    }
  }
  return out;
}

// ================================================================ animations

Parsed<AnimSet> parse_anims(std::string_view text) {
  constexpr size_t kMaxAnims = 64, kMaxFrames = 128;
  Parsed<AnimSet> out;
  auto doc = JsonDoc::parse(text);
  if (!doc) {
    out.errors.push_back(doc.error());
    return out;
  }
  yyjson_val* root = doc.value().root();
  if (!yyjson_is_obj(root)) {
    out.errors.push_back(
        "expected an object of animations, e.g. { \"run\": { \"frames\": [\"asset:a\", \"asset:b\"], \"fps\": 10 } }");
    return out;
  }
  auto list = entries(root);
  if (list.empty()) out.errors.push_back("no animations defined");
  if (list.size() > kMaxAnims) out.errors.push_back("at most " + std::to_string(kMaxAnims) + " animations");
  AnimSet set;
  for (auto [name, def] : list) {
    if (!is_anim_name(name)) {
      out.errors.push_back("animation name " + quote(name) + " must be lowercase_snake");
      continue;
    }
    Problems problems;
    ObjectView o(def, "", problems);
    Anim anim;
    read_array(o, "frames", 1, kMaxFrames, [&](yyjson_val* v, const std::string& path) {
      if (auto f = check_string(v, path, problems,
                                {.pattern = is_asset_ref_64, .pattern_message = "frames are \"asset:<id>\" image refs"}))
        anim.frames.push_back(*f);
    }, /*required=*/true);
    anim.fps = read_number(o, "fps", {.min = 0.5, .max = 60}).value_or(10);
    anim.loop = read_bool(o, "loop").value_or(true);
    anim.next = read_string(o, "next", {.pattern = is_anim_name, .pattern_message = "invalid animation name"});
    o.reject_unknown();
    if (!problems.empty()) {
      std::vector<std::string> msgs;
      for (const std::string& m : problems.list()) msgs.push_back(m);
      out.errors.push_back(quote(name) + ": " + join(msgs, "; "));
      continue;
    }
    set.emplace_back(std::string(name), std::move(anim));
  }
  for (const auto& entry : set) {
    const std::optional<std::string>& next = entry.second.next;
    if (!next) continue;
    bool found = std::any_of(set.begin(), set.end(), [&](const auto& a) { return a.first == *next; });
    if (!found) out.errors.push_back(quote(entry.first) + ".next: no animation " + quote(*next));
  }
  out.value = std::move(set);
  return out;
}

// ================================================================ audio

namespace {

const std::vector<std::string_view> kWaves = {"square", "saw", "triangle", "sine", "noise"};

bool is_note(std::string_view t) {
  if (t.size() < 2 || t.size() > 3 || t[0] < 'A' || t[0] > 'G') return false;
  size_t i = 1;
  if (t.size() == 3) {
    if (t[1] != '#' && t[1] != 'b') return false;
    i = 2;
  }
  return t[i] >= '0' && t[i] <= '8';
}

}  // namespace

std::optional<double> note_frequency(std::string_view note) {
  if (!is_note(note)) return std::nullopt;
  static const int kSemi[] = {9, 11, 0, 2, 4, 5, 7};  // A B C D E F G
  int semis = kSemi[note[0] - 'A'];
  char octave = note.back();
  if (note.size() == 3) semis += note[1] == '#' ? 1 : -1;
  semis += 12 * (octave - '0' + 1);
  return 440.0 * std::pow(2.0, (semis - 69) / 12.0);
}

Parsed<Sfx> parse_sfx(std::string_view text) {
  Parsed<Sfx> out;
  auto doc = JsonDoc::parse(text);
  if (!doc) {
    out.errors.push_back(doc.error());
    return out;
  }
  Problems problems;
  ObjectView o(doc.value().root(), "", problems);
  Sfx s;
  s.wave = read_enum(o, "wave", kWaves).value_or("square");
  s.attack = read_number(o, "attack", {.min = 0, .max = 2}).value_or(0);
  s.sustain = read_number(o, "sustain", {.min = 0, .max = 2}).value_or(0.1);
  s.decay = read_number(o, "decay", {.min = 0, .max = 3}).value_or(0.2);
  s.freq = read_number(o, "freq", {.min = 20, .max = 8000}).value_or(440);
  s.slide = read_number(o, "slide", {.min = -4, .max = 4}).value_or(0);
  s.vibrato = read_number(o, "vibrato", {.min = 0, .max = 12}).value_or(0);
  s.vibrato_speed = read_number(o, "vibrato_speed", {.min = 0, .max = 40}).value_or(6);
  s.duty = read_number(o, "duty", {.min = 0.05, .max = 0.95}).value_or(0.5);
  s.volume = read_number(o, "volume", {.min = 0, .max = 1}).value_or(0.5);
  o.reject_unknown();
  if (!problems.empty()) {
    out.errors = problems.list();
    return out;
  }
  double length = s.attack + s.sustain + s.decay;
  if (length > 5) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.2f", length);
    out.errors.push_back(std::string("attack + sustain + decay is ") + buf + "s; max 5s");
  } else if (length == 0) {
    out.errors.push_back("the sound has zero length (set sustain or decay)");
  }
  out.value = s;
  return out;
}

std::vector<int> Music::song_order() const {
  if (order) return *order;
  size_t patterns = SIZE_MAX;
  for (const MusicChannel& c : channels) patterns = std::min(patterns, c.notes.size() / static_cast<size_t>(steps));
  if (channels.empty()) patterns = 0;
  std::vector<int> out;
  for (size_t i = 0; i < std::max<size_t>(1, patterns); ++i) out.push_back(static_cast<int>(i));
  return out;
}

Parsed<Music> parse_music(std::string_view text) {
  Parsed<Music> out;
  auto doc = JsonDoc::parse(text);
  if (!doc) {
    out.errors.push_back(doc.error());
    return out;
  }
  Problems problems;
  ObjectView o(doc.value().root(), "", problems);
  Music m;
  m.bpm = read_number(o, "bpm", {.min = 40, .max = 240}).value_or(120);
  m.steps = static_cast<int>(read_number(o, "steps", {.min = 1, .max = 256, .integer = true}).value_or(16));
  read_array(o, "channels", 1, 4, [&](yyjson_val* v, const std::string& path) {
    ObjectView c(v, path, problems);
    MusicChannel ch;
    ch.wave = read_enum(c, "wave", kWaves).value_or("square");
    ch.volume = read_number(c, "volume", {.min = 0, .max = 1}).value_or(0.4);
    ch.duty = read_number(c, "duty", {.min = 0.05, .max = 0.95}).value_or(0.5);
    // notes: ["C4", "-", "."] or "C4 - ." (whitespace separated)
    std::string notes_path = child_path(path, "notes");
    auto check_token = [&](std::string_view t, const std::string& p) {
      if (t == "-" || t == "." || is_note(t)) {
        ch.notes.emplace_back(t);
      } else {
        problems.add(p, "bad note " + quote(t) + ": use \"C0\"..\"B8\" (with optional # or b), \"-\" (hold) or \".\" (rest)");
      }
    };
    if (yyjson_val* notes = c.valid() ? c.take("notes") : nullptr) {
      if (yyjson_is_str(notes)) {
        size_t i = 0;
        std::string_view s = trim(str_of(notes));
        size_t start = 0;
        for (size_t k = 0; k <= s.size(); ++k) {
          if (k == s.size() || is_js_space(s[k])) {
            if (k > start) check_token(s.substr(start, k - start), child_path(notes_path, i++));
            start = k + 1;
          }
        }
      } else if (yyjson_is_arr(notes)) {
        size_t i, n;
        yyjson_val* item;
        yyjson_arr_foreach(notes, i, n, item) {
          if (yyjson_is_str(item)) check_token(str_of(item), child_path(notes_path, i));
          else problems.add(child_path(notes_path, i), "expected a string, got " + json_text(item));
        }
      } else {
        problems.add(notes_path, "expected an array, got " + json_text(notes));
      }
    } else if (c.valid()) {
      problems.add(notes_path, "is required");
    }
    c.reject_unknown();
    m.channels.push_back(std::move(ch));
  }, /*required=*/true);
  std::vector<int> order;
  bool has_order = read_array(o, "order", 1, 256, [&](yyjson_val* v, const std::string& path) {
    if (auto p = check_number(v, path, problems, {.min = 0, .max = 255, .integer = true})) order.push_back(static_cast<int>(*p));
  }).value_or(false);
  if (has_order) m.order = order;
  m.loop = read_bool(o, "loop").value_or(true);
  o.reject_unknown();
  if (!problems.empty()) {
    out.errors = problems.list();
    return out;
  }

  size_t patterns = SIZE_MAX;
  for (size_t i = 0; i < m.channels.size(); ++i) {
    size_t n = m.channels[i].notes.size();
    if (n == 0 || n % static_cast<size_t>(m.steps) != 0) {
      out.errors.push_back("channels." + std::to_string(i) + ".notes: has " + std::to_string(n) +
                           " notes; must be a multiple of steps (" + std::to_string(m.steps) + ")");
    }
    patterns = std::min(patterns, n / static_cast<size_t>(m.steps));
  }
  if (m.order) {
    for (int p : *m.order) {
      if (static_cast<size_t>(p) >= patterns) {
        out.errors.push_back("order: pattern " + std::to_string(p) + " does not exist (every channel has " +
                             std::to_string(patterns) + " pattern" + (patterns == 1 ? "" : "s") + ": 0.." +
                             std::to_string(static_cast<long long>(patterns) - 1) + ")");
        break;
      }
    }
  }
  size_t total = (m.order ? m.order->size() : patterns) * static_cast<size_t>(m.steps);
  if (total > 4096) out.errors.push_back("song is " + std::to_string(total) + " steps; max 4096");
  out.value = std::move(m);
  return out;
}

// ================================================================ SVG

std::optional<std::string> check_svg(std::string_view svg) {
  if (utf16_length(svg) > kMaxSvgBytes) return "larger than " + std::to_string(kMaxSvgBytes / 1024) + "KB";

  // ^\s*(<\?xml[^>]*>\s*)?<svg[\s>]   (case-insensitive)
  size_t i = 0;
  while (i < svg.size() && is_js_space(svg[i])) ++i;
  auto svg_tag_at = [&](size_t k) {
    return iequals_at(svg, k, "<svg") && k + 4 < svg.size() && (is_js_space(svg[k + 4]) || svg[k + 4] == '>');
  };
  bool start_ok = svg_tag_at(i);
  if (!start_ok && iequals_at(svg, i, "<?xml")) {
    size_t close = svg.find('>', i);
    if (close != std::string_view::npos) {
      size_t k = close + 1;
      while (k < svg.size() && is_js_space(svg[k])) ++k;
      start_ok = svg_tag_at(k);
    }
  }
  if (!start_ok) return "must start with <svg";

  // viewBox\s*=   (case-sensitive)
  bool view_box = false;
  for (size_t k = svg.find("viewBox"); k != std::string_view::npos; k = svg.find("viewBox", k + 1)) {
    size_t j = k + 7;
    while (j < svg.size() && is_js_space(svg[j])) ++j;
    if (j < svg.size() && svg[j] == '=') {
      view_box = true;
      break;
    }
  }
  if (!view_box) return "needs a viewBox";

  for (size_t k = 0; k < svg.size(); ++k) {
    if (svg[k] != '<') continue;
    for (std::string_view tag : {"<script", "<foreignobject", "<iframe", "<object", "<embed", "<!entity"}) {
      if (iequals_at(svg, k, tag)) return std::string("contains a disallowed element");
    }
  }

  // \son[a-z]+\s*=   (case-insensitive)
  for (size_t k = 0; k + 3 < svg.size(); ++k) {
    if (!is_js_space(svg[k]) || !iequals_at(svg, k + 1, "on")) continue;
    size_t j = k + 3, letters = 0;
    while (j < svg.size() && ((svg[j] >= 'a' && svg[j] <= 'z') || (svg[j] >= 'A' && svg[j] <= 'Z'))) ++j, ++letters;
    if (letters == 0) continue;
    while (j < svg.size() && is_js_space(svg[j])) ++j;
    if (j < svg.size() && svg[j] == '=') return std::string("contains an event handler attribute");
  }

  // (href|src)\s*=\s*["'](?!#|data:image\/)   (case-insensitive)
  for (size_t k = 0; k < svg.size(); ++k) {
    size_t j;
    if (iequals_at(svg, k, "href")) j = k + 4;
    else if (iequals_at(svg, k, "src")) j = k + 3;
    else continue;
    while (j < svg.size() && is_js_space(svg[j])) ++j;
    if (j >= svg.size() || svg[j] != '=') continue;
    ++j;
    while (j < svg.size() && is_js_space(svg[j])) ++j;
    if (j >= svg.size() || (svg[j] != '"' && svg[j] != '\'')) continue;
    ++j;
    if (j < svg.size() && svg[j] == '#') continue;
    if (iequals_at(svg, j, "data:image/")) continue;
    return std::string("references an external resource (only #ids and data:image are allowed)");
  }

  // url\(\s*["']?(?!#)   (case-insensitive). With backtracking this matches whenever the
  // character right after "url(" is not '#' (or there is none), so that is the rule.
  for (size_t k = 0; k < svg.size(); ++k) {
    if (!iequals_at(svg, k, "url(")) continue;
    if (k + 4 >= svg.size() || svg[k + 4] != '#') return std::string("url() may only reference #ids");
  }
  return std::nullopt;
}

}  // namespace dreamsy::pkg
