# C++ for TypeScript and Python developers

A primer for reading and changing the Dreamsy engine (`engine/`). It covers only the C++ we use,
and every example is from our code. Ask Claude to go deeper on any section.

## 1. Files: headers and sources

C++ splits a module into two files:

- `arena.h` (the **header**) declares what exists: types, function signatures. Other files
  `#include` it, like `import` in TS.
- `arena.cpp` (the **source**) defines how it works. It is compiled once.

`#pragma once` at the top of a header stops it being included twice. Small functions and templates
live entirely in the header (`pool.h`, `rng.h`).

```cpp
#include <vector>        // standard library: angle brackets
#include "base/pool.h"   // our code: quotes, relative to engine/src
```

`namespace dreamsy { ... }` groups names, like a TS module. `dreamsy::Rng` is the full name;
inside the namespace it's just `Rng`.

## 2. Types are fixed and sized

| TS / Python | C++ | Notes |
|---|---|---|
| `number` (int) | `int`, `int64_t`, `uint32_t` | pick the size; `u` = unsigned (no negatives) |
| `number` (float) | `float` (32-bit), `double` (64-bit) | physics uses `float` |
| `boolean` | `bool` | |
| `string` | `std::string` (owns text), `std::string_view` (borrows it) | |
| `T[]` / `list` | `std::vector<T>` | growable array |
| `Map` / `dict` | `std::unordered_map<K, V>` | |
| `T \| undefined` / `Optional[T]` | `std::optional<T>` | |
| `Uint8Array` slice | `std::span<T>` | a view into someone else's array |

`auto` lets the compiler infer the type, like TS inference: `auto out = dev::run_luau(src);`.

Gotcha: `long` is 64-bit on macOS but 32-bit in WebAssembly. Use `int64_t` when the size matters
(we hit exactly this bug in `apps/tool/main.cpp`).

## 3. Structs and functions (no class hierarchies)

```cpp
struct Vec2 {
  float x = 0;
  float y = 0;
};

float length(Vec2 v) { return std::sqrt(v.x * v.x + v.y * v.y); }
```

A `struct` is a TS interface with storage. `class` is the same thing with members private by default;
we use it when a type protects invariants (`Pool`, `Arena`), with `public:` and `private:` sections.
Private members end in `_` (`slots_`, `count_`).

`const` on a method (`size_t size() const`) promises it doesn't modify the object, like `readonly`.

## 4. Values, references, pointers

This is the big difference from TS/Python, where objects are always shared references.

```cpp
Vec2 a{1, 2};
Vec2 b = a;      // COPY: b is a separate Vec2; changing b leaves a alone
Vec2& r = a;     // REFERENCE: r is another name for a; changing r changes a
Vec2* p = &a;    // POINTER: holds a's address; may be nullptr; use p->x
```

Function parameters follow the same rules:

```cpp
void f(Vec2 v);          // gets a copy (fine for small types)
void g(const Vec2& v);   // borrows, read-only (large types: no copy)
void h(Vec2& v);         // borrows, may modify the caller's value
```

A reference or pointer must not outlive what it points at. That's why the engine stores `Id<T>`
handles instead of pointers (section 7).

## 5. Memory: who owns what

C++ has no garbage collector. Every object has exactly one **owner**, and it's destroyed when its
owner goes away. Most of the time this is automatic:

```cpp
{
  std::vector<int> v = {1, 2, 3};   // v owns its heap memory
}                                   // v's destructor frees it here
```

That pattern is **RAII**: acquire in the constructor, release in the destructor. It's like Python's
`with` or Go's `defer`, but attached to the object. In `src/dev/smoke.cpp`:

```cpp
using LuaStatePtr = std::unique_ptr<lua_State, LuaStateDeleter>;
LuaStatePtr state(luaL_newstate());   // lua_close() runs on every return path, even on errors
```

`std::unique_ptr<T>` is a single owner of a heap object. `std::move(x)` hands ownership over and
leaves `x` empty. We never write raw `new`/`delete`.

## 6. Errors are values

The engine never throws. A function that can fail returns `Result<T>` or `Status`
(`src/base/result.h`), like Go's `(value, err)` or a TS `{ok, value} | {ok: false, error}` union:

```cpp
Result<std::string> run_luau(std::string_view source);

auto out = run_luau("print(1)");
if (!out) { log_error(out.error()); return; }
std::string text = out.value();
```

`[[nodiscard]]` on `Result` makes the compiler warn if you ignore one.

For bugs (not expected failures) we use `DREAMSY_CHECK(cond, "msg")`. It aborts with a clear
message instead of letting memory get corrupted.

## 7. Templates and handles

Templates are generics: `Pool<T>` is like `class Pool<T>` in TS. The compiler stamps out a
separate copy for each `T` you use.

`Pool<T>` (`src/base/pool.h`) is how the engine stores objects:

```cpp
Pool<Sprite> sprites;
Id<Sprite> id = sprites.insert(Sprite{...});
if (Sprite* s = sprites.get(id)) s->x += 1;   // nullptr if the sprite was removed
```

An `Id` is an index plus a generation. Removing an object bumps the generation, so old ids stop
resolving. A dangling pointer would read freed memory; a stale id safely gives `nullptr`.

## 8. Lambdas

```cpp
pool.for_each([&](Id<int> id, int& value) { total += value; });
```

`[&]` captures surrounding variables by reference (`total` here); `[=]` captures copies. Otherwise
it's an arrow function.

## 9. Building

There's no interpreter; code is compiled to machine code (or WebAssembly) first. CMake describes the
build (`engine/CMakeLists.txt`), Ninja runs it, presets name the configurations:

```sh
cmake --preset debug          # configure once (like npm install)
cmake --build --preset debug  # compile what changed
ctest --preset debug          # run tests
```

The `debug` preset turns on **sanitizers**. AddressSanitizer catches memory bugs (use after free,
out-of-bounds) and UndefinedBehaviorSanitizer catches things like integer overflow, both at runtime
with a stack trace. If a test passes in debug, those bug classes didn't happen.

## 10. Talking to C libraries (Box2D, Luau)

Box2D and Luau are C APIs: plain functions and structs, no classes. Two patterns show up in
`src/physics/physics2d.cpp`:

```cpp
b2BodyDef bd = b2DefaultBodyDef();   // C "options object": start from defaults, set fields
bd.type = b2_dynamicBody;
b2BodyId body = b2CreateBody(world, &bd);   // the library returns a handle, like our Id<T>
```

**Callbacks with a context pointer.** C has no closures, so a callback is a plain function plus a
`void*` the library hands back to you. We pass `this` and cast it back, which is what a TS arrow
function capturing `this` does for you:

```cpp
b2World_SetPreSolveCallback(world, &Physics2D::pre_solve, &Physics2D::pre_continuous, this);

void Physics2D::pre_solve(b2ShapeId a, b2ShapeId b, b2Manifold* m, void* context) {
  auto* self = static_cast<Physics2D*>(context);   // `this` again
  ...
}
```

A capture-free lambda converts to a plain function pointer, so short callbacks can be written inline
(`b2World_OverlapAABB(..., [](b2ShapeId s, void* ctx) { ... }, &query)` in `update_areas`).

**Errors inside Lua host ops.** Engine functions return `Status`/`Result` (section 6). Only at the
boundary, where a script called us, does a failed `Status` become a Lua error
(`raise(L, s.error())` in `src/script/host_world.cpp`), with exactly the message engine-web gives.

## 11. Reading order for the engine

1. `src/base/result.h`, `src/base/pool.h`: the two patterns used everywhere.
2. `src/base/rng.h`: a tiny class, compare it with `engine-web/core/random.ts`.
3. `src/dev/smoke.cpp`: calling C libraries (Luau, Box2D) from C++.
4. `src/world/world.h`: entities in a `Pool`, props, the scene tree; compare with `engine-web/core/world.ts`.
5. `src/physics/physics2d.h`: Box2D behind a small API, and how 2.5D height works.
6. `src/script/host_world.cpp`: how a script's `e.position = v` reaches the world.
7. `apps/player/main.cpp`: the frame loop; `src/render/draw_list.h` then `src/render/renderer.h` for drawing.
8. `tests/base_test.cpp`, `tests/world_test.cpp`: how each piece is meant to be used.
