// Where the script host finds kit sources ("kits/<kit>/<module>.luau", DREAMSY.MD §12.1).
//
// Players load only the kits a game enables, as separate Dreamsy packs (kits/<kit>.dpk, built by
// cmake/gen_kit_packs.py), so kit code isn't in the player download. Tools and tests link every kit
// into the binary instead (embedded_kits.h) and register them as the process-wide default.
#pragma once

#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "pkg/files.h"

namespace dreamsy::script {

// Returns a kit file's source, or nullopt. The returned view must stay valid while the host runs.
using KitLookup = std::function<std::optional<std::string_view>(const std::string& path)>;

// The default used when HostOptions::kits is empty. Empty by default: no kits available.
void set_default_kits(KitLookup lookup);
const KitLookup& default_kits();

// Kits from packs (each holds "kits/<kit>/..." paths). The packs are kept alive by the lookup.
KitLookup kits_from_packs(std::vector<std::shared_ptr<const pkg::Files>> packs);

}  // namespace dreamsy::script
