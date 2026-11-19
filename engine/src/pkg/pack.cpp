// Dreamsy pack (.dpk) reader and writer. Format: docs/format.md §3.6.
//
//   header (80 bytes, little-endian)
//     0   magic        "DREAMSY" 0x1A
//     8   u32 version  1
//     12  u32 flags    0 (reserved)
//     16  u32 entry_count
//     20  u32 index_size (bytes)
//     24  u64 data_offset   = align16(80 + index_size)
//     32  u64 data_size
//     40  u8[32] index_sha256  (the package's content hash)
//     72  u8[8] reserved (0)
//   index, entry_count entries, paths strictly ascending (byte order):
//     u16 path_len, path bytes (normalized), u8 compression (0 = none), u8 reserved (0),
//     u64 offset (from data_offset, multiple of 16), u64 size, u8[32] sha256
//   zero padding to data_offset
//   data: each file at its offset, in index order, back to back with zero padding to 16 bytes
//
// The writer emits exactly one byte layout for a given set of files, and the reader accepts
// only that canonical layout, so a pack's bytes (and hash) are a pure function of its content.
#include <cstring>

#include "pkg/files.h"
#include "pkg/text.h"

namespace dreamsy::pkg {

namespace {

constexpr uint8_t kMagic[8] = {'D', 'R', 'E', 'A', 'M', 'S', 'Y', 0x1A};
constexpr uint32_t kVersion = 1;
constexpr size_t kHeaderSize = 80;
constexpr size_t kEntryFixedSize = 2 + 1 + 1 + 8 + 8 + 32;  // plus the path bytes
constexpr uint64_t kAlign = 16;

uint64_t align16(uint64_t n) { return (n + kAlign - 1) & ~(kAlign - 1); }

void put_u16(std::vector<uint8_t>& out, uint16_t v) {
  for (int i = 0; i < 2; ++i) out.push_back(static_cast<uint8_t>(v >> (8 * i)));
}
void put_u32(std::vector<uint8_t>& out, uint32_t v) {
  for (int i = 0; i < 4; ++i) out.push_back(static_cast<uint8_t>(v >> (8 * i)));
}
void put_u64(std::vector<uint8_t>& out, uint64_t v) {
  for (int i = 0; i < 8; ++i) out.push_back(static_cast<uint8_t>(v >> (8 * i)));
}

// Bounds-checked little-endian reader over an untrusted buffer.
class Reader {
 public:
  Reader(const uint8_t* p, size_t size) : p_(p), size_(size) {}
  bool ok() const { return ok_; }
  size_t pos() const { return pos_; }
  bool need(size_t n) {
    if (!ok_ || n > size_ - pos_) ok_ = false;
    return ok_;
  }
  uint64_t uint(int bytes) {
    if (!need(static_cast<size_t>(bytes))) return 0;
    uint64_t v = 0;
    for (int i = 0; i < bytes; ++i) v |= uint64_t{p_[pos_ + i]} << (8 * i);
    pos_ += static_cast<size_t>(bytes);
    return v;
  }
  const uint8_t* take(size_t n) {
    if (!need(n)) return nullptr;
    const uint8_t* out = p_ + pos_;
    pos_ += n;
    return out;
  }

 private:
  const uint8_t* p_;
  size_t size_;
  size_t pos_ = 0;
  bool ok_ = true;
};

}  // namespace

Files::Bytes Files::pack_index() const {
  Bytes index;
  uint64_t offset = 0;
  for (const auto& [path, entry] : files_) {
    put_u16(index, static_cast<uint16_t>(path.size()));
    index.insert(index.end(), path.begin(), path.end());
    index.push_back(0);  // compression: none
    index.push_back(0);  // reserved
    put_u64(index, offset);
    put_u64(index, entry.data.size());
    Sha256Digest h = Sha256::of(entry.data);
    index.insert(index.end(), h.begin(), h.end());
    offset = align16(offset + entry.data.size());
  }
  return index;
}

Sha256Digest Files::content_hash() const { return Sha256::of(pack_index()); }

Files::Bytes Files::to_pack() const {
  Bytes index = pack_index();
  Sha256Digest index_hash = Sha256::of(index);
  uint64_t data_offset = align16(kHeaderSize + index.size());
  uint64_t data_size = 0;
  for (const auto& [path, entry] : files_) data_size = align16(data_size + entry.data.size());

  Bytes out;
  out.reserve(static_cast<size_t>(data_offset + data_size));
  out.insert(out.end(), std::begin(kMagic), std::end(kMagic));
  put_u32(out, kVersion);
  put_u32(out, 0);
  put_u32(out, static_cast<uint32_t>(files_.size()));
  put_u32(out, static_cast<uint32_t>(index.size()));
  put_u64(out, data_offset);
  put_u64(out, data_size);
  out.insert(out.end(), index_hash.begin(), index_hash.end());
  out.resize(kHeaderSize, 0);
  out.insert(out.end(), index.begin(), index.end());
  out.resize(static_cast<size_t>(data_offset), 0);
  for (const auto& [path, entry] : files_) {
    out.insert(out.end(), entry.data.begin(), entry.data.end());
    out.resize(static_cast<size_t>(align16(out.size())), 0);
  }
  return out;
}

Result<Files> Files::from_pack(std::shared_ptr<const Bytes> pack, const Limits& limits, const PackOptions& options) {
  if (!pack) return Error{"no pack data"};
  const uint8_t* base = pack->data();
  const size_t size = pack->size();
  auto bad = [](const std::string& why) { return Error{"not a valid Dreamsy pack: " + why}; };

  Reader header(base, size);
  const uint8_t* magic = header.take(8);
  if (!magic || std::memcmp(magic, kMagic, 8) != 0) return bad("wrong magic bytes");
  uint64_t version = header.uint(4);
  uint64_t flags = header.uint(4);
  uint64_t count = header.uint(4);
  uint64_t index_size = header.uint(4);
  uint64_t data_offset = header.uint(8);
  uint64_t data_size = header.uint(8);
  const uint8_t* index_hash = header.take(32);
  const uint8_t* reserved = header.take(8);
  if (!header.ok()) return bad("truncated header");
  if (version != kVersion) return bad("unsupported version " + std::to_string(version) + " (this engine reads version 1)");
  if (flags != 0) return bad("unknown flags");
  for (int i = 0; i < 8; ++i)
    if (reserved[i] != 0) return bad("reserved header bytes are not zero");
  if (count > limits.max_files) return bad("more than " + std::to_string(limits.max_files) + " files");
  if (data_size > limits.max_total_bytes + count * kAlign) return bad("larger than " + std::to_string(limits.max_total_bytes) + " bytes");
  if (index_size > size - kHeaderSize || index_size < count * kEntryFixedSize) return bad("bad index size");
  if (data_offset != align16(kHeaderSize + index_size)) return bad("bad data offset");
  if (data_offset > size || data_size != size - data_offset) return bad("file size does not match the header");
  for (uint64_t i = kHeaderSize + index_size; i < data_offset; ++i)
    if (base[i] != 0) return bad("non-zero padding after the index");

  View index_bytes(base + kHeaderSize, static_cast<size_t>(index_size));
  Sha256Digest actual_index_hash = Sha256::of(index_bytes);
  if (std::memcmp(actual_index_hash.data(), index_hash, 32) != 0) return bad("index hash mismatch");

  Files files;
  Reader index(index_bytes.data(), index_bytes.size());
  std::string previous;
  uint64_t expected_offset = 0;
  for (uint64_t i = 0; i < count; ++i) {
    uint64_t path_len = index.uint(2);
    const uint8_t* path_bytes = index.take(static_cast<size_t>(path_len));
    uint64_t compression = index.uint(1);
    uint64_t entry_reserved = index.uint(1);
    uint64_t offset = index.uint(8);
    uint64_t file_size = index.uint(8);
    const uint8_t* hash = index.take(32);
    if (!index.ok()) return bad("truncated index");

    std::string path(reinterpret_cast<const char*>(path_bytes), static_cast<size_t>(path_len));
    auto norm = normalize_path(path);
    if (!norm || norm.value() != path) return bad("entry " + std::to_string(i) + " has a non-canonical path " + quote(path));
    if (i > 0 && !(previous < path)) return bad("paths are not strictly ascending at " + quote(path));
    if (compression != 0) return bad(path + " uses an unsupported compression (" + std::to_string(compression) + ")");
    if (entry_reserved != 0) return bad(path + " has non-zero reserved bytes");
    if (offset != expected_offset) return bad(path + " is not at its canonical offset");
    if (file_size > data_size || offset > data_size - file_size) return bad(path + " is out of bounds");

    const uint8_t* data = base + data_offset + offset;
    View view(data, static_cast<size_t>(file_size));
    for (uint64_t k = offset + file_size; k < align16(offset + file_size) && k < data_size; ++k) {
      if (base[data_offset + k] != 0) return bad("non-zero padding after " + path);
    }
    if (options.verify_hashes) {
      Sha256Digest h = Sha256::of(view);
      if (std::memcmp(h.data(), hash, 32) != 0) return bad(path + " is corrupt (hash mismatch)");
    }
    if (Status s = files.add_view(path, pack, view, limits); !s) return Error{s.error()};
    previous = std::move(path);
    expected_offset = align16(offset + file_size);
  }
  if (index.pos() != index_bytes.size()) return bad("extra bytes after the index");
  if (expected_offset != data_size) return bad("data size does not match the entries");
  return files;
}

}  // namespace dreamsy::pkg
