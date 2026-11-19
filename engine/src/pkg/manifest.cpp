#include "pkg/manifest.h"

#include <memory>
#include <sstream>

#include "pkg/json.h"
#include "pkg/text.h"

// toml++ parses untrusted manifests. Its internal assertions must never become compiler
// "assume" hints (which is what they turn into under NDEBUG: undefined behavior if an
// invariant is broken), so they stay on in every build and stop with a clear message.
// engine/fuzz found one such bug in v3.4.0; see third_party/tomlplusplus/DREAMSY_VENDOR.md.
#include "base/check.h"
#define TOML_EXCEPTIONS 0
#define TOML_ENABLE_FORMATTERS 0
#define TOML_ASSERT(expr) DREAMSY_CHECK(expr, "toml++ internal invariant violated")
#ifdef NDEBUG
#define DREAMSY_RESTORE_NDEBUG
#undef NDEBUG
#endif
#include "toml.hpp"
#ifdef DREAMSY_RESTORE_NDEBUG
#define NDEBUG
#undef DREAMSY_RESTORE_NDEBUG
#endif

namespace dreamsy::pkg {

namespace {

// ---------------------------------------------------------------- TOML -> JSON tree

// The TS validator parses TOML into plain JS values and runs zod on them. We convert the TOML
// tree to a yyjson document and run the same JSON checks. TOML dates/times have no JSON
// equivalent; they become {"toml_datetime": "..."} so any field expecting a scalar rejects them,
// as zod rejects the Date objects the TS parser produces.
yyjson_mut_val* to_json(yyjson_mut_doc* doc, const toml::node& node) {
  if (auto* t = node.as_table()) {
    yyjson_mut_val* obj = yyjson_mut_obj(doc);
    for (auto&& [key, value] : *t) {
      yyjson_mut_obj_add(obj, yyjson_mut_strncpy(doc, key.str().data(), key.str().size()), to_json(doc, value));
    }
    return obj;
  }
  if (auto* a = node.as_array()) {
    yyjson_mut_val* arr = yyjson_mut_arr(doc);
    for (auto&& value : *a) yyjson_mut_arr_append(arr, to_json(doc, value));
    return arr;
  }
  if (auto* s = node.as_string()) return yyjson_mut_strncpy(doc, s->get().data(), s->get().size());
  if (auto* i = node.as_integer()) return yyjson_mut_sint(doc, i->get());
  if (auto* f = node.as_floating_point()) return yyjson_mut_real(doc, f->get());
  if (auto* b = node.as_boolean()) return yyjson_mut_bool(doc, b->get());
  yyjson_mut_val* obj = yyjson_mut_obj(doc);
  yyjson_mut_obj_add(obj, yyjson_mut_str(doc, "toml_datetime"), yyjson_mut_str(doc, "?"));
  return obj;
}

// ---------------------------------------------------------------- patterns

bool is_entry_scene(std::string_view s) { return matches_path(s, "scenes/", kPathChars, ".scene.json"); }
bool is_layer_name(std::string_view s) { return is_snake(s, 31); }
bool is_store_id(std::string_view s) { return is_snake(s, 39); }
bool is_icon_ref(std::string_view s) { return starts_with(s, "asset:") && is_id(s.substr(6)); }
bool is_pack(std::string_view s) {
  if (s.empty() || s.size() > 40 || !is_lower(s[0])) return false;
  for (char c : s)
    if (!is_lower(c) && !is_digit(c) && c != '-') return false;
  return true;
}

const StrRule kHex6{.pattern = is_hex6_color, .pattern_message = "expected \"#rrggbb\""};

std::optional<std::vector<std::string>> read_string_list(ObjectView& o, std::string_view key, size_t max_items,
                                                         const StrRule& rule = {}) {
  std::vector<std::string> out;
  bool all_ok = true;
  auto present = read_array(o, key, 0, max_items, [&](yyjson_val* v, const std::string& path) {
    if (auto s = check_string(v, path, o.problems(), rule)) out.push_back(*s);
    else all_ok = false;
  });
  if (!present || !*present || !all_ok) return std::nullopt;
  return out;
}

int to_int(double d) { return static_cast<int>(d); }

}  // namespace

Result<Manifest> parse_manifest(std::string_view text) {
  toml::parse_result parsed = toml::parse(text);
  if (!parsed) {
    const auto& err = parsed.error();
    return Error{"not valid TOML: " + std::string(err.description()) + " (line " +
                 std::to_string(err.source().begin.line) + ", column " + std::to_string(err.source().begin.column) +
                 ")"};
  }

  std::unique_ptr<yyjson_mut_doc, decltype(&yyjson_mut_doc_free)> mdoc(yyjson_mut_doc_new(nullptr),
                                                                       &yyjson_mut_doc_free);
  yyjson_mut_doc_set_root(mdoc.get(), to_json(mdoc.get(), parsed.table()));
  JsonDoc doc(yyjson_mut_doc_imut_copy(mdoc.get(), nullptr));

  Problems problems;
  ObjectView o(doc.root(), "", problems);
  Manifest m;

  yyjson_val* format = o.take("format");
  if (!format) problems.add("format", "is required");
  else if (!yyjson_is_str(format) || str_of(format) != "0") problems.add("format", "expected \"0\", got " + json_text(format));

  m.id = read_string(o, "id");
  if (auto v = read_string(o, "name", {.min_len = 1, .max_len = 80}, true)) m.name = *v;
  m.description = read_string(o, "description", {.max_len = 2000});
  if (auto v = read_enum(o, "dimension", {"2d", "3d"}, true)) m.dimension = *v;
  m.orientation = read_enum(o, "orientation", {"portrait", "landscape"});
  m.view = read_enum(o, "view", {"side", "topdown", "oblique", "iso"});
  if (auto v = read_string(o, "entry_scene",
                           {.pattern = is_entry_scene, .pattern_message = "entry_scene must be scenes/<name>.scene.json"},
                           true))
    m.entry_scene = *v;

  if (yyjson_val* v = o.take("players")) {
    ObjectView p(v, "players", problems);
    m.players_min = to_int(read_number(p, "min", {.min = 1, .integer = true}).value_or(1));
    m.players_max = to_int(read_number(p, "max", {.min = 1, .max = 200, .integer = true}).value_or(1));
    p.reject_unknown();
  }

  if (yyjson_val* v = o.take("server")) {
    ObjectView s(v, "server", problems);
    m.server_mode = read_enum(s, "mode", {"none", "rooms", "persistent", "async"}).value_or("none");
    m.server_tick_rate = to_int(read_number(s, "tick_rate", {.min = 1, .max = 120, .integer = true}).value_or(30));
    m.server_deterministic = read_bool(s, "deterministic").value_or(false);
    s.reject_unknown();
  }

  m.kits = read_string_list(o, "kits", 8);

  if (yyjson_val* v = o.take("avatar")) {
    ObjectView a(v, "avatar", problems);
    m.avatar_enabled = read_bool(a, "enabled").value_or(false);
    a.reject_unknown();
  }

  if (yyjson_val* v = o.take("physics")) {
    ObjectView ph(v, "physics", problems);
    auto layers = read_string_list(ph, "layers", 16,
                                   {.pattern = is_layer_name, .pattern_message = "layer names must be lowercase_snake"});
    if (layers) {
      for (size_t i = 0; i < layers->size(); ++i)
        for (size_t j = 0; j < i; ++j)
          if ((*layers)[i] == (*layers)[j]) {
            problems.add("physics.layers", "layer names must be unique");
            i = layers->size();
            break;
          }
    }
    m.physics_layers = layers.value_or(std::vector<std::string>{});
    ph.reject_unknown();
  }

  if (yyjson_val* v = o.take("ui")) {
    ObjectView u(v, "ui", problems);
    Manifest::Ui ui;
    ui.primary = read_string(u, "primary", kHex6);
    ui.accent = read_string(u, "accent", kHex6);
    ui.background = read_string(u, "background", kHex6);
    ui.text = read_string(u, "text", kHex6);
    ui.panel = read_enum(u, "panel", {"pixel", "rounded", "sharp", "outlined"});
    ui.font = read_enum(u, "font", {"pixel", "rounded", "bold", "serif"});
    u.reject_unknown();
    m.ui = ui;
  }

  read_array(o, "store", 0, 50, [&](yyjson_val* v, const std::string& path) {
    ObjectView s(v, path, problems);
    StoreItem item;
    item.id = read_string(s, "id", {.pattern = is_store_id, .pattern_message = "store item id must be lowercase_snake"},
                          true)
                  .value_or("");
    item.kind = read_enum(s, "kind", {"pass", "consumable"}, true).value_or("");
    item.name = read_string(s, "name", {.min_len = 1, .max_len = 40}, true).value_or("");
    item.description = read_string(s, "description", {.max_len = 200}).value_or("");
    item.price = to_int(read_number(s, "price", {.min = 1, .max = 100000, .integer = true}, true).value_or(0));
    item.icon = read_string(s, "icon", {.pattern = is_icon_ref, .pattern_message = "expected \"asset:<id>\""});
    s.reject_unknown();
    m.store.push_back(std::move(item));
  });

  if (yyjson_val* v = o.take("style")) {
    ObjectView s(v, "style", problems);
    m.style.preset = read_enum(s, "preset", {"pixel", "blocky", "clean", "toon", "custom"}, true).value_or("clean");
    m.style.pack = read_string(s, "pack", {.pattern = is_pack, .pattern_message = "invalid pack name"});
    m.style.palette = read_string_list(s, "palette", 32, kHex6);
    m.style.notes = read_string(s, "notes", {.max_len = 2000});
    m.style.references = read_string_list(s, "references", 8);
    if (yyjson_val* g = s.take("grid")) {
      double d = is_finite_number(g) ? yyjson_get_num(g) : 0;
      if (d == 8 || d == 16 || d == 32) m.style.grid = to_int(d);
      else problems.add("style.grid", "expected 8, 16 or 32, got " + json_text(g));
    }
    s.reject_unknown();
  }

  o.reject_unknown();
  if (!problems.empty()) return Error{problems.joined()};
  return m;
}

}  // namespace dreamsy::pkg
