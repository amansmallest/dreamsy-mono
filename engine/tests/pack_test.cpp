// Files, Dreamsy packs, SHA-256 and the zip importer.
#include <cstring>
#include <memory>
#include <string>

#include "base/sha256.h"
#include "doctest.h"
#include "miniz.h"
#include "pkg/files.h"
#include "pkg/zip_import.h"

using namespace dreamsy;
using namespace dreamsy::pkg;

namespace {

std::span<const uint8_t> as_bytes(std::string_view s) { return {reinterpret_cast<const uint8_t*>(s.data()), s.size()}; }

Files sample() {
  return Files::from_map({{"dreamsy.toml", "format = \"0\"\n"},
                          {"scripts/client/a.luau", "print(1)"},
                          {"assets/x.png", std::string("\x89PNG\0\1\2", 7)},
                          {"data/empty.txt", ""}})
      .value();
}

std::shared_ptr<const Files::Bytes> share(Files::Bytes b) { return std::make_shared<const Files::Bytes>(std::move(b)); }

}  // namespace

TEST_CASE("SHA-256 test vectors (FIPS 180-4)") {
  CHECK(to_hex(Sha256::of(as_bytes(""))) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  CHECK(to_hex(Sha256::of(as_bytes("abc"))) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  CHECK(to_hex(Sha256::of(as_bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))) ==
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  // Streaming in odd-sized pieces gives the same digest as one call.
  std::string million(1000000, 'a');
  Sha256 h;
  for (size_t i = 0; i < million.size(); i += 777) h.update(as_bytes(std::string_view(million).substr(i, 777)));
  CHECK(to_hex(h.finish()) == "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

TEST_CASE("normalize_path matches format/src/package.ts") {
  CHECK(normalize_path("a/b").value() == "a/b");
  CHECK(normalize_path("./a//b/").value() == "a/b");
  CHECK(normalize_path("a\\b\\c").value() == "a/b/c");
  CHECK_FALSE(normalize_path("a/../b"));
  CHECK_FALSE(normalize_path(""));
  CHECK_FALSE(normalize_path("./"));
}

TEST_CASE("Files: lookup normalizes, paths are sorted by prefix") {
  Files f = sample();
  CHECK(f.has("scripts/client//a.luau"));
  CHECK(f.text("./dreamsy.toml").value() == "format = \"0\"\n");
  CHECK_FALSE(f.has("../dreamsy.toml"));
  CHECK(f.paths() == std::vector<std::string>{"assets/x.png", "data/empty.txt", "dreamsy.toml", "scripts/client/a.luau"});
  CHECK(f.paths("scripts/") == std::vector<std::string>{"scripts/client/a.luau"});
  CHECK(f.total_bytes() == 13 + 8 + 7);
}

TEST_CASE("Files: limits are enforced") {
  Limits small;
  small.max_files = 2;
  CHECK_FALSE(Files::from_map({{"a", "1"}, {"b", "2"}, {"c", "3"}}, small));
  small = {};
  small.max_total_bytes = 4;
  CHECK_FALSE(Files::from_map({{"a", "123"}, {"b", "45"}}, small));
  small = {};
  small.max_file_bytes = 2;
  CHECK_FALSE(Files::from_map({{"a", "123"}}, small));
}

TEST_CASE("pack: round trip, canonical bytes, content hash") {
  Files f = sample();
  Files::Bytes packed = f.to_pack();
  CHECK(packed.size() % 16 == 0);
  CHECK(std::memcmp(packed.data(), "DREAMSY\x1A", 8) == 0);

  auto back = Files::from_pack(share(packed));
  REQUIRE(back.ok());
  CHECK(back.value().paths() == f.paths());
  for (const std::string& p : f.paths()) {
    auto a = f.bytes(p).value(), b = back.value().bytes(p).value();
    CHECK(std::equal(a.begin(), a.end(), b.begin(), b.end()));
  }
  // Same content -> same bytes and hash, regardless of insertion order.
  Files g = Files::from_map({{"data/empty.txt", ""},
                             {"assets/x.png", std::string("\x89PNG\0\1\2", 7)},
                             {"scripts/client/a.luau", "print(1)"},
                             {"dreamsy.toml", "format = \"0\"\n"}})
                .value();
  CHECK(g.to_pack() == packed);
  CHECK(g.content_hash() == f.content_hash());
  CHECK(back.value().to_pack() == packed);
  // Different content -> different hash.
  Files h = Files::from_map({{"dreamsy.toml", "format = \"1\"\n"}}).value();
  CHECK(h.content_hash() != f.content_hash());
}

TEST_CASE("pack: views point into the pack buffer (no copies)") {
  auto packed = share(sample().to_pack());
  auto f = Files::from_pack(packed);
  REQUIRE(f.ok());
  auto view = f.value().bytes("dreamsy.toml").value();
  CHECK(view.data() >= packed->data());
  CHECK(view.data() + view.size() <= packed->data() + packed->size());
  CHECK((view.data() - packed->data()) % 16 == 0);
}

TEST_CASE("pack: empty package") {
  Files empty = Files::from_map({}).value();
  auto back = Files::from_pack(share(empty.to_pack()));
  REQUIRE(back.ok());
  CHECK(back.value().count() == 0);
}

TEST_CASE("pack: every single-byte corruption is rejected") {
  const Files::Bytes packed = sample().to_pack();
  // Flipping any bit anywhere must fail: header fields, index (hash covers it), padding
  // (must be zero) and data (per-file SHA-256).
  for (size_t i = 0; i < packed.size(); ++i) {
    Files::Bytes bad = packed;
    bad[i] ^= 0x01;
    auto r = Files::from_pack(share(bad));
    if (r.ok()) FAIL("byte " << i << " corrupted but accepted");
  }
}

TEST_CASE("pack: truncation, extra bytes and wrong versions are rejected") {
  const Files::Bytes packed = sample().to_pack();
  for (size_t n : {size_t{0}, size_t{7}, size_t{79}, size_t{80}, packed.size() - 16, packed.size() - 1}) {
    CHECK_FALSE(Files::from_pack(share(Files::Bytes(packed.begin(), packed.begin() + static_cast<long>(n)))));
  }
  Files::Bytes longer = packed;
  longer.resize(longer.size() + 16, 0);
  CHECK_FALSE(Files::from_pack(share(longer)));
  Files::Bytes v2 = packed;
  v2[8] = 2;
  auto r = Files::from_pack(share(v2));
  REQUIRE_FALSE(r);
  CHECK(r.error().find("unsupported version 2") != std::string::npos);
  CHECK_FALSE(Files::from_pack(nullptr));
}

TEST_CASE("pack: hash verification can be skipped for trusted caches") {
  Files::Bytes packed = sample().to_pack();
  packed.back() ^= 0;  // unchanged; find a data byte to flip
  // The last file's last byte (before padding) is data; flip a byte inside "scripts/client/a.luau".
  std::string needle = "print(1)";
  auto it = std::search(packed.begin(), packed.end(), needle.begin(), needle.end());
  REQUIRE(it != packed.end());
  *it = 'P';
  CHECK_FALSE(Files::from_pack(share(packed)));
  PackOptions trusted;
  trusted.verify_hashes = false;
  auto r = Files::from_pack(share(packed), {}, trusted);
  REQUIRE(r.ok());
  CHECK(r.value().text("scripts/client/a.luau").value() == "Print(1)");
}

namespace {

Files::Bytes make_zip(const std::vector<std::pair<std::string, std::string>>& entries) {
  mz_zip_archive zip{};
  REQUIRE(mz_zip_writer_init_heap(&zip, 0, 0));
  for (const auto& [name, data] : entries) {
    REQUIRE(mz_zip_writer_add_mem(&zip, name.c_str(), data.data(), data.size(), MZ_DEFAULT_COMPRESSION));
  }
  void* buf = nullptr;
  size_t size = 0;
  REQUIRE(mz_zip_writer_finalize_heap_archive(&zip, &buf, &size));
  Files::Bytes out(static_cast<uint8_t*>(buf), static_cast<uint8_t*>(buf) + size);
  mz_zip_writer_end(&zip);
  return out;
}

}  // namespace

TEST_CASE("zip import: files, top-folder stripping, junk skipped") {
  auto zip = make_zip({{"game/dreamsy.toml", "x"}, {"game/scenes/a.scene.json", "{}"}, {"__MACOSX/game/._x", "junk"},
                       {"game/.DS_Store", "junk"}});
  auto f = import_zip(zip);
  REQUIRE(f.ok());
  CHECK(f.value().paths() == std::vector<std::string>{"dreamsy.toml", "scenes/a.scene.json"});
}

TEST_CASE("zip import: rejects escapes, bombs and garbage") {
  CHECK_FALSE(import_zip(make_zip({{"../evil", "x"}})));
  CHECK_FALSE(import_zip(as_bytes("not a zip at all")));
  // 10 MB of zeros compresses to ~10 KB; a 1 MB file limit must reject it before inflating.
  auto bomb = make_zip({{"big.bin", std::string(10 * 1024 * 1024, '\0')}});
  CHECK(bomb.size() < 100 * 1024);
  Limits limits;
  limits.max_file_bytes = 1024 * 1024;
  auto r = import_zip(bomb, limits);
  REQUIRE_FALSE(r);
  CHECK(r.error().find("big.bin") != std::string::npos);
}
