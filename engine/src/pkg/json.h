// JSON reading for the package loader: a yyjson document wrapper plus a small schema checker
// that mirrors the zod schemas in format/src (strict objects, ranges, patterns, defaults).
//
//   Problems problems;
//   ObjectView o(root, "", problems);
//   auto fps = read_number(o, "fps", {.min = 0.5, .max = 60});
//   o.reject_unknown();
//   if (!problems.empty()) report(problems.joined());
#pragma once

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/result.h"
#include "yyjson.h"

namespace dreamsy::pkg {

// Owns a parsed (immutable) yyjson document.
class JsonDoc {
 public:
  JsonDoc() = default;
  explicit JsonDoc(yyjson_doc* doc) : doc_(doc) {}
  JsonDoc(JsonDoc&& o) noexcept : doc_(std::exchange(o.doc_, nullptr)) {}
  JsonDoc& operator=(JsonDoc&& o) noexcept {
    if (this != &o) {
      if (doc_) yyjson_doc_free(doc_);
      doc_ = std::exchange(o.doc_, nullptr);
    }
    return *this;
  }
  JsonDoc(const JsonDoc&) = delete;
  JsonDoc& operator=(const JsonDoc&) = delete;
  ~JsonDoc() {
    if (doc_) yyjson_doc_free(doc_);
  }

  // Strict JSON (what JavaScript's JSON.parse accepts). Errors read "not valid JSON: ...".
  static Result<JsonDoc> parse(std::string_view text);

  yyjson_val* root() const { return doc_ ? yyjson_doc_get_root(doc_) : nullptr; }

 private:
  yyjson_doc* doc_ = nullptr;
};

// Compact JSON text of a value (JSON.stringify), for error messages. Long values are cut.
std::string json_text(yyjson_val* v);

// Object entries in first-occurrence order with the last duplicate's value, like JSON.parse.
std::vector<std::pair<std::string_view, yyjson_val*>> entries(yyjson_val* obj);

bool is_finite_number(yyjson_val* v);
std::string_view str_of(yyjson_val* v);  // requires yyjson_is_str(v)

// Collected schema problems, each "path: message" (path "(root)" at the top).
class Problems {
 public:
  void add(std::string_view path, std::string_view message);
  bool empty() const { return list_.empty(); }
  const std::vector<std::string>& list() const { return list_; }
  std::string joined() const;  // "; "-separated, like the TS validator's zod messages

 private:
  std::vector<std::string> list_;
};

std::string child_path(std::string_view path, std::string_view key);
std::string child_path(std::string_view path, size_t index);

// A strict object: every key must be read with take(), then reject_unknown() reports the rest.
class ObjectView {
 public:
  ObjectView(yyjson_val* v, std::string path, Problems& problems);

  bool valid() const { return obj_ != nullptr; }
  yyjson_val* take(std::string_view key);  // nullptr when absent (or the object is invalid)
  void reject_unknown();

  const std::string& path() const { return path_; }
  Problems& problems() { return problems_; }

 private:
  yyjson_val* obj_ = nullptr;
  std::string path_;
  Problems& problems_;
  std::vector<std::pair<std::string_view, yyjson_val*>> entries_;
  std::vector<bool> taken_;
};

struct StrRule {
  // Lengths count Unicode code points, as zod 4's .min()/.max() do (not UTF-16 units).
  size_t min_len = 0;
  size_t max_len = static_cast<size_t>(-1);
  bool (*pattern)(std::string_view) = nullptr;
  const char* pattern_message = nullptr;       // shown when `pattern` rejects
};

struct NumRule {
  std::optional<double> min, max;
  bool integer = false;
};

// Field readers. A missing key gives nullopt and, when `required`, a "required" problem.
// A present but wrong value adds a problem and gives nullopt.
std::optional<std::string> read_string(ObjectView& o, std::string_view key, const StrRule& rule = {},
                                       bool required = false);
std::optional<double> read_number(ObjectView& o, std::string_view key, const NumRule& rule = {}, bool required = false);
std::optional<bool> read_bool(ObjectView& o, std::string_view key, bool required = false);
std::optional<std::string> read_enum(ObjectView& o, std::string_view key, const std::vector<std::string_view>& values,
                                     bool required = false);

// Checks a value (not a field) — for array elements and records.
std::optional<std::string> check_string(yyjson_val* v, std::string_view path, Problems& p, const StrRule& rule = {});
std::optional<double> check_number(yyjson_val* v, std::string_view path, Problems& p, const NumRule& rule = {});

// Array field: checks the length, then calls `each(element, element_path)` for every item.
// Returns false (with a problem) if present and not an array or out of bounds; nullopt if absent.
std::optional<bool> read_array(ObjectView& o, std::string_view key, size_t min_items, size_t max_items,
                               const std::function<void(yyjson_val*, const std::string&)>& each,
                               bool required = false);

}  // namespace dreamsy::pkg
