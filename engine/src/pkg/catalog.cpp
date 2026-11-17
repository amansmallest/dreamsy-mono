#include "pkg/catalog.h"

#include <algorithm>
#include <string>

#include "base/check.h"
#include "pkg/embedded.h"
#include "pkg/json.h"

namespace dreamsy::pkg {

const char* dimension_name(Dimension d) {
  switch (d) {
    case Dimension::Any: return "any";
    case Dimension::D2: return "2d";
    case Dimension::D3: return "3d";
  }
  return "?";
}

const char* asset_kind_name(AssetKind k) {
  switch (k) {
    case AssetKind::Image: return "image";
    case AssetKind::Mesh: return "mesh";
    case AssetKind::Audio: return "audio";
    case AssetKind::Font: return "font";
  }
  return "?";
}

std::optional<AssetKind> asset_kind_from(std::string_view name) {
  if (name == "image") return AssetKind::Image;
  if (name == "mesh") return AssetKind::Mesh;
  if (name == "audio") return AssetKind::Audio;
  if (name == "font") return AssetKind::Font;
  return std::nullopt;
}

const PropDef* EntityType::prop(std::string_view key) const {
  for (const PropDef& p : props)
    if (p.name == key) return &p;
  return nullptr;
}

namespace {

// The embedded data comes from our own build, so a malformed catalog is a build bug: fail loudly.
#define CATALOG_CHECK(cond) DREAMSY_CHECK(cond, "embedded catalog.json is malformed; regenerate it")

PropKind kind_from(std::string_view s) {
  if (s == "number") return PropKind::Number;
  if (s == "int") return PropKind::Int;
  if (s == "bool") return PropKind::Bool;
  if (s == "string") return PropKind::String;
  if (s == "vec2") return PropKind::Vec2;
  if (s == "vec3") return PropKind::Vec3;
  if (s == "color") return PropKind::Color;
  if (s == "enum") return PropKind::Enum;
  if (s == "asset") return PropKind::Asset;
  if (s == "entity") return PropKind::Entity;
  CATALOG_CHECK(false);
  return PropKind::Number;
}

PropValue default_from(PropKind kind, yyjson_val* v) {
  PropValue out;
  out.kind = kind;
  switch (kind) {
    case PropKind::Number:
    case PropKind::Int:
      CATALOG_CHECK(yyjson_is_num(v));
      out.num[0] = yyjson_get_num(v);
      break;
    case PropKind::Bool:
      CATALOG_CHECK(yyjson_is_bool(v));
      out.flag = yyjson_get_bool(v);
      break;
    case PropKind::Vec2:
    case PropKind::Vec3: {
      size_t n = kind == PropKind::Vec2 ? 2 : 3;
      CATALOG_CHECK(yyjson_is_arr(v) && yyjson_arr_size(v) == n);
      for (size_t i = 0; i < n; ++i) out.num[i] = yyjson_get_num(yyjson_arr_get(v, i));
      break;
    }
    default:
      CATALOG_CHECK(yyjson_is_str(v));
      out.text = std::string(str_of(v));
  }
  return out;
}

}  // namespace

const Catalog& Catalog::get() {
  static const Catalog catalog = [] {
    Catalog c;
    auto doc = JsonDoc::parse(embedded::catalog_json());
    CATALOG_CHECK(doc.ok());
    yyjson_val* root = doc.value().root();

    for (auto [name, def] : entries(yyjson_obj_get(root, "entities"))) {
      EntityType t;
      t.name = std::string(name);
      std::string_view dim = str_of(yyjson_obj_get(def, "dimension"));
      t.dimension = dim == "2d" ? Dimension::D2 : dim == "3d" ? Dimension::D3 : Dimension::Any;
      t.container = yyjson_get_bool(yyjson_obj_get(def, "container"));
      for (auto [pname, pdef] : entries(yyjson_obj_get(def, "props"))) {
        PropDef p;
        p.name = std::string(pname);
        yyjson_val* type = yyjson_obj_get(pdef, "type");
        CATALOG_CHECK(type);
        p.kind = kind_from(str_of(yyjson_obj_get(type, "kind")));
        if (yyjson_val* v = yyjson_obj_get(type, "min")) p.min = yyjson_get_num(v);
        if (yyjson_val* v = yyjson_obj_get(type, "max")) p.max = yyjson_get_num(v);
        if (yyjson_val* v = yyjson_obj_get(type, "maxLength")) p.max_length = static_cast<size_t>(yyjson_get_num(v));
        if (yyjson_val* v = yyjson_obj_get(type, "values")) {
          size_t i, n;
          yyjson_val* item;
          yyjson_arr_foreach(v, i, n, item) p.values.emplace_back(str_of(item));
        }
        if (yyjson_val* v = yyjson_obj_get(type, "assetKind")) {
          auto k = asset_kind_from(str_of(v));
          CATALOG_CHECK(k.has_value());
          p.asset_kind = *k;
        }
        if (yyjson_val* v = yyjson_obj_get(pdef, "default")) p.default_value = default_from(p.kind, v);
        t.props.push_back(std::move(p));
      }
      c.types_.push_back(std::move(t));
    }

    for (auto [name, def] : entries(yyjson_obj_get(root, "styles"))) {
      StyleDef s;
      s.name = std::string(name);
      size_t i, n;
      yyjson_val* item;
      yyjson_arr_foreach(yyjson_obj_get(def, "dimensions"), i, n, item) s.dimensions.emplace_back(str_of(item));
      c.styles_.push_back(std::move(s));
    }

    auto kits = JsonDoc::parse(embedded::kits_json());
    CATALOG_CHECK(kits.ok());
    for (auto [name, def] : entries(kits.value().root())) {
      KitDef k;
      k.name = std::string(name);
      size_t i, n;
      yyjson_val* item;
      yyjson_arr_foreach(yyjson_obj_get(def, "requires"), i, n, item) k.requires_kits.emplace_back(str_of(item));
      c.kits_.push_back(std::move(k));
    }
    CATALOG_CHECK(!c.types_.empty() && !c.styles_.empty() && !c.kits_.empty());
    return c;
  }();
  return catalog;
}

const EntityType* Catalog::type(std::string_view name) const {
  for (const EntityType& t : types_)
    if (t.name == name) return &t;
  return nullptr;
}

const StyleDef* Catalog::style(std::string_view name) const {
  for (const StyleDef& s : styles_)
    if (s.name == name) return &s;
  return nullptr;
}

const KitDef* Catalog::kit(std::string_view name) const {
  for (const KitDef& k : kits_)
    if (k.name == name) return &k;
  return nullptr;
}

std::string Catalog::kit_names() const {
  std::string out;
  for (const KitDef& k : kits_) out += (out.empty() ? "" : ", ") + k.name;
  return out;
}

std::vector<std::string> Catalog::expand_kits(const std::vector<std::string>& listed) const {
  std::vector<std::string> out;
  // Iterative depth-first visit in the same order as the recursive TS version.
  struct Frame {
    std::string kit;
    size_t next_dep = 0;
  };
  for (const std::string& start : listed) {
    if (std::find(out.begin(), out.end(), start) != out.end()) continue;
    out.push_back(start);
    std::vector<Frame> stack{{start}};
    while (!stack.empty()) {
      Frame& f = stack.back();
      const KitDef* def = kit(f.kit);
      if (!def || f.next_dep >= def->requires_kits.size()) {
        stack.pop_back();
        continue;
      }
      const std::string& dep = def->requires_kits[f.next_dep++];
      if (std::find(out.begin(), out.end(), dep) != out.end()) continue;
      out.push_back(dep);
      stack.push_back({dep});
    }
  }
  return out;
}

}  // namespace dreamsy::pkg
