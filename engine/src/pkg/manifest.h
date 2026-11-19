// dreamsy.toml (docs/format.md §3.1), port of the zod Manifest schema in format/src/schema.ts.
#pragma once

#include <string_view>

#include "base/result.h"
#include "pkg/package.h"

namespace dreamsy::pkg {

// Parses and checks the manifest's shape (types, ranges, unknown keys). Cross-file rules
// (entry scene exists, kits, players vs server mode) are checked by load_package().
// On failure the error is every problem joined with "; ", or "not valid TOML: ...".
Result<Manifest> parse_manifest(std::string_view text);

}  // namespace dreamsy::pkg
