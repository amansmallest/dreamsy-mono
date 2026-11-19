#include "script/kits.h"

namespace dreamsy::script {

namespace {
KitLookup& default_lookup() {
  static KitLookup lookup;
  return lookup;
}
}  // namespace

void set_default_kits(KitLookup lookup) { default_lookup() = std::move(lookup); }

const KitLookup& default_kits() { return default_lookup(); }

KitLookup kits_from_packs(std::vector<std::shared_ptr<const pkg::Files>> packs) {
  return [packs = std::move(packs)](const std::string& path) -> std::optional<std::string_view> {
    for (const auto& p : packs)
      if (auto text = p->text(path)) return text;
    return std::nullopt;
  };
}

}  // namespace dreamsy::script
