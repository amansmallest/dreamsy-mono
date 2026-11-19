// Fuzz target: a whole package from bytes, to drive the TOML/JSON parsers and every validator
// rule with structured input. Format: "path\0content\0path\0content..." (see make_corpus.py).
#include <cstddef>
#include <cstdint>
#include <map>
#include <string>

#include "pkg/validate.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  using namespace dreamsy::pkg;
  std::map<std::string, std::string> files;
  std::string_view in(reinterpret_cast<const char*>(data), size);
  while (!in.empty()) {
    size_t a = in.find('\0');
    std::string path(in.substr(0, a));
    if (a == std::string_view::npos) break;
    in.remove_prefix(a + 1);
    size_t b = in.find('\0');
    files[path] = std::string(in.substr(0, b));
    if (b == std::string_view::npos) break;
    in.remove_prefix(b + 1);
  }
  auto pkg = Files::from_map(files);
  if (pkg) (void)load_package(std::move(pkg).value());
  return 0;
}
