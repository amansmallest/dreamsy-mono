#include "script/embedded_kits.h"

#include <algorithm>
#include <string>

#include "script/kits.h"

namespace dreamsy::script {

std::optional<std::string_view> embedded_kit_source(const std::string& path) {
  auto kits = data::kit_sources();
  auto it = std::lower_bound(kits.begin(), kits.end(), path,
                             [](const data::KitSource& k, const std::string& p) { return k.path < p; });
  if (it == kits.end() || it->path != path) return std::nullopt;
  return it->source;
}

void use_embedded_kits() { set_default_kits(&embedded_kit_source); }

}  // namespace dreamsy::script
