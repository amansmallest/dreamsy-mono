// Converts zip archives (the old transport format, still used by engine-web and the API) into
// Files, so `dreamsy-tool pack` can turn existing builds into Dreamsy packs. The engine itself
// never reads zips; this lives in its own library (dreamsy_zip_import), linked only by tools.
#pragma once

#include <cstdint>
#include <span>

#include "pkg/files.h"

namespace dreamsy::pkg {

// Checks every entry's declared size against `limits` before decompressing anything (zip
// bombs), rejects encrypted entries and paths that escape the package, and strips a single
// top-level folder wrapping the package (like format/src/package.ts fromZip).
Result<Files> import_zip(std::span<const uint8_t> zip, const Limits& limits = {});

}  // namespace dreamsy::pkg
