// require() name resolution, shared by the runtime host and the type checker so both agree on
// which module a require names (engine-web/core/game.ts resolveModule).
//   "@kit/<kit>[/<module>]"  -> "kits/<kit>/<module>.luau" or ".../<module>/init.luau" (kit must be enabled)
//   relative paths            -> resolved against the requiring file, never above scripts/ (or kits/<kit>/)
#pragma once

#include <functional>
#include <string>
#include <vector>

#include "base/result.h"

namespace dreamsy::script {

Result<std::string> resolve_require(const std::string& from, const std::string& name,
                                    const std::vector<std::string>& enabled_kits,
                                    const std::function<bool(const std::string&)>& kit_exists);

}  // namespace dreamsy::script
