#include "script/json_value.h"

#include <algorithm>
#include <cmath>

#include "lua.h"
#include "lualib.h"
#include "pkg/json.h"
#include "pkg/text.h"
#include "script/lua_util.h"

namespace dreamsy::script {

Json Json::from_yyjson(yyjson_val* v) {
  Json out;
  if (yyjson_is_bool(v)) {
    out.type = Type::Bool;
    out.boolean = yyjson_get_bool(v);
  } else if (yyjson_is_num(v)) {
    out.type = Type::Number;
    out.number = yyjson_get_num(v);
  } else if (yyjson_is_str(v)) {
    out.type = Type::String;
    out.string = std::string(pkg::str_of(v));
  } else if (yyjson_is_arr(v)) {
    out.type = Type::Array;
    size_t i, n;
    yyjson_val* item;
    yyjson_arr_foreach(v, i, n, item) out.array.push_back(from_yyjson(item));
  } else if (yyjson_is_obj(v)) {
    out.type = Type::Object;
    for (auto [k, x] : pkg::entries(v)) out.object.emplace_back(std::string(k), from_yyjson(x));
  }
  return out;
}

std::string Json::stringify() const {
  switch (type) {
    case Type::Null: return "null";
    case Type::Bool: return boolean ? "true" : "false";
    case Type::Number: return std::isfinite(number) ? pkg::number_text(number) : "null";
    case Type::String: return pkg::quote(string);
    case Type::Array: {
      std::string s = "[";
      for (size_t i = 0; i < array.size(); ++i) s += (i ? "," : "") + array[i].stringify();
      return s + "]";
    }
    case Type::Object: {
      std::string s = "{";
      for (size_t i = 0; i < object.size(); ++i) s += (i ? "," : "") + pkg::quote(object[i].first) + ":" + object[i].second.stringify();
      return s + "}";
    }
  }
  return "null";
}

void Json::set(const std::string& key, Json value) {
  for (auto& [k, v] : object) {
    if (k == key) {
      v = std::move(value);
      return;
    }
  }
  object.emplace_back(key, std::move(value));
}

bool Json::remove(const std::string& key) {
  auto it = std::find_if(object.begin(), object.end(), [&](const auto& kv) { return kv.first == key; });
  if (it == object.end()) return false;
  object.erase(it);
  return true;
}

const Json* Json::find(const std::string& key) const {
  for (const auto& [k, v] : object)
    if (k == key) return &v;
  return nullptr;
}

void push_json(lua_State* L, const Json& v) {
  lua_checkstack(L, 3);
  switch (v.type) {
    case Json::Type::Null: lua_pushnil(L); return;
    case Json::Type::Bool: lua_pushboolean(L, v.boolean); return;
    case Json::Type::Number: lua_pushnumber(L, v.number); return;
    case Json::Type::String: lua_pushlstring(L, v.string.data(), v.string.size()); return;
    case Json::Type::Array:
      lua_createtable(L, static_cast<int>(v.array.size()), 0);
      for (size_t i = 0; i < v.array.size(); ++i) {
        push_json(L, v.array[i]);
        lua_rawseti(L, -2, static_cast<int>(i + 1));
      }
      return;
    case Json::Type::Object:
      lua_createtable(L, 0, static_cast<int>(v.object.size()));
      for (const auto& [k, x] : v.object) {
        push_json(L, x);
        lua_setfield(L, -2, k.c_str());
      }
      return;
  }
}

Json read_json(lua_State* L, int index, int depth) {
  if (depth > 32) raise(L, "save: value is nested too deeply (max 32 levels)");
  int t = lua_type(L, index);
  Json out;
  if (t <= LUA_TNIL) return out;
  if (t == LUA_TBOOLEAN) {
    out.type = Json::Type::Bool;
    out.boolean = lua_toboolean(L, index);
    return out;
  }
  if (t == LUA_TNUMBER) {
    double n = lua_tonumber(L, index);
    if (!std::isfinite(n)) raise(L, "save: numbers must be finite");
    out.type = Json::Type::Number;
    out.number = n;
    return out;
  }
  if (t == LUA_TSTRING) {
    size_t len = 0;
    const char* s = lua_tolstring(L, index, &len);
    out.type = Json::Type::String;
    out.string.assign(s, len);
    return out;
  }
  if (t != LUA_TTABLE) raise(L, "save: values must be nil, booleans, numbers, strings or tables of those");

  int idx = index < 0 ? lua_gettop(L) + index + 1 : index;
  struct Entry {
    bool numeric;
    double num;
    std::string str;
    Json value;
  };
  std::vector<Entry> list;
  lua_checkstack(L, 4);
  lua_pushnil(L);
  while (lua_next(L, idx)) {
    Entry e;
    int kt = lua_type(L, -2);
    if (kt == LUA_TNUMBER) {
      e.numeric = true;
      e.num = lua_tonumber(L, -2);
    } else if (kt == LUA_TSTRING) {
      e.numeric = false;
      size_t len = 0;
      const char* s = lua_tolstring(L, -2, &len);
      e.str.assign(s, len);
    } else {
      lua_pop(L, 2);
      raise(L, "save: table keys must be strings or numbers");
    }
    e.value = read_json(L, -1, depth + 1);
    lua_pop(L, 1);
    list.push_back(std::move(e));
  }
  size_t n = list.size();
  bool is_array = n > 0 && std::all_of(list.begin(), list.end(), [&](const Entry& e) {
    return e.numeric && e.num == std::floor(e.num) && e.num >= 1 && e.num <= static_cast<double>(n);
  });
  if (is_array) {
    out.type = Json::Type::Array;
    out.array.resize(n);
    for (Entry& e : list) out.array[static_cast<size_t>(e.num) - 1] = std::move(e.value);
    return out;
  }
  out.type = Json::Type::Object;
  for (Entry& e : list) out.set(e.numeric ? pkg::number_text(e.num) : e.str, std::move(e.value));
  return out;
}

}  // namespace dreamsy::script
