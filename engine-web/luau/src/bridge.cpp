// Dreamsy web engine: thin C bridge between Luau (compiled to WASM) and JS.
//
// Design: JS drives the Lua stack through a small set of exported wrappers
// (dl_*). Every host function Luau can call goes through one C trampoline that
// calls `Module.hostCall(L)` in JS. JS never raises Lua errors itself: it
// pushes the message and returns -1, and the trampoline raises it from C, so no
// exception ever unwinds through a JS frame.
//
// Sandbox (lessons from the Godot spike): luaL_openlibs → trim to the contract
// → prelude installs platform globals → luaL_sandbox; each script runs in its
// own luaL_sandboxthread. CPU budget via the interrupt callback with a
// per-entry deadline that keeps firing once exceeded (pcall can't swallow it).
// Memory cap in the allocator. Budget error message is preallocated.

#include "lua.h"
#include "luacode.h"
#include "lualib.h"

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include <string>

EM_JS(int, js_host_call, (lua_State * L), { return Module.hostCall(L); });

namespace
{
size_t g_mem_used = 0;
size_t g_mem_limit = 64u * 1024 * 1024;
double g_budget_ms = 250.0;
double g_deadline = 0.0; // 0 = no call in progress
bool g_exceeded = false;
int g_interrupt_counter = 0;
int g_budget_msg_ref = LUA_NOREF;
int g_errhandler_ref = LUA_NOREF;
std::string g_traceback;
lua_State* g_main = nullptr;

void* dl_alloc(void* ud, void* ptr, size_t osize, size_t nsize)
{
    size_t old = ptr ? osize : 0;
    if (nsize == 0)
    {
        free(ptr);
        g_mem_used -= old;
        return nullptr;
    }
    if (nsize > old && g_mem_used - old + nsize > g_mem_limit)
        return nullptr; // Luau raises "not enough memory"
    void* block = realloc(ptr, nsize);
    if (block)
        g_mem_used = g_mem_used - old + nsize;
    return block;
}

void dl_interrupt(lua_State* L, int gc)
{
    if (gc >= 0 || g_deadline == 0.0)
        return;
    if (!g_exceeded)
    {
        // emscripten_get_now() is a JS import; only look at the clock every 256 safepoints.
        if (++g_interrupt_counter < 256)
            return;
        g_interrupt_counter = 0;
        if (emscripten_get_now() < g_deadline)
            return;
        g_exceeded = true;
    }
    lua_getref(L, g_budget_msg_ref);
    lua_error(L);
}

int host_trampoline(lua_State* L)
{
    int n = js_host_call(L);
    if (n < 0)
        lua_error(L); // JS pushed the message
    return n;
}

int error_handler(lua_State* L)
{
    if (!lua_isstring(L, 1))
    {
        luaL_tolstring(L, 1, nullptr);
        lua_replace(L, 1);
    }
    g_traceback = lua_debugtrace(L);
    lua_pushvalue(L, 1);
    return 1;
}

struct LoadArgs
{
    const char* chunkname;
    const char* bytecode;
    size_t size;
};

int load_protected(lua_State* L)
{
    LoadArgs* a = static_cast<LoadArgs*>(lua_touserdata(L, 1));
    if (luau_load(L, a->chunkname, a->bytecode, a->size, 0) != 0)
        lua_error(L);
    return 1;
}

int newthread_protected(lua_State* L)
{
    lua_State* T = lua_newthread(L);
    luaL_sandboxthread(T);
    return 1;
}
} // namespace

extern "C"
{

EMSCRIPTEN_KEEPALIVE lua_State* dl_init(double memLimitMB, double budgetMs)
{
    g_mem_limit = size_t(memLimitMB * 1024 * 1024);
    g_budget_ms = budgetMs;
    lua_State* L = lua_newstate(dl_alloc, nullptr);
    if (!L)
        return nullptr;
    g_main = L;
    lua_callbacks(L)->interrupt = dl_interrupt;

    luaL_openlibs(L);

    // Contract: no os except os.clock; no debug, getfenv/setfenv, loadstring.
    lua_getglobal(L, "os");
    lua_getfield(L, -1, "clock");
    lua_newtable(L);
    lua_insert(L, -2);
    lua_setfield(L, -2, "clock");
    lua_setglobal(L, "os");
    lua_pop(L, 1);
    static const char* const removed[] = {"loadstring"}; // debug/getfenv/setfenv are removed by the prelude after it captures debug.traceback
    for (const char* name : removed)
    {
        lua_pushnil(L);
        lua_setglobal(L, name);
    }

    lua_pushcfunction(L, host_trampoline, "host");
    lua_setglobal(L, "__host");

    lua_pushcfunction(L, error_handler, "error_handler");
    g_errhandler_ref = lua_ref(L, -1);
    lua_pop(L, 1);

    lua_pushfstring(L, "script exceeded its execution budget (%d ms)", int(budgetMs));
    g_budget_msg_ref = lua_ref(L, -1);
    lua_pop(L, 1);
    return L;
}

// Freeze globals + libraries. Call after the prelude has installed the platform API.
EMSCRIPTEN_KEEPALIVE void dl_sandbox(lua_State* L)
{
    luaL_sandbox(L);
}

EMSCRIPTEN_KEEPALIVE void dl_close(lua_State* L)
{
    lua_close(L);
    g_main = nullptr;
    g_mem_used = 0;
}

// Compile + load. Pushes the function (status 0) or the error message (status != 0).
EMSCRIPTEN_KEEPALIVE int dl_load(lua_State* L, const char* chunkname, const char* src, size_t len)
{
    // `game` has live properties (game.timeScale via __index): keep chains like `game.timeScale` out of the
    // import cache (GETIMPORT resolves `a.b` once at load under safeenv and would return a stale value).
    static const char* const mutableGlobals[] = {"game", nullptr};
    lua_CompileOptions opts = {};
    opts.optimizationLevel = 1;
    opts.mutableGlobals = mutableGlobals;
    opts.debugLevel = 1;
    size_t bcsize = 0;
    char* bc = luau_compile(src, len, &opts, &bcsize);
    LoadArgs args{chunkname, bc, bcsize};
    lua_pushcfunction(L, load_protected, "load");
    lua_pushlightuserdata(L, &args);
    int status = lua_pcall(L, 1, 1, 0);
    free(bc);
    return status;
}

// New sandboxed thread (own writable globals proxying the frozen _G); pushed on L.
EMSCRIPTEN_KEEPALIVE lua_State* dl_newthread(lua_State* L)
{
    lua_pushcfunction(L, newthread_protected, "newthread");
    if (lua_pcall(L, 0, 1, 0) != 0)
    {
        lua_pop(L, 1);
        return nullptr;
    }
    return lua_tothread(L, -1);
}

// Protected call with budget. Returns lua status; on error the message is on top and
// dl_traceback() has the stack trace. Nested calls never extend the outer deadline.
EMSCRIPTEN_KEEPALIVE int dl_pcall(lua_State* L, int nargs, int nresults)
{
    int fidx = lua_gettop(L) - nargs;
    lua_getref(L, g_errhandler_ref);
    lua_insert(L, fidx);

    double prev_deadline = g_deadline;
    bool prev_exceeded = g_exceeded;
    double deadline = emscripten_get_now() + g_budget_ms;
    if (prev_deadline != 0.0 && prev_deadline < deadline)
        deadline = prev_deadline;
    g_deadline = deadline;
    g_exceeded = false;
    g_interrupt_counter = 0;

    int status = lua_pcall(L, nargs, nresults, fidx);

    bool exceeded = g_exceeded;
    g_deadline = prev_deadline;
    g_exceeded = prev_exceeded || (exceeded && prev_deadline != 0.0);
    lua_remove(L, fidx); // handler
    if (status == LUA_ERRMEM && prev_deadline == 0.0 && g_main)
        lua_gc(g_main, LUA_GCCOLLECT, 0);
    return status;
}

EMSCRIPTEN_KEEPALIVE const char* dl_traceback() { return g_traceback.c_str(); }
EMSCRIPTEN_KEEPALIVE double dl_mem_used() { return double(g_mem_used); }

// ---- thin stack wrappers (many lua_* are macros) ----
EMSCRIPTEN_KEEPALIVE int dl_gettop(lua_State* L) { return lua_gettop(L); }
EMSCRIPTEN_KEEPALIVE void dl_settop(lua_State* L, int i) { lua_settop(L, i); }
EMSCRIPTEN_KEEPALIVE int dl_type(lua_State* L, int i) { return lua_type(L, i); }
EMSCRIPTEN_KEEPALIVE double dl_tonumber(lua_State* L, int i) { return lua_tonumber(L, i); }
EMSCRIPTEN_KEEPALIVE int dl_toboolean(lua_State* L, int i) { return lua_toboolean(L, i); }
EMSCRIPTEN_KEEPALIVE const char* dl_tolstring(lua_State* L, int i, size_t* len) { return lua_tolstring(L, i, len); }
// tostring() with metamethods; result is pushed.
EMSCRIPTEN_KEEPALIVE const char* dl_tostring_meta(lua_State* L, int i, size_t* len) { return luaL_tolstring(L, i, len); }
EMSCRIPTEN_KEEPALIVE void dl_pushnil(lua_State* L) { lua_pushnil(L); }
EMSCRIPTEN_KEEPALIVE void dl_pushnumber(lua_State* L, double n) { lua_pushnumber(L, n); }
EMSCRIPTEN_KEEPALIVE void dl_pushboolean(lua_State* L, int b) { lua_pushboolean(L, b); }
EMSCRIPTEN_KEEPALIVE void dl_pushlstring(lua_State* L, const char* s, size_t len) { lua_pushlstring(L, s, len); }
EMSCRIPTEN_KEEPALIVE void dl_pushvalue(lua_State* L, int i) { lua_pushvalue(L, i); }
EMSCRIPTEN_KEEPALIVE void dl_remove(lua_State* L, int i) { lua_remove(L, i); }
EMSCRIPTEN_KEEPALIVE void dl_insert(lua_State* L, int i) { lua_insert(L, i); }
EMSCRIPTEN_KEEPALIVE int dl_ref(lua_State* L, int i) { return lua_ref(L, i); }
EMSCRIPTEN_KEEPALIVE void dl_getref(lua_State* L, int ref) { lua_getref(L, ref); }
EMSCRIPTEN_KEEPALIVE void dl_unref(lua_State* L, int ref) { lua_unref(L, ref); }
EMSCRIPTEN_KEEPALIVE void dl_getglobal(lua_State* L, const char* k) { lua_getglobal(L, k); }
EMSCRIPTEN_KEEPALIVE void dl_setglobal(lua_State* L, const char* k) { lua_setglobal(L, k); }
EMSCRIPTEN_KEEPALIVE void dl_rawgetfield(lua_State* L, int i, const char* k) { lua_rawgetfield(L, i, k); }
EMSCRIPTEN_KEEPALIVE void dl_rawsetfield(lua_State* L, int i, const char* k) { lua_rawsetfield(L, i, k); }
EMSCRIPTEN_KEEPALIVE void dl_rawgeti(lua_State* L, int i, int n) { lua_rawgeti(L, i, n); }
EMSCRIPTEN_KEEPALIVE void dl_rawseti(lua_State* L, int i, int n) { lua_rawseti(L, i, n); }
EMSCRIPTEN_KEEPALIVE void dl_createtable(lua_State* L, int narr, int nrec) { lua_createtable(L, narr, nrec); }
EMSCRIPTEN_KEEPALIVE int dl_objlen(lua_State* L, int i) { return lua_objlen(L, i); }
// Iterate a table: pushes key,value; returns 0 at the end. Caller pushes nil first.
EMSCRIPTEN_KEEPALIVE int dl_next(lua_State* L, int i) { return lua_next(L, i); }
EMSCRIPTEN_KEEPALIVE void dl_xmove(lua_State* from, lua_State* to, int n) { lua_xmove(from, to, n); }
}
