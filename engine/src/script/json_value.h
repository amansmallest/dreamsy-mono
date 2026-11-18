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
  // Object members in insertion order. (A struct defined below, not std::pair<std::string, Json>:
  // Json is incomplete here, and libstdc++ rejects pair<..., Json> until it is complete.)
  struct Member;
  std::vector<Member> object;

  static Json object_value();
  static Json string_value(std::string s);
  static Json number_value(double n);
  static Json bool_value(bool b);
  static Json from_yyjson(yyjson_val* v);
  std::string stringify() const;  // JSON.stringify
  // Sets a key keeping JS order: an existing key keeps its position.
  void set(const std::string& key, Json value);
  bool remove(const std::string& key);
  const Json* find(const std::string& key) const;
};

struct Json::Member {
  Member(std::string k, Json v) : first(std::move(k)), second(std::move(v)) {}
  std::string first;
  Json second;
};

// Defined here, after Member, because they return Json by value (which needs Member complete).
inline Json Json::object_value() { Json j; j.type = Type::Object; return j; }
inline Json Json::string_value(std::string s) { Json j; j.type = Type::String; j.string = std::move(s); return j; }
inline Json Json::number_value(double n) { Json j; j.type = Type::Number; j.number = n; return j; }
inline Json Json::bool_value(bool b) { Json j; j.type = Type::Bool; j.boolean = b; return j; }

// Pushes a JSON value as Lua (arrays 1-based, null -> nil), like engine-web's pushJSON.
void push_json(lua_State* L, const Json& v);

// Reads a Lua value as JSON, like engine-web's readJSON (save data rules): nil -> null; tables
// whose keys are exactly 1..n become arrays, other tables objects; keys must be strings or
// numbers; numbers must be finite; at most 32 levels. Errors are raised as Lua errors.
Json read_json(lua_State* L, int index, int depth = 0);

}  // namespace dreamsy::script
