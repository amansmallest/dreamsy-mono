#include "dev/smoke.h"
#include "doctest.h"

using namespace dreamsy;

TEST_CASE("Luau compiles and runs sandboxed, print is captured") {
  auto out = dev::run_luau("print('hi', 1 + 2)\nprint(`x={2 * 21}`)");
  REQUIRE(out.ok());
  CHECK(out.value() == "hi\t3\nx=42\n");
}

TEST_CASE("Luau syntax and runtime errors come back as errors") {
  auto syntax = dev::run_luau("local = 1");
  CHECK_FALSE(syntax);
  CHECK(syntax.error().find("smoke") != std::string::npos);

  auto runtime = dev::run_luau("error('boom')");
  CHECK_FALSE(runtime);
  CHECK(runtime.error().find("boom") != std::string::npos);
}

TEST_CASE("Luau sandbox: the standard library is read-only") {
  auto out = dev::run_luau("string.upper = nil");
  CHECK_FALSE(out);
  auto io = dev::run_luau("assert(io == nil and os.execute == nil and loadstring == nil)");
  CHECK(io.ok());
}

TEST_CASE("Box2D simulation is deterministic") {
  uint64_t a = dev::physics_hash(1, 20, 300);
  uint64_t b = dev::physics_hash(1, 20, 300);
  CHECK(a == b);
  CHECK(dev::physics_hash(2, 20, 300) != a);  // seed changes the result
}

TEST_CASE("Box2D simulation gives the same hash on every platform") {
  // Golden value, recorded on macOS arm64 (debug and release) and WebAssembly; CI checks Linux x86-64.
  // If this changes, determinism broke (docs/engine.md §14.4) or Box2D was upgraded: find out which
  // before updating the value.
  CHECK(dev::physics_hash(1, 20, 300) == 0x8f2b7e35f5951775ull);
}
