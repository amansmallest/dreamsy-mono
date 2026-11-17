// Deterministic math (DREAMSY.MD §14.4): the engine links musl's libm (third_party/musl-libm) into every
// executable, so these must hold bit for bit on macOS arm64, Linux x86-64 and WebAssembly (CI runs all three).
// The golden bits come from musl 1.2.5 compiled with the engine's flags; engine-web (Emscripten's musl)
// produces the same values (tests/scripts/math via tests/conformance/run_compare.py).
#include <cmath>
#include <cstdint>
#include <cstring>

#include "doctest.h"

namespace {

uint64_t bits(double d) {
  uint64_t u;
  std::memcpy(&u, &d, sizeof u);
  return u;
}

// Function pointers through a volatile load so the compiler can't constant-fold the calls.
template <typename F>
F opaque(F f) {
  F volatile v = f;
  return v;
}

struct Golden {
  double x;
  uint64_t sin, cos, tan, exp, log_abs, pow_1_1;
};

const Golden kGolden[] = {
  {0.10000000000000001, 0x3fb98eaecb8bcb2cull, 0x3fefd712f9a817c1ull, 0x3fb9af8877430b80ull, 0x3ff1aec7b35a00d4ull, 0xc0026bb1bbb55515ull, 0x3ff02739c65d58bfull},
  {0.5, 0x3fdeaee8744b05f0ull, 0x3fec1528065b7d50ull, 0x3fe17b4f5bf3474aull, 0x3ffa61298e1e069cull, 0xbfe62e42fefa39efull, 0x3ff0c7ebc96a56f6ull},
  {1.5, 0x3fefeb7a9b2c6d8bull, 0x3fb21bd54fc5f9a7ull, 0x402c33ed50b88777ull, 0x4011ed3fe64fc541ull, 0x3fd9f323ecbf984cull, 0x3ff275835d8e92dcull},
  {3.1415899999999999, 0x3ec6428a6aa44cd0ull, 0xbfefffffffff8420ull, 0xbec6428a6aa4a2fcull, 0x4037240068789162ull, 0x3ff250cf662abf9aull, 0x3ff595d8a117a8ebull},
  {10.699999999999999, 0xbfee9cc109a2d825ull, 0xbfd2a47bccaac8dcull, 0x400a45eb9d547209ull, 0x40e5a87b5d3a36e1ull, 0x4002f64259c939a1ull, 0x40062e797bf21156ull},
  {100.3, 0xbfcd4d2653b399ceull, 0x3fef267825ddb65full, 0xbfce19c4dc91a5c3ull, 0x48fa08a5754ae034ull, 0x40126ec2fce9beabull, 0x40cbb22a2bf158c8ull},
  {100000.37, 0xbfd4fed92cb1d92full, 0xbfee3aa4efb72f3aull, 0x3fd639b99770e5baull, 0x7ff0000000000000ull, 0x4027069ea6c95d59ull, 0x7ff0000000000000ull},
  {-0.72999999999999998, 0xbfe556fefd2129b1ull, 0x3fe7d877fcfc66edull, 0xbfeca32a16174aeeull, 0x3fded798ce057ddfull, 0xbfd42438893252f5ull, 0x3fedd967f952328aull},
  {0.999, 0x3feae8e6949c824cull, 0x3fe1510c2fe3fda7ull, 0x3ff8dd2207973bcaull, 0x4005b97a17d41193ull, 0xbf5064670d979b73ull, 0x3ff1992babd8aca2ull},
  {9.9999999999999995e-08, 0x3e7ad7f29abcaf3bull, 0x3fefffffffffffd3ull, 0x3e7ad7f29abcaf61ull, 0x3ff000001ad7f2b1ull, 0xc0301e3b843eaa73ull, 0x3ff00000028ef771ull},
};

}  // namespace

TEST_CASE("libm is musl's: bit-identical results on every platform") {
  auto sin_ = opaque<double (*)(double)>(&::sin), cos_ = opaque<double (*)(double)>(&::cos);
  auto tan_ = opaque<double (*)(double)>(&::tan), exp_ = opaque<double (*)(double)>(&::exp);
  auto log_ = opaque<double (*)(double)>(&::log);
  auto pow_ = opaque<double (*)(double, double)>(&::pow);
  for (const Golden& g : kGolden) {
    CAPTURE(g.x);
    CHECK(bits(sin_(g.x)) == g.sin);
    CHECK(bits(cos_(g.x)) == g.cos);
    CHECK(bits(tan_(g.x)) == g.tan);
    CHECK(bits(exp_(g.x)) == g.exp);
    CHECK(bits(log_(std::fabs(g.x))) == g.log_abs);
    CHECK(bits(pow_(1.1, g.x)) == g.pow_1_1);
  }
}
