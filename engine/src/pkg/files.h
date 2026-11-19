// The raw files of a game package: normalized path -> bytes.
//
// Sources:
//   - a Dreamsy pack (.dpk, docs/format.md §3.6): the transport and runtime format; read in place,
//     every file is a view into the one pack buffer (no copies)
//   - a directory (authoring, tools)
//   - an in-memory map (tests)
// Zip archives are not read by the engine; `dreamsy-tool pack` converts them (pkg/zip_import.h).
//
// Packages are untrusted (AI- and user-generated), so every source enforces limits before
// allocating, and the pack reader checks every offset, size, path and hash.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "base/result.h"
#include "base/sha256.h"

namespace dreamsy::pkg {

struct Limits {
  uint64_t max_total_bytes = 200ull * 1024 * 1024;  // format/src/validate.ts MAX_PACKAGE_BYTES
  uint64_t max_file_bytes = 64ull * 1024 * 1024;
  uint32_t max_files = 20000;
  uint32_t max_path_bytes = 1024;
};

// Matches format/src/package.ts normalizePath: "\" becomes "/", empty and "." segments are
// dropped, ".." is rejected (it would escape the package), and an empty result is an error.
Result<std::string> normalize_path(std::string_view path);

struct PackOptions {
  bool verify_hashes = true;  // check every file's SHA-256 (skip only for trusted local caches)
};

class Files {
 public:
  using Bytes = std::vector<uint8_t>;
  using View = std::span<const uint8_t>;

  // A Dreamsy pack. Files are views into `pack`, which the Files object keeps alive.
  static Result<Files> from_pack(std::shared_ptr<const Bytes> pack, const Limits& limits = {},
                                 const PackOptions& options = {});
  // A directory on disk. Symlinks are not followed; .DS_Store is skipped.
  static Result<Files> from_dir(const std::string& dir, const Limits& limits = {});
  // In-memory files (tests, tools). Paths are normalized; the last duplicate wins.
  static Result<Files> from_map(const std::map<std::string, std::string>& files, const Limits& limits = {});

  // Serializes to a canonical Dreamsy pack: the same files always give the same bytes.
  Bytes to_pack() const;
  // The package's identity: SHA-256 of its pack index (which holds every file's hash).
  Sha256Digest content_hash() const;

  // `path` is normalized first, so "scripts/client//a.luau" finds "scripts/client/a.luau".
  bool has(std::string_view path) const;
  std::optional<View> bytes(std::string_view path) const;
  std::optional<std::string_view> text(std::string_view path) const;

  // Sorted paths that start with `prefix` (byte order; same as the TS engine for ASCII paths).
  std::vector<std::string> paths(std::string_view prefix = "") const;

  uint64_t total_bytes() const { return total_bytes_; }
  size_t count() const { return files_.size(); }

  // Building (importers): adds a file under an already-normalized path, enforcing `limits`.
  Status add(std::string path, Bytes data, const Limits& limits);
  // Drops a single top-level folder that wraps the whole package (zips made from a folder).
  void strip_single_top_folder();

 private:
  struct Entry {
    std::shared_ptr<const Bytes> owner;  // keeps the memory alive (shared by all files of a pack)
    View data;
  };
  Status add_view(std::string path, std::shared_ptr<const Bytes> owner, View data, const Limits& limits);
  Bytes pack_index() const;

  std::map<std::string, Entry, std::less<>> files_;
  uint64_t total_bytes_ = 0;
};

}  // namespace dreamsy::pkg
