// Fuzz target: arbitrary bytes as a Dreamsy pack, then the full loader on whatever parses.
#include <cstddef>
#include <cstdint>
#include <memory>

#include "pkg/validate.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  using namespace dreamsy::pkg;
  auto bytes = std::make_shared<const Files::Bytes>(data, data + size);
  auto files = Files::from_pack(bytes);
  if (files) (void)load_package(std::move(files).value());
  return 0;
}
