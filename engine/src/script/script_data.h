// Luau source embedded at build time by cmake/gen_script_data.py.
#pragma once

#include <span>
#include <string_view>

namespace dreamsy::script::data {

struct KitSource {
  std::string_view path;    // "kits/<kit>/<module>.luau"
  std::string_view source;
};

std::string_view prelude();                // extracted from engine-web/core/prelude.ts
std::span<const KitSource> kit_sources();  // engine-web/kits/**/*.luau, sorted by path

}  // namespace dreamsy::script::data
