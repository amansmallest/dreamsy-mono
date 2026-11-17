#include "pkg/zip_import.h"

#include <cstring>
#include <string>

#include "miniz.h"

namespace dreamsy::pkg {

namespace {

// miniz's own memory reader (mz_zip_reader_init_mem) computes `base + offset` before checking
// the offset, which is undefined behavior for the corrupt offsets a hostile zip contains (found
// by engine/fuzz). This reader checks bounds first and does no out-of-range pointer arithmetic.
size_t read_span(void* opaque, mz_uint64 offset, void* out, size_t n) {
  auto* data = static_cast<std::span<const uint8_t>*>(opaque);
  if (offset >= data->size()) return 0;
  size_t available = data->size() - static_cast<size_t>(offset);
  size_t count = n < available ? n : available;
  std::memcpy(out, data->data() + offset, count);
  return count;
}

}  // namespace

Result<Files> import_zip(std::span<const uint8_t> zip, const Limits& limits) {
  mz_zip_archive archive{};
  archive.m_pRead = read_span;
  archive.m_pIO_opaque = &zip;
  if (!mz_zip_reader_init(&archive, zip.size(), 0)) {
    return Error{std::string("not a valid zip: ") + mz_zip_get_error_string(mz_zip_get_last_error(&archive))};
  }
  struct Closer {
    mz_zip_archive* a;
    ~Closer() { mz_zip_reader_end(a); }
  } closer{&archive};

  const mz_uint count = mz_zip_reader_get_num_files(&archive);
  if (count > limits.max_files) return Error{"zip has more than " + std::to_string(limits.max_files) + " entries"};

  // Check every declared size before decompressing anything.
  uint64_t declared_total = 0;
  for (mz_uint i = 0; i < count; ++i) {
    mz_zip_archive_file_stat st;
    if (!mz_zip_reader_file_stat(&archive, i, &st)) return Error{"zip entry " + std::to_string(i) + " is unreadable"};
    if (st.m_is_directory) continue;
    if (st.m_is_encrypted) return Error{std::string("zip entry ") + st.m_filename + " is encrypted"};
    if (!st.m_is_supported) return Error{std::string("zip entry ") + st.m_filename + " uses an unsupported compression"};
    if (st.m_uncomp_size > limits.max_file_bytes) {
      return Error{std::string(st.m_filename) + " is " + std::to_string(st.m_uncomp_size) + " bytes; max " +
                   std::to_string(limits.max_file_bytes)};
    }
    declared_total += st.m_uncomp_size;
    if (declared_total > limits.max_total_bytes) {
      return Error{"package is larger than " + std::to_string(limits.max_total_bytes) + " bytes"};
    }
  }

  Files files;
  for (mz_uint i = 0; i < count; ++i) {
    mz_zip_archive_file_stat st;
    mz_zip_reader_file_stat(&archive, i, &st);
    if (st.m_is_directory) continue;
    auto path = normalize_path(st.m_filename);
    if (!path) return Error{"zip entry \"" + std::string(st.m_filename) + "\": " + path.error()};
    if (path.value() == ".DS_Store" || path.value().ends_with("/.DS_Store") || path.value().starts_with("__MACOSX/")) continue;
    Files::Bytes data(static_cast<size_t>(st.m_uncomp_size));
    // miniz inflates at most the declared size and verifies the CRC.
    if (!data.empty() && !mz_zip_reader_extract_to_mem(&archive, i, data.data(), data.size(), 0)) {
      return Error{"zip entry " + path.value() + ": " + mz_zip_get_error_string(mz_zip_get_last_error(&archive))};
    }
    if (Status s = files.add(std::move(path).value(), std::move(data), limits); !s) return Error{s.error()};
  }
  files.strip_single_top_folder();
  return files;
}

}  // namespace dreamsy::pkg
