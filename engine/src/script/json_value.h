// A JSON value for data that crosses into scripts (save data, data.read, room state), with
// JavaScript semantics where it matters: object keys keep insertion order (like JS objects) and
// serialization matches JSON.stringify for the values scripts can create.
#pragma once

#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/result.h"
#include "yyjson.h"

struct lua_State;

namespace dreamsy::script {

struct Json {
  enum class Type { Null, Bool, Number, String, Array, Object } type = Type::Null;
  bool boolean = false;
  double number = 0;
  std::string string;
  std::vector<Json> array;
  std::vector<std::pair<std::string, Json>> object;  // insertion order

  static Json object_value() { Json j; j.type = Type::Object; return j; }
  static Json string_value(std::string s) { Json j; j.type = Type::String; j.string = std::move(s); return j; }
  static Json number_value(double n) { Json j; j.type = Type::Number; j.number = n; return j; }
  static Json bool_value(bool b) { Json j; j.type = Type::Bool; j.boolean = b; return j; }
  static Json from_yyjson(yyjson_val* v);
  std::string stringify() const;  // JSON.stringify
  // Sets a key keeping JS order: an existing key keeps its position.
  void set(const std::string& key, Json value);
  bool remove(const std::string& key);
  const Json* find(const std::string& key) const;
};

// Pushes a JSON value as Lua (arrays 1-based, null -> nil), like engine-web's pushJSON.
void push_json(lua_State* L, const Json& v);

// Reads a Lua value as JSON, like engine-web's readJSON (save data rules): nil -> null; tables
// whose keys are exactly 1..n become arrays, other tables objects; keys must be strings or
// numbers; numbers must be finite; at most 32 levels. Errors are raised as Lua errors.
Json read_json(lua_State* L, int index, int depth = 0);

}  // namespace dreamsy::script
