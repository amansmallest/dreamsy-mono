#include "pkg/json.h"

#include <cmath>
#include <cstdlib>
#include <memory>
#include <unordered_map>

#include "pkg/text.h"

namespace dreamsy::pkg {

Result<JsonDoc> JsonDoc::parse(std::string_view text) {
  // An empty file can have a null data pointer, which yyjson's error locator mishandles
  // (found by engine/fuzz); JSON.parse("") fails too, so report it here.
  if (text.empty()) return Error{"not valid JSON: the file is empty"};
  yyjson_read_err err{};
  // yyjson takes a mutable pointer only when the INSITU flag is set; we don't set it.
  yyjson_doc* doc = yyjson_read_opts(const_cast<char*>(text.data()), text.size(), YYJSON_READ_NOFLAG, nullptr, &err);
  if (!doc) {
    size_t line = 0, col = 0, chr = 0;
    yyjson_locate_pos(text.data(), text.size(), err.pos, &line, &col, &chr);
    return Error{"not valid JSON: " + std::string(err.msg) + " at line " + std::to_string(line) + " column " +
                 std::to_string(col)};
  }
  return JsonDoc(doc);
}

std::string json_text(yyjson_val* v) {
  if (!v) return "undefined";
  size_t len = 0;
  std::unique_ptr<char, decltype(&free)> s(yyjson_val_write(v, YYJSON_WRITE_ALLOW_INF_AND_NAN, &len), &free);
  if (!s) return "?";
  std::string out(s.get(), len);
  if (out.size() > 120) out = out.substr(0, 117) + "...";
  return out;
}

std::vector<std::pair<std::string_view, yyjson_val*>> entries(yyjson_val* obj) {
  std::vector<std::pair<std::string_view, yyjson_val*>> out;
  if (!yyjson_is_obj(obj)) return out;
  std::unordered_map<std::string_view, size_t> index;
  yyjson_obj_iter it = yyjson_obj_iter_with(obj);
  while (yyjson_val* key = yyjson_obj_iter_next(&it)) {
    yyjson_val* val = yyjson_obj_iter_get_val(key);
    std::string_view k(yyjson_get_str(key), yyjson_get_len(key));
    auto [pos, inserted] = index.emplace(k, out.size());
    if (inserted) out.emplace_back(k, val);
    else out[pos->second].second = val;  // last duplicate wins, first position kept
  }
  return out;
}

bool is_finite_number(yyjson_val* v) { return yyjson_is_num(v) && std::isfinite(yyjson_get_num(v)); }

std::string_view str_of(yyjson_val* v) { return {yyjson_get_str(v), yyjson_get_len(v)}; }

void Problems::add(std::string_view path, std::string_view message) {
  list_.push_back((path.empty() ? std::string("(root)") : std::string(path)) + ": " + std::string(message));
}

std::string Problems::joined() const { return join(list_, "; "); }

std::string child_path(std::string_view path, std::string_view key) {
  return path.empty() ? std::string(key) : std::string(path) + "." + std::string(key);
}

std::string child_path(std::string_view path, size_t index) { return child_path(path, std::to_string(index)); }

ObjectView::ObjectView(yyjson_val* v, std::string path, Problems& problems)
    : path_(std::move(path)), problems_(problems) {
  if (!yyjson_is_obj(v)) {
    problems_.add(path_, "expected an object, got " + json_text(v));
    return;
  }
  obj_ = v;
  entries_ = entries(v);
  taken_.assign(entries_.size(), false);
}

yyjson_val* ObjectView::take(std::string_view key) {
  for (size_t i = 0; i < entries_.size(); ++i) {
    if (entries_[i].first == key) {
      taken_[i] = true;
      return entries_[i].second;
    }
  }
  return nullptr;
}

void ObjectView::reject_unknown() {
  for (size_t i = 0; i < entries_.size(); ++i) {
    if (!taken_[i]) problems_.add(path_, "unknown key " + quote(entries_[i].first));
  }
}

std::optional<std::string> check_string(yyjson_val* v, std::string_view path, Problems& p, const StrRule& rule) {
  if (!yyjson_is_str(v)) {
    p.add(path, "expected a string, got " + json_text(v));
    return std::nullopt;
  }
  std::string_view s = str_of(v);
  size_t len = code_points(s).size();
  if (len < rule.min_len) {
    p.add(path, rule.min_len == 1 ? std::string("must not be empty")
                                  : "must be at least " + std::to_string(rule.min_len) + " characters");
    return std::nullopt;
  }
  if (len > rule.max_len) {
    p.add(path, "must be at most " + std::to_string(rule.max_len) + " characters");
    return std::nullopt;
  }
  if (rule.pattern && !rule.pattern(s)) {
    p.add(path, rule.pattern_message ? std::string(rule.pattern_message) : "invalid value " + quote(s));
    return std::nullopt;
  }
  return std::string(s);
}

std::optional<double> check_number(yyjson_val* v, std::string_view path, Problems& p, const NumRule& rule) {
  if (!is_finite_number(v)) {
    p.add(path, std::string("expected a ") + (rule.integer ? "integer" : "number") + ", got " + json_text(v));
    return std::nullopt;
  }
  double d = yyjson_get_num(v);
  if (rule.integer && d != std::floor(d)) {
    p.add(path, "expected an integer, got " + number_text(d));
    return std::nullopt;
  }
  if (rule.min && d < *rule.min) {
    p.add(path, "must be ≥ " + number_text(*rule.min));
    return std::nullopt;
  }
  if (rule.max && d > *rule.max) {
    p.add(path, "must be ≤ " + number_text(*rule.max));
    return std::nullopt;
  }
  return d;
}

namespace {
yyjson_val* take_field(ObjectView& o, std::string_view key, bool required) {
  if (!o.valid()) return nullptr;
  yyjson_val* v = o.take(key);
  if (!v && required) o.problems().add(child_path(o.path(), key), "is required");
  return v;
}
}  // namespace

std::optional<std::string> read_string(ObjectView& o, std::string_view key, const StrRule& rule, bool required) {
  yyjson_val* v = take_field(o, key, required);
  if (!v) return std::nullopt;
  return check_string(v, child_path(o.path(), key), o.problems(), rule);
}

std::optional<double> read_number(ObjectView& o, std::string_view key, const NumRule& rule, bool required) {
  yyjson_val* v = take_field(o, key, required);
  if (!v) return std::nullopt;
  return check_number(v, child_path(o.path(), key), o.problems(), rule);
}

std::optional<bool> read_bool(ObjectView& o, std::string_view key, bool required) {
  yyjson_val* v = take_field(o, key, required);
  if (!v) return std::nullopt;
  if (!yyjson_is_bool(v)) {
    o.problems().add(child_path(o.path(), key), "expected true/false, got " + json_text(v));
    return std::nullopt;
  }
  return yyjson_get_bool(v);
}

std::optional<std::string> read_enum(ObjectView& o, std::string_view key, const std::vector<std::string_view>& values,
                                     bool required) {
  yyjson_val* v = take_field(o, key, required);
  if (!v) return std::nullopt;
  if (yyjson_is_str(v)) {
    for (std::string_view allowed : values)
      if (str_of(v) == allowed) return std::string(allowed);
  }
  std::vector<std::string> quoted;
  for (std::string_view allowed : values) quoted.push_back(quote(allowed));
  o.problems().add(child_path(o.path(), key), "expected one of " + join(quoted, " | ") + ", got " + json_text(v));
  return std::nullopt;
}

std::optional<bool> read_array(ObjectView& o, std::string_view key, size_t min_items, size_t max_items,
                               const std::function<void(yyjson_val*, const std::string&)>& each, bool required) {
  yyjson_val* v = take_field(o, key, required);
  if (!v) return std::nullopt;
  std::string path = child_path(o.path(), key);
  if (!yyjson_is_arr(v)) {
    o.problems().add(path, "expected an array, got " + json_text(v));
    return false;
  }
  size_t n = yyjson_arr_size(v);
  if (n < min_items) {
    o.problems().add(path, "must have at least " + std::to_string(min_items) + " item" + (min_items == 1 ? "" : "s"));
    return false;
  }
  if (n > max_items) {
    o.problems().add(path, "must have at most " + std::to_string(max_items) + " items");
    return false;
  }
  size_t i = 0;
  yyjson_val* item;
  yyjson_arr_iter it = yyjson_arr_iter_with(v);
  while ((item = yyjson_arr_iter_next(&it))) each(item, child_path(path, i++));
  return true;
}

}  // namespace dreamsy::pkg
