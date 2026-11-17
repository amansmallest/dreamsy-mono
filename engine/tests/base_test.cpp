#include <string>
#include <vector>

#include "base/arena.h"
#include "base/hash.h"
#include "base/log.h"
#include "base/pool.h"
#include "base/result.h"
#include "base/rng.h"
#include "doctest.h"

using namespace dreamsy;

namespace {

Result<int> parse_positive(int v) {
  if (v <= 0) return Error{"not positive: " + std::to_string(v)};
  return v;
}

}  // namespace

TEST_CASE("Result carries a value or an error") {
  auto ok = parse_positive(3);
  CHECK(ok.ok());
  CHECK(ok.value() == 3);
  CHECK(ok.error().empty());

  auto bad = parse_positive(-1);
  CHECK_FALSE(bad);
  CHECK(bad.error() == "not positive: -1");

  Status s = Status::success();
  CHECK(s.ok());
  Status f = Error{"nope"};
  CHECK_FALSE(f);
  CHECK(f.error() == "nope");
}

TEST_CASE("Pool: stale ids stop resolving") {
  Pool<std::string> pool;
  Id<std::string> a = pool.insert("a");
  Id<std::string> b = pool.insert("b");
  CHECK(pool.size() == 2);
  CHECK(*pool.get(a) == "a");

  CHECK(pool.remove(a));
  CHECK_FALSE(pool.remove(a));  // already gone
  CHECK(pool.get(a) == nullptr);
  CHECK(pool.size() == 1);

  // The slot is reused, but the old id must not see the new value.
  Id<std::string> c = pool.insert("c");
  CHECK(c.index == a.index);
  CHECK(c.generation != a.generation);
  CHECK(pool.get(a) == nullptr);
  CHECK(*pool.get(c) == "c");
  CHECK(*pool.get(b) == "b");

  CHECK(pool.get(Id<std::string>{}) == nullptr);       // null id
  CHECK(pool.get(Id<std::string>{99, 1}) == nullptr);  // out of range
}

TEST_CASE("Pool: for_each visits live values in slot order") {
  Pool<int> pool;
  auto x = pool.insert(10);
  pool.insert(20);
  pool.insert(30);
  pool.remove(x);
  std::vector<int> seen;
  pool.for_each([&](Id<int>, int& v) { seen.push_back(v); });
  CHECK(seen == std::vector<int>{20, 30});
  pool.clear();
  CHECK(pool.empty());
}

TEST_CASE("Arena: aligned allocation, growth and reset") {
  struct Vec2 {
    float x, y;
  };
  Arena arena(64);
  Vec2* v = arena.make<Vec2>(1.0f, 2.0f);
  CHECK(v->x == 1.0f);
  CHECK(reinterpret_cast<uintptr_t>(v) % alignof(Vec2) == 0);

  auto big = arena.make_array<double>(100);  // bigger than one block
  CHECK(big.size() == 100);
  CHECK(big[99] == 0.0);
  CHECK(reinterpret_cast<uintptr_t>(big.data()) % alignof(double) == 0);

  for (int i = 0; i < 1000; ++i) arena.alloc_bytes(7, 1);
  CHECK(arena.bytes_used() >= 7000);
  arena.reset();
  CHECK(arena.bytes_used() == 0);
}

TEST_CASE("Rng matches engine-web/core/random.ts bit for bit") {
  // Reference values printed by the TS engine: new Random(seed).next() * 2^32.
  struct Case {
    uint32_t seed;
    uint32_t expected[4];
  };
  const Case cases[] = {
      {0, {473542192u, 3964317691u, 2295682031u, 2113742504u}},
      {1, {4211584103u, 2815966088u, 4104533337u, 4205701635u}},
      {42, {2919031385u, 599058421u, 482214252u, 945587378u}},
      {0xdeadbeefu, {261278856u, 2499361443u, 2144830630u, 3028429420u}},
  };
  for (const Case& c : cases) {
    Rng rng(c.seed);
    for (uint32_t want : c.expected) CHECK(rng.next_u32() == want);
  }
  Rng a(7);
  double x = a.next();
  CHECK(x >= 0.0);
  CHECK(x < 1.0);
}

TEST_CASE("Hasher is stable and folds -0.0") {
  Hasher a;
  a.add(1.5f);
  a.str("dreamsy");
  Hasher b;
  b.add(1.5f);
  b.str("dreamsy");
  CHECK(a.value() == b.value());

  Hasher z1, z2;
  z1.add(0.0f);
  z2.add(-0.0f);
  CHECK(z1.value() == z2.value());

  Hasher empty;
  CHECK(empty.value() == 0xcbf29ce484222325ull);  // FNV-1a offset basis
}

TEST_CASE("log sink receives messages at or above the level") {
  std::vector<std::string> got;
  set_log_sink([](LogLevel, std::string_view m, void* user) {
    static_cast<std::vector<std::string>*>(user)->emplace_back(m);
  }, &got);
  set_log_level(LogLevel::Warn);
  log_info("hidden");
  log_warn("shown");
  log_error("also shown");
  set_log_sink(nullptr, nullptr);
  set_log_level(LogLevel::Info);
  CHECK(got == std::vector<std::string>{"shown", "also shown"});
}
