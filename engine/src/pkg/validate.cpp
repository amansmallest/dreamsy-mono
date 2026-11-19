#include "pkg/validate.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <unordered_map>
#include <unordered_set>

#include "pkg/formats.h"
#include "pkg/json.h"
#include "pkg/manifest.h"
#include "pkg/text.h"

namespace dreamsy::pkg {

std::string format_issue(const Issue& i) {
  std::string out = i.severity == Severity::Error ? "✗ [" : "! [";
  out += i.code + "] " + i.file;
  if (!i.id.empty()) out += " #" + i.id;
  return out + ": " + i.message;
}

const PropValue* EntityDef::prop(std::string_view key) const {
  for (const auto& [k, v] : props)
    if (k == key) return &v;
  return nullptr;
}

const EntityDef* SceneDef::entity(std::string_view id) const {
  auto it = index.find(std::string(id));
  return it == index.end() ? nullptr : &entities[it->second];
}

namespace {

// ---------------------------------------------------------------- raw scene data

// A scene as parsed from JSON, before prop values are type-checked. Holds its document so the
// raw prop values (yyjson_val*) stay valid while the package is validated.
struct RawEntity {
  std::string id;
  std::string type;
  std::optional<std::string> name;
  std::vector<std::pair<std::string, yyjson_val*>> props;
  std::vector<std::string> scripts;
  std::vector<std::string> tags;
  std::vector<std::string> children;
  bool has_children_list = false;
};

struct RawScene {
  JsonDoc doc;
  std::string root;
  std::optional<std::string> view;
  std::vector<RawEntity> entities;
  std::unordered_map<std::string, size_t> index;

  const RawEntity* entity(const std::string& id) const {
    auto it = index.find(id);
    return it == index.end() ? nullptr : &entities[it->second];
  }
  yyjson_val* prop(const RawEntity& e, std::string_view key) const {
    for (const auto& [k, v] : e.props)
      if (k == key) return v;
    return nullptr;
  }
};

bool is_script_path(std::string_view p) {  // ^scripts/(client|server)/[a-z0-9_\-/]+\.luau$
  return matches_path(p, "scripts/client/", kPathChars, ".luau") ||
         matches_path(p, "scripts/server/", kPathChars, ".luau");
}

bool is_any_script_path(std::string_view p) {  // ^scripts/(client|server|shared)/[a-z0-9_\-/]+\.luau$
  return is_script_path(p) || matches_path(p, "scripts/shared/", kPathChars, ".luau");
}

bool is_asset_file_name(std::string_view s) {  // ^[a-z][a-z0-9_]*\.[a-z0-9]+$
  size_t dot = s.find('.');
  if (dot == std::string_view::npos || !is_tag(s.substr(0, dot))) return false;
  std::string_view ext = s.substr(dot + 1);
  if (ext.empty()) return false;
  for (char c : ext)
    if (!is_lower(c) && !is_digit(c)) return false;
  return true;
}

const std::vector<std::string_view>& asset_extensions(AssetKind k) {
  static const std::vector<std::string_view> image{"png", "jpg", "webp", "svg"}, mesh{"glb"},
      audio{"ogg", "mp3", "wav"}, font{"ttf", "otf"};
  switch (k) {
    case AssetKind::Image: return image;
    case AssetKind::Mesh: return mesh;
    case AssetKind::Audio: return audio;
    case AssetKind::Font: return font;
  }
  return image;
}

std::string join_views(const std::vector<std::string_view>& v, std::string_view sep) {
  std::string out;
  for (size_t i = 0; i < v.size(); ++i) out += (i ? std::string(sep) : "") + std::string(v[i]);
  return out;
}

// JavaScript truthiness of a JSON value.
bool js_truthy(yyjson_val* v) {
  if (!v || yyjson_is_null(v)) return false;
  if (yyjson_is_bool(v)) return yyjson_get_bool(v);
  if (yyjson_is_num(v)) return yyjson_get_num(v) != 0 && !std::isnan(yyjson_get_num(v));
  if (yyjson_is_str(v)) return yyjson_get_len(v) > 0;
  return true;  // objects and arrays
}

std::string string_or_empty(yyjson_val* v) { return yyjson_is_str(v) ? std::string(str_of(v)) : std::string(); }

// ---------------------------------------------------------------- script scans

// Finds calls like `name ( "literal"` the way the TS validator's regexes do:
//   \b<name>\s*\(\s*["']([^"']*)["']
// `name` may contain no regex specials. Returns the captured literals.
std::vector<std::string> scan_literal_calls(std::string_view text, std::string_view name, bool must_start_with_at) {
  std::vector<std::string> out;
  size_t pos = 0;
  while ((pos = text.find(name, pos)) != std::string_view::npos) {
    size_t start = pos;
    pos += 1;
    if (start > 0 && is_word_char(text[start - 1])) continue;  // \b
    if (!name.empty() && !is_word_char(name[0])) continue;
    size_t i = start + name.size();
    while (i < text.size() && is_js_space(text[i])) ++i;
    if (i >= text.size() || text[i] != '(') continue;
    ++i;
    while (i < text.size() && is_js_space(text[i])) ++i;
    if (i >= text.size() || (text[i] != '"' && text[i] != '\'')) continue;
    ++i;
    if (must_start_with_at && (i >= text.size() || text[i] != '@')) continue;
    size_t close = text.find_first_of("\"'", i);
    if (close == std::string_view::npos) continue;
    out.emplace_back(text.substr(i, close - i));
    pos = close + 1;  // matchAll continues after the match
  }
  return out;
}

bool is_kit_require(std::string_view s, std::string* kit) {  // ^@kit\/([a-z][a-z0-9-]{0,31})(?:\/([a-z0-9_\-/]+))?$
  if (!starts_with(s, "@kit/")) return false;
  std::string_view rest = s.substr(5);
  size_t slash = rest.find('/');
  std::string_view name = rest.substr(0, slash);
  if (name.empty() || name.size() > 32 || !is_lower(name[0])) return false;
  for (char c : name)
    if (!is_lower(c) && !is_digit(c) && c != '-') return false;
  if (slash != std::string_view::npos) {
    std::string_view sub = rest.substr(slash + 1);
    if (sub.empty()) return false;
    for (char c : sub)
      if (kPathChars.find(c) == std::string_view::npos) return false;
  }
  *kit = std::string(name);
  return true;
}

// ---------------------------------------------------------------- the validator

class Validator {
 public:
  explicit Validator(Files files) : files_(std::move(files)), catalog_(Catalog::get()) {}

  LoadResult run();

 private:
  void err(std::string code, std::string message, std::string file = {}, std::string id = {}) {
    issues_.push_back({Severity::Error, std::move(code), std::move(message), std::move(file), std::move(id)});
  }
  void warn(std::string code, std::string message, std::string file = {}, std::string id = {}) {
    issues_.push_back({Severity::Warning, std::move(code), std::move(message), std::move(file), std::move(id)});
  }

  void check_manifest();
  void check_assets();
  void check_scripts();
  void check_data();
  void parse_scenes();
  void check_scene(const std::string& file, RawScene& scene);
  void check_entity(const std::string& file, const RawEntity& e, const RawScene& scene, EntityDef* out);
  std::optional<std::string> check_prop(const PropDef& def, yyjson_val* v, const RawScene& scene, PropValue* out);
  void check_script_literals();
  void check_entry_scene();
  std::unique_ptr<Package> build_package();

  Files files_;
  const Catalog& catalog_;
  std::vector<Issue> issues_;

  std::optional<Manifest> manifest_;
  std::map<std::string, AssetMeta> assets_;
  std::map<std::string, Tileset> tilesets_;
  std::map<std::string, AnimSet> anims_;
  std::map<std::string, Sfx> sfx_;
  std::map<std::string, Music> music_;
  std::map<std::string, RawScene> raw_scenes_;
  std::map<std::string, SceneDef> scenes_;
};

LoadResult Validator::run() {
  if (files_.total_bytes() > kMaxPackageBytes) {
    err("package.too_large",
        "package is " + std::to_string(files_.total_bytes()) + " bytes; max " + std::to_string(kMaxPackageBytes));
  }
  static const std::set<std::string_view> kTopLevel{"dreamsy.toml", "notes.md", "scenes", "scripts", "data", "assets"};
  for (const std::string& p : files_.paths()) {
    if (!kTopLevel.count(std::string_view(p).substr(0, p.find('/')))) {
      warn("package.unknown_file", "unexpected file " + p + "; it will be ignored", p);
    }
  }

  check_manifest();
  check_assets();
  check_scripts();
  check_data();
  parse_scenes();
  for (auto& [file, scene] : raw_scenes_) check_scene(file, scene);
  check_script_literals();
  check_entry_scene();

  LoadResult result;
  result.ok = std::none_of(issues_.begin(), issues_.end(), [](const Issue& i) { return i.severity == Severity::Error; });
  if (result.ok) result.package = build_package();
  result.issues = std::move(issues_);
  return result;
}

void Validator::check_manifest() {
  const std::string kFile = "dreamsy.toml";
  auto text = files_.text(kFile);
  if (!text) {
    err("manifest.missing", "dreamsy.toml is missing", kFile);
    return;
  }
  auto parsed = parse_manifest(*text);
  if (!parsed) {
    err("manifest.invalid", parsed.error(), kFile);
    return;
  }
  manifest_ = std::move(parsed).value();
  const Manifest& m = *manifest_;

  if (m.dimension == "3d") {
    err("manifest.dimension_unsupported",
        "dimension = \"3d\" is not supported: Dreamsy is a 2D and 2.5D engine (use dimension = \"2d\")", kFile);
  }
  if (m.players_min > m.players_max) err("manifest.players", "players.min must be ≤ players.max", kFile);
  if (m.server_mode == "async" && !m.server_deterministic) {
    err("manifest.async_needs_determinism", "server.mode = \"async\" requires server.deterministic = true", kFile);
  }
  if (m.players_max > 1 && m.server_mode == "none") {
    err("manifest.multiplayer_needs_server", "players.max > 1 requires server.mode other than \"none\"", kFile);
  }
  if (!files_.has(m.entry_scene)) err("manifest.entry_scene", "entry_scene " + m.entry_scene + " does not exist", kFile);
  if (const StyleDef* style = catalog_.style(m.style.preset)) {
    if (std::find(style->dimensions.begin(), style->dimensions.end(), m.dimension) == style->dimensions.end()) {
      err("manifest.style_dimension",
          "style " + quote(m.style.preset) + " supports " + join(style->dimensions, "/") + " games only", kFile);
    }
  }
  if (m.style.preset == "custom" && !m.style.notes) {
    err("manifest.style_notes", "style.preset = \"custom\" requires style.notes", kFile);
  }
  std::set<std::string> seen;
  for (const std::string& k : m.kits.value_or(std::vector<std::string>{})) {
    if (!catalog_.kit(k)) err("manifest.unknown_kit", "kits: unknown kit " + quote(k) + " (available: " + catalog_.kit_names() + ")", kFile);
    if (seen.count(k)) err("manifest.duplicate_kit", "kits: " + quote(k) + " is listed twice", kFile);
    seen.insert(k);
  }
  if (m.style.grid && m.style.preset != "pixel") {
    warn("manifest.style_grid", "style.grid only applies to the pixel preset", kFile);
  }
  if (m.view && m.dimension != "2d") {
    err("manifest.view_dimension", "view (2.5D) applies to 2D games only: remove it or set dimension = \"2d\"", kFile);
  }
}

void Validator::check_assets() {
  std::set<std::string> meta_files;
  for (const std::string& p : files_.paths("assets/")) {
    std::string_view rest = std::string_view(p).substr(7);
    if (rest.find('/') != std::string_view::npos || !ends_with(rest, ".meta.json") || rest.size() == 10) continue;
    meta_files.insert(p);
    std::string id(rest.substr(0, rest.size() - 10));
    if (!is_id(id)) {
      err("asset.bad_id", "asset id " + quote(id) + " must be lowercase snake_case", p, id);
      continue;
    }
    auto doc = JsonDoc::parse(*files_.text(p));
    if (!doc) {
      err("asset.meta_json", doc.error(), p, id);
      continue;
    }
    Problems problems;
    ObjectView o(doc.value().root(), "", problems);
    AssetMeta meta;
    meta.id = id;
    auto kind = read_enum(o, "kind", {"image", "mesh", "audio", "font"}, true);
    auto file = read_string(o, "file", {.pattern = is_asset_file_name, .pattern_message = "invalid file name"}, true);
    if (yyjson_val* src = o.take("source")) {
      ObjectView s(src, "source", problems);
      read_string(s, "model");
      read_string(s, "prompt");
      read_number(s, "seed", {.integer = true});
      read_array(s, "references", 0, SIZE_MAX, [&](yyjson_val* v, const std::string& path) { check_string(v, path, problems); });
      read_bool(s, "handmade");
      s.reject_unknown();
    }
    meta.license = read_string(o, "license");
    o.reject_unknown();
    if (!problems.empty()) {
      err("asset.meta_invalid", problems.joined(), p, id);
      continue;
    }
    meta.kind = *asset_kind_from(*kind);
    meta.file = *file;
    std::string ext = meta.file.substr(meta.file.rfind('.') + 1);
    const auto& allowed = asset_extensions(meta.kind);
    if (std::find(allowed.begin(), allowed.end(), ext) == allowed.end()) {
      err("asset.bad_extension", std::string(asset_kind_name(meta.kind)) + " asset must be one of " +
                                     join_views(allowed, ", ") + "; got ." + ext, p, id);
    }
    const std::string asset_path = "assets/" + meta.file;
    if (!files_.has(asset_path)) {
      err("asset.file_missing", asset_path + " referenced by " + p + " does not exist", p, id);
    } else if (ext == "svg") {
      if (auto problem = check_svg(*files_.text(asset_path))) err("asset.svg_unsafe", asset_path + ": " + *problem, asset_path, id);
    }
    assets_[id] = std::move(meta);
  }

  if (manifest_) {
    std::set<std::string> store_ids;
    for (const StoreItem& item : manifest_->store) {
      if (store_ids.count(item.id)) err("store.duplicate_id", "store item " + quote(item.id) + " is defined twice", "dreamsy.toml", item.id);
      store_ids.insert(item.id);
      if (item.icon) {
        auto it = assets_.find(item.icon->substr(6));
        if (it == assets_.end() || it->second.kind != AssetKind::Image) {
          err("store.icon", "store item " + quote(item.id) + ": icon " + *item.icon + " is not an image asset", "dreamsy.toml", item.id);
        }
      }
    }
    for (const std::string& ref : manifest_->style.references.value_or(std::vector<std::string>{})) {
      auto it = assets_.find(ref);
      if (it == assets_.end() || it->second.kind != AssetKind::Image) {
        err("manifest.style_reference", "style.references: " + quote(ref) + " is not an image asset", "dreamsy.toml", ref);
      }
    }
  }

  std::set<std::string> referenced;
  for (const auto& [id, meta] : assets_) referenced.insert("assets/" + meta.file);
  for (const std::string& p : files_.paths("assets/")) {
    if (!meta_files.count(p) && !referenced.count(p)) warn("asset.no_meta", p + " has no .meta.json and can't be referenced", p);
  }
}

void Validator::check_scripts() {
  for (const std::string& p : files_.paths("scripts/")) {
    if (!is_any_script_path(p)) {
      err("script.bad_path", p + ": scripts must be scripts/{client,server,shared}/<name>.luau (lowercase)", p);
    }
  }
}

void Validator::check_data() {
  auto image_ref = [&](const std::string& file, const std::string& what, const std::string& id, const char* missing_code,
                       const char* kind_code) {
    auto it = assets_.find(id);
    if (it == assets_.end()) {
      err(missing_code, what + "asset " + quote(id) + " does not exist (needs assets/" + id + ".meta.json)", file, id);
    } else if (it->second.kind != AssetKind::Image) {
      err(kind_code, what + quote(id) + " is a " + asset_kind_name(it->second.kind) + " asset, not an image", file, id);
    }
  };

  for (const std::string& p : files_.paths("data/")) {
    std::string_view text = *files_.text(p);
    if (starts_with(p, "data/tilesets/")) {
      if (!is_tileset_path(p)) {
        err("tileset.bad_path", p + ": tilesets must be data/tilesets/<name>.json (lowercase)", p);
        continue;
      }
      auto t = parse_tileset(text);
      for (const std::string& m : t.errors) err("tileset.invalid", m, p);
      for (const std::string& m : t.warnings) warn("tileset.warning", m, p);
      if (t.value) {
        for (const auto& [ch, def] : t.value->tiles) {
          if (!def.sprite) continue;
          std::string id = def.sprite->substr(6);
          auto it = assets_.find(id);
          std::string tile = "tile " + quote(std::string(1, ch)) + ": ";
          if (it == assets_.end()) err("tileset.sprite_missing", tile + "asset " + quote(id) + " does not exist (needs assets/" + id + ".meta.json)", p, id);
          else if (it->second.kind != AssetKind::Image) err("tileset.sprite_kind", tile + quote(id) + " is a " + asset_kind_name(it->second.kind) + " asset, not an image", p, id);
        }
        tilesets_[p] = std::move(*t.value);
      }
    } else if (starts_with(p, "data/sfx/")) {
      if (!is_sfx_path(p)) {
        err("sfx.bad_path", p + ": sound effects must be data/sfx/<id>.json (lowercase_snake id)", p);
        continue;
      }
      auto s = parse_sfx(text);
      for (const std::string& m : s.errors) err("sfx.invalid", m, p);
      if (s.value) sfx_[p] = *s.value;
    } else if (starts_with(p, "data/music/")) {
      if (!is_music_path(p)) {
        err("music.bad_path", p + ": music must be data/music/<id>.json (lowercase_snake id)", p);
        continue;
      }
      auto m = parse_music(text);
      for (const std::string& e : m.errors) err("music.invalid", e, p);
      if (m.value) music_[p] = std::move(*m.value);
    } else if (starts_with(p, "data/anims/")) {
      if (!is_anims_path(p)) {
        err("anims.bad_path", p + ": animation sets must be data/anims/<name>.json (lowercase_snake)", p);
        continue;
      }
      auto r = parse_anims(text);
      for (const std::string& m : r.errors) err("anims.invalid", m, p);
      if (r.value) {
        for (const auto& [name, anim] : *r.value) {
          for (const std::string& f : anim.frames) image_ref(p, quote(name) + ": frame ", f.substr(6), "anims.frame_missing", "anims.frame_kind");
        }
        anims_[p] = std::move(*r.value);
      }
    } else if (ends_with(p, ".txt") && !matches_path(p, "data/", kPathChars, ".txt")) {
      warn("data.bad_text_path", p + ": text data files must be data/<dir>/<name>.txt (lowercase)", p);
    }
  }
}

void Validator::parse_scenes() {
  std::unordered_map<std::string, std::string> id_owner;  // entity id -> scene file
  for (const std::string& p : files_.paths("scenes/")) {
    if (!ends_with(p, ".scene.json")) {
      warn("scene.unknown_file", p + " is not a .scene.json file", p);
      continue;
    }
    auto doc = JsonDoc::parse(*files_.text(p));
    if (!doc) {
      err("scene.json", doc.error(), p);
      continue;
    }
    RawScene scene;
    scene.doc = std::move(doc).value();
    Problems problems;
    ObjectView o(scene.doc.root(), "", problems);
    yyjson_val* format = o.take("format");
    if (o.valid() && !format) problems.add("format", "is required");
    else if (format && (!yyjson_is_str(format) || str_of(format) != "0")) problems.add("format", "expected \"0\", got " + json_text(format));
    scene.root = read_string(o, "root", {}, true).value_or("");
    scene.view = read_enum(o, "view", {"side", "topdown", "oblique", "iso"});
    yyjson_val* ents = o.take("entities");
    if (o.valid() && !ents) problems.add("entities", "is required");
    else if (ents && !yyjson_is_obj(ents)) problems.add("entities", "expected an object, got " + json_text(ents));
    for (auto [id, val] : entries(ents)) {
      RawEntity e;
      e.id = std::string(id);
      ObjectView eo(val, child_path("entities", id), problems);
      e.type = read_string(eo, "type", {}, true).value_or("");
      e.name = read_string(eo, "name", {.max_len = 100});
      if (yyjson_val* props = eo.take("props")) {
        if (!yyjson_is_obj(props)) problems.add(child_path(eo.path(), "props"), "expected an object, got " + json_text(props));
        for (auto [k, v] : entries(props)) e.props.emplace_back(std::string(k), v);
      }
      read_array(eo, "scripts", 0, SIZE_MAX, [&](yyjson_val* v, const std::string& path) {
        if (auto s = check_string(v, path, problems,
                                  {.pattern = is_script_path,
                                   .pattern_message = "entity scripts must be scripts/client/*.luau or scripts/server/*.luau"}))
          e.scripts.push_back(*s);
      });
      read_array(eo, "tags", 0, SIZE_MAX, [&](yyjson_val* v, const std::string& path) {
        if (auto s = check_string(v, path, problems, {.pattern = is_tag, .pattern_message = "invalid tag"})) e.tags.push_back(*s);
      });
      auto children = read_array(eo, "children", 0, SIZE_MAX, [&](yyjson_val* v, const std::string& path) {
        if (auto s = check_string(v, path, problems)) e.children.push_back(*s);
      });
      e.has_children_list = children.value_or(false);
      eo.reject_unknown();
      scene.index[e.id] = scene.entities.size();
      scene.entities.push_back(std::move(e));
    }
    o.reject_unknown();
    if (!problems.empty()) {
      err("scene.invalid", problems.joined(), p);
      continue;
    }
    for (const RawEntity& e : scene.entities) {
      auto [it, inserted] = id_owner.emplace(e.id, p);
      if (!inserted) {
        err("entity.duplicate_id", "id " + quote(e.id) + " is used in both " + it->second + " and " + p +
                                       "; ids must be unique across the package", p, e.id);
      }
    }
    raw_scenes_.emplace(p, std::move(scene));
  }
}

void Validator::check_scene(const std::string& file, RawScene& scene) {
  if (scene.view && manifest_ && manifest_->dimension != "2d") {
    err("scene.view_dimension", "view (2.5D) applies to 2D games only", file);
  }
  if (!scene.entity(scene.root)) {
    err("scene.root_missing", "root " + quote(scene.root) + " is not an entity in this scene", file);
    return;
  }

  // Tree integrity: each non-root entity has exactly one parent; no cycles; all reachable.
  std::unordered_map<std::string, std::string> parent_of;
  for (const RawEntity& e : scene.entities) {
    std::unordered_set<std::string> seen;
    for (const std::string& c : e.children) {
      if (seen.count(c)) err("scene.duplicate_child", quote(e.id) + " lists child " + quote(c) + " twice", file, e.id);
      seen.insert(c);
      if (!scene.entity(c)) {
        err("scene.missing_child", quote(e.id) + " lists child " + quote(c) + ", which does not exist", file, e.id);
        continue;
      }
      if (c == scene.root) {
        err("scene.root_as_child", "root " + quote(c) + " cannot be a child of " + quote(e.id), file, e.id);
        continue;
      }
      auto [it, inserted] = parent_of.emplace(c, e.id);
      if (!inserted) err("scene.multiple_parents", quote(c) + " is a child of both " + quote(it->second) + " and " + quote(e.id), file, c);
    }
  }
  std::unordered_set<std::string> reachable;
  std::vector<std::string> stack{scene.root};
  while (!stack.empty()) {
    std::string id = std::move(stack.back());
    stack.pop_back();
    if (!reachable.insert(id).second) continue;
    if (const RawEntity* e = scene.entity(id)) {
      for (const std::string& c : e->children) {
        auto it = parent_of.find(c);
        if (scene.entity(c) && it != parent_of.end() && it->second == id) stack.push_back(c);
      }
    }
  }
  for (const RawEntity& e : scene.entities) {
    if (!reachable.count(e.id)) {
      err("scene.orphan", quote(e.id) + " is not reachable from root " + quote(scene.root) +
                              " (add it to a parent's children, or remove it)", file, e.id);
    }
  }

  SceneDef def;
  def.path = file;
  def.root = scene.root;
  def.view = scene.view;
  for (const RawEntity& e : scene.entities) {
    if (!is_id(e.id)) err("entity.bad_id", "id " + quote(e.id) + " must be lowercase snake_case, start with a letter, ≤64 chars", file, e.id);
    EntityDef out;
    out.id = e.id;
    out.type = e.type;
    out.name = e.name;
    out.scripts = e.scripts;
    out.tags = e.tags;
    out.children = e.children;
    if (auto it = parent_of.find(e.id); it != parent_of.end()) out.parent = it->second;
    check_entity(file, e, scene, &out);
    def.index[out.id] = def.entities.size();
    def.entities.push_back(std::move(out));
  }
  scenes_.emplace(file, std::move(def));
}

void Validator::check_entity(const std::string& file, const RawEntity& e, const RawScene& scene, EntityDef* out) {
  const EntityType* def = catalog_.type(e.type);
  const std::string qid = quote(e.id);
  if (!def) {
    err("entity.unknown_type", qid + " has unknown type " + quote(e.type), file, e.id);
    return;
  }
  if (manifest_ && def->dimension != Dimension::Any && dimension_name(def->dimension) != manifest_->dimension) {
    err("entity.wrong_dimension", qid + " is " + e.type + " (" + dimension_name(def->dimension) + ") but the game is " +
                                      manifest_->dimension, file, e.id);
  }
  if (!def->container && !e.children.empty()) err("entity.not_container", e.type + " " + qid + " cannot have children", file, e.id);

  for (const auto& [key, value] : e.props) {
    const PropDef* prop = def->prop(key);
    if (!prop) {
      std::vector<std::string> valid;
      for (const PropDef& p : def->props) valid.push_back(p.name);
      err("prop.unknown", qid + " (" + e.type + ") has no prop " + quote(key) + ". Valid: " + join(valid, ", "), file, e.id);
      continue;
    }
    PropValue pv;
    if (auto problem = check_prop(*prop, value, scene, &pv)) err("prop.invalid", qid + "." + key + ": " + *problem, file, e.id);
    else out->props.emplace_back(key, std::move(pv));
  }

  for (const std::string& s : e.scripts) {
    if (!files_.has(s)) err("entity.script_missing", qid + " attaches " + s + ", which does not exist", file, e.id);
  }

  if (e.type == "TileMap2D") {
    auto r = resolve_tilemap(files_, string_or_empty(scene.prop(e, "tileset")), string_or_empty(scene.prop(e, "data")));
    for (const std::string& m : r.errors) err("tilemap.invalid", qid + ": " + m, file, e.id);
    for (const std::string& m : r.warnings) warn("tilemap.warning", qid + ": " + m, file, e.id);
  }

  if (e.type == "Sprite2D" && (js_truthy(scene.prop(e, "anims")) || js_truthy(scene.prop(e, "anim")))) {
    std::string path = string_or_empty(scene.prop(e, "anims"));
    std::string anim = string_or_empty(scene.prop(e, "anim"));
    if (path.empty()) {
      if (!anim.empty()) err("anims.missing", qid + ": anim " + quote(anim) + " is set but anims is empty (set anims = \"data/anims/<name>.json\")", file, e.id);
    } else if (!is_anims_path(path)) {
      err("anims.bad_ref", qid + ".anims: expected \"data/anims/<name>.json\", got " + quote(path), file, e.id);
    } else if (!files_.has(path)) {
      err("anims.missing", qid + ".anims: " + path + " does not exist", file, e.id);
    } else if (!anim.empty()) {
      auto set = parse_anims(*files_.text(path)).value.value_or(AnimSet{});
      bool found = std::any_of(set.begin(), set.end(), [&](auto& a) { return a.first == anim; });
      if (!found) {
        std::vector<std::string> names;
        for (const auto& a : set) names.push_back(a.first);
        err("anims.unknown", qid + ".anim: " + quote(anim) + " is not in " + path + " (has: " +
                                 (names.empty() ? std::string("nothing") : join(names, ", ")) + ")", file, e.id);
      }
    }
  }

  if (def->prop("layer")) {
    const std::vector<std::string> declared =
        manifest_ && manifest_->physics_layers ? *manifest_->physics_layers : std::vector<std::string>{};
    std::vector<std::pair<std::string, std::vector<std::string>>> names;
    yyjson_val* layer = scene.prop(e, "layer");
    yyjson_val* mask = scene.prop(e, "mask");
    std::vector<std::string> layer_list, mask_list;
    if (yyjson_is_str(layer) && yyjson_get_len(layer) > 0) layer_list.emplace_back(trim(str_of(layer)));
    if (yyjson_is_str(mask)) {
      for (std::string_view part : split(str_of(mask), ','))
        if (!trim(part).empty()) mask_list.emplace_back(trim(part));
    }
    names.emplace_back("layer", layer_list);
    names.emplace_back("mask", mask_list);
    for (const auto& [key, list] : names) {
      for (const std::string& n : list) {
        if (std::find(declared.begin(), declared.end(), n) != declared.end()) continue;
        std::vector<std::string> all;
        for (const std::string& d : declared) all.push_back(quote(d));
        all.push_back(quote(n));
        err("physics.unknown_layer", qid + "." + key + ": layer " + quote(n) +
                                         " is not declared (add it to dreamsy.toml [physics] layers = [" + join(all, ", ") + "])", file, e.id);
      }
    }
  }

  if (e.type == "Mesh3D" && js_truthy(scene.prop(e, "mesh")) && js_truthy(scene.prop(e, "texture"))) {
    warn("prop.ignored", qid + ": texture is ignored when mesh is set", file, e.id);
  }
}

std::optional<std::string> Validator::check_prop(const PropDef& def, yyjson_val* v, const RawScene& scene, PropValue* out) {
  out->kind = def.kind;
  switch (def.kind) {
    case PropKind::Number:
    case PropKind::Int: {
      const char* kind = def.kind == PropKind::Int ? "int" : "number";
      if (!is_finite_number(v)) return std::string("expected a ") + kind + ", got " + json_text(v);
      double d = yyjson_get_num(v);
      if (def.kind == PropKind::Int && d != std::floor(d)) return "expected an integer, got " + number_text(d);
      if (def.min && d < *def.min) return "must be ≥ " + number_text(*def.min);
      if (def.max && d > *def.max) return "must be ≤ " + number_text(*def.max);
      out->num[0] = d;
      return std::nullopt;
    }
    case PropKind::Bool:
      if (!yyjson_is_bool(v)) return "expected true/false, got " + json_text(v);
      out->flag = yyjson_get_bool(v);
      return std::nullopt;
    case PropKind::String:
      if (!yyjson_is_str(v)) return "expected a string, got " + json_text(v);
      if (def.max_length && utf16_length(str_of(v)) > *def.max_length) return "longer than " + std::to_string(*def.max_length) + " chars";
      out->text = std::string(str_of(v));
      return std::nullopt;
    case PropKind::Vec2:
    case PropKind::Vec3: {
      size_t n = def.kind == PropKind::Vec2 ? 2 : 3;
      bool ok = yyjson_is_arr(v) && yyjson_arr_size(v) == n;
      for (size_t i = 0; ok && i < n; ++i) {
        yyjson_val* item = yyjson_arr_get(v, i);
        ok = is_finite_number(item);
        if (ok) out->num[i] = yyjson_get_num(item);
      }
      if (!ok) return std::string(n == 2 ? "expected [x, y], got " : "expected [x, y, z], got ") + json_text(v);
      return std::nullopt;
    }
    case PropKind::Color:
      if (!yyjson_is_str(v) || !is_color(str_of(v))) return "expected \"#rrggbb\" or \"#rrggbbaa\", got " + json_text(v);
      out->text = std::string(str_of(v));
      return std::nullopt;
    case PropKind::Enum: {
      if (yyjson_is_str(v)) {
        for (const std::string& allowed : def.values) {
          if (str_of(v) == allowed) {
            out->text = allowed;
            return std::nullopt;
          }
        }
      }
      return "expected one of " + join(def.values, " | ") + ", got " + json_text(v);
    }
    case PropKind::Asset: {
      if (!yyjson_is_str(v) || !starts_with(str_of(v), "asset:")) return "expected \"asset:<id>\", got " + json_text(v);
      std::string id(str_of(v).substr(6));
      auto it = assets_.find(id);
      if (it == assets_.end()) return "asset " + quote(id) + " does not exist (needs assets/" + id + ".meta.json)";
      if (it->second.kind != def.asset_kind) {
        return std::string("expected a ") + asset_kind_name(def.asset_kind) + " asset, " + quote(id) + " is " + asset_kind_name(it->second.kind);
      }
      out->text = std::string(str_of(v));
      return std::nullopt;
    }
    case PropKind::Entity:
      if (!yyjson_is_str(v)) return "expected an entity id, got " + json_text(v);
      if (!scene.entity(std::string(str_of(v)))) return "entity " + quote(str_of(v)) + " does not exist in this scene";
      out->text = std::string(str_of(v));
      return std::nullopt;
  }
  return std::nullopt;
}

void Validator::check_script_literals() {
  const std::vector<std::string> enabled_kits =
      catalog_.expand_kits(manifest_ && manifest_->kits ? *manifest_->kits : std::vector<std::string>{});
  for (const std::string& p : files_.paths("scripts/")) {
    if (!ends_with(p, ".luau")) continue;
    std::string_view text = *files_.text(p);

    for (const std::string& target : scan_literal_calls(text, "loadScene", false)) {
      if (files_.has(target) && starts_with(target, "scenes/") && ends_with(target, ".scene.json")) continue;
      std::string name = target;
      if (starts_with(name, "scenes/")) name = name.substr(7);
      if (ends_with(name, ".scene.json")) name = name.substr(0, name.size() - 11);
      std::string guess = "scenes/" + name + ".scene.json";
      err("script.scene_missing", p + ": loadScene(\"" + target + "\") — no such scene" +
                                      (files_.has(guess) ? "; did you mean \"" + guess + "\"?" : std::string(" (scenes are \"scenes/<name>.scene.json\")")), p);
    }

    for (const std::string& req : scan_literal_calls(text, "require", true)) {
      std::string kit;
      if (!is_kit_require(req, &kit)) {
        err("script.bad_kit_require", p + ": require(\"" + req + "\") — kit modules are required as \"@kit/<kit>\" or \"@kit/<kit>/<module>\"", p);
        continue;
      }
      if (!catalog_.kit(kit)) {
        err("script.unknown_kit", p + ": require(\"" + req + "\") — no kit " + quote(kit) + " (available: " + catalog_.kit_names() + ")", p);
      } else if (std::find(enabled_kits.begin(), enabled_kits.end(), kit) == enabled_kits.end()) {
        std::vector<std::string> listed;
        for (const std::string& k : manifest_ && manifest_->kits ? *manifest_->kits : std::vector<std::string>{}) listed.push_back(quote(k));
        listed.push_back(quote(kit));
        err("script.kit_not_enabled", p + ": require(\"" + req + "\") — add " + quote(kit) + " to dreamsy.toml: kits = [" + join(listed, ", ") + "]", p);
      }
    }

    for (std::string_view kind : {"sfx", "music"}) {
      for (const std::string& id : scan_literal_calls(text, std::string(kind) + ".play", false)) {
        std::string file = "data/" + std::string(kind) + "/" + id + ".json";
        if (!files_.has(file)) err("script." + std::string(kind) + "_missing", p + ": " + std::string(kind) + ".play(\"" + id + "\") — " + file + " does not exist", p);
      }
    }
  }
}

void Validator::check_entry_scene() {
  if (!manifest_) return;
  auto it = raw_scenes_.find(manifest_->entry_scene);
  if (it == raw_scenes_.end()) return;
  const RawScene& entry = it->second;
  const std::string camera = manifest_->dimension == "2d" ? "Camera2D" : "Camera3D";
  bool has_camera = false, has_world = false, has_spawn = false;
  for (const RawEntity& e : entry.entities) {
    if (e.type == camera) has_camera = true;
    if (const EntityType* t = catalog_.type(e.type); t && t->dimension != Dimension::Any) has_world = true;
    if (starts_with(e.type, "SpawnPoint")) has_spawn = true;
  }
  // Screen-only scenes (menus, card games built from UI) don't need a camera.
  if (!has_camera && has_world) warn("scene.no_camera", "entry scene has no " + camera + "; a default camera will be used", manifest_->entry_scene);
  if (manifest_->avatar_enabled && !has_spawn) {
    err("scene.no_spawn", "avatar.enabled requires a SpawnPoint2D/SpawnPoint3D in the entry scene", manifest_->entry_scene);
  }
}

std::unique_ptr<Package> Validator::build_package() {
  auto pkg = std::make_unique<Package>();
  pkg->manifest = std::move(*manifest_);
  pkg->scenes = std::move(scenes_);
  pkg->assets = std::move(assets_);
  pkg->tilesets = std::move(tilesets_);
  pkg->anims = std::move(anims_);
  pkg->sfx = std::move(sfx_);
  pkg->music = std::move(music_);
  pkg->files = std::move(files_);
  return pkg;
}

}  // namespace

LoadResult load_package(Files files) { return Validator(std::move(files)).run(); }

}  // namespace dreamsy::pkg
