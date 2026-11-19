// Fuzz target: arbitrary bytes as a zip for the legacy importer (tools only).
#include <cstddef>
#include <cstdint>

#include "pkg/zip_import.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  (void)dreamsy::pkg::import_zip({data, size});
  return 0;
}
