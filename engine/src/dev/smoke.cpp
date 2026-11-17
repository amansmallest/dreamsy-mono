#include "dev/smoke.h"

#include <memory>
#include <vector>

#include "base/hash.h"
#include "base/rng.h"
#include "box2d/box2d.h"
#include "lua.h"
#include "luacode.h"
#include "lualib.h"

namespace dreamsy::dev {

namespace {

struct LuaStateDeleter {
  void operator()(lua_State* L) const { lua_close(L); }
};
using LuaStatePtr = std::unique_ptr<lua_State, LuaStateDeleter>;

// print(...) -> appends "a\tb\tc\n" to the std::string stored as the thread's data.
int lua_print(lua_State* L) {
  auto* out = static_cast<std::string*>(lua_getthreaddata(L));
  int n = lua_gettop(L);
  for (int i = 1; i <= n; ++i) {
    size_t len = 0;
    const char* s = luaL_tolstring(L, i, &len);  // pushes the string
    if (i > 1) out->push_back('\t');
    out->append(s, len);
    lua_pop(L, 1);
  }
  out->push_back('\n');
  return 0;
}

}  // namespace

Result<std::string> run_luau(std::string_view source) {
  LuaStatePtr state(luaL_newstate());
  lua_State* L = state.get();
  std::string output;
  lua_setthreaddata(L, &output);

  luaL_openlibs(L);
  lua_pushcfunction(L, lua_print, "print");
  lua_setglobal(L, "print");
  luaL_sandbox(L);  // freezes the standard library; scripts get a writable global table of their own
  luaL_sandboxthread(L);

  size_t bytecode_size = 0;
  std::unique_ptr<char, decltype(&free)> bytecode(
      luau_compile(source.data(), source.size(), nullptr, &bytecode_size), &free);
  if (luau_load(L, "=smoke", bytecode.get(), bytecode_size, 0) != 0) {
    return Error{lua_tostring(L, -1)};
  }
  if (lua_pcall(L, 0, 0, 0) != LUA_OK) {
    return Error{lua_tostring(L, -1)};
  }
  return output;
}

uint64_t physics_hash(uint32_t seed, int bodies, int steps) {
  b2WorldDef world_def = b2DefaultWorldDef();
  world_def.gravity = b2Vec2{0.0f, -10.0f};
  b2WorldId world = b2CreateWorld(&world_def);

  b2BodyDef ground_def = b2DefaultBodyDef();
  b2BodyId ground = b2CreateBody(world, &ground_def);
  b2Polygon ground_box = b2MakeBox(50.0f, 1.0f);
  b2ShapeDef ground_shape = b2DefaultShapeDef();
  b2CreatePolygonShape(ground, &ground_shape, &ground_box);

  Rng rng(seed);
  std::vector<b2BodyId> boxes;
  boxes.reserve(static_cast<size_t>(bodies));
  for (int i = 0; i < bodies; ++i) {
    b2BodyDef def = b2DefaultBodyDef();
    def.type = b2_dynamicBody;
    def.position = b2Vec2{static_cast<float>(rng.next() * 10.0 - 5.0), 2.0f + 1.2f * static_cast<float>(i)};
    b2BodyId body = b2CreateBody(world, &def);
    b2Polygon box = b2MakeBox(0.5f, 0.5f);
    b2ShapeDef shape = b2DefaultShapeDef();
    b2CreatePolygonShape(body, &shape, &box);
    boxes.push_back(body);
  }

  for (int i = 0; i < steps; ++i) b2World_Step(world, 1.0f / 60.0f, 4);

  Hasher hash;
  for (b2BodyId body : boxes) {
    b2Vec2 p = b2Body_GetPosition(body);
    b2Rot r = b2Body_GetRotation(body);
    hash.add(p.x);
    hash.add(p.y);
    hash.add(r.c);
    hash.add(r.s);
  }
  b2DestroyWorld(world);
  return hash.value();
}

}  // namespace dreamsy::dev
