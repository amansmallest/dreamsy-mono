// Small helpers for host functions.
#pragma once

#include <string>
#include <string_view>

#include "lua.h"

namespace dreamsy::script {

// Raises a Lua error with exactly `message` (no position prefix), like engine-web's host calls.
// Luau unwinds with a C++ exception, so destructors of the caller's locals run.
[[noreturn]] inline void raise(lua_State* L, std::string_view message) {
  lua_pushlstring(L, message.data(), message.size());
  lua_error(L);
}

inline std::string str_arg(lua_State* L, int i) {
  size_t len = 0;
  const char* s = lua_tolstring(L, i, &len);
  return s ? std::string(s, len) : std::string();
}

inline double num_arg(lua_State* L, int i) { return lua_tonumber(L, i); }
inline double num_arg_or(lua_State* L, int i, double fallback) { return lua_isnoneornil(L, i) ? fallback : lua_tonumber(L, i); }

inline void push_str(lua_State* L, std::string_view s) { lua_pushlstring(L, s.data(), s.size()); }

}  // namespace dreamsy::script
