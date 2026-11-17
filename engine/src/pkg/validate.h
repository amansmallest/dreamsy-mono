// Loading and validating a game package.
//
// load_package() is a port of validatePackage() in format/src/validate.ts: it runs the same
// checks and reports issues with the same codes, so the TS validator (used by the harness and
// the API) and the C++ engine agree on which packages are valid. The conformance test compares
// the two on every package in games/ (engine/tests/conformance/).
//
// One intentional difference: the C++ engine is 2D/2.5D only (DREAMSY.MD §14), so
// dimension = "3d" is an error ("manifest.dimension_unsupported").
#pragma once

#include <memory>
#include <string>
#include <vector>

#include "pkg/files.h"
#include "pkg/package.h"

namespace dreamsy::pkg {

enum class Severity { Error, Warning };

struct Issue {
  Severity severity = Severity::Error;
  std::string code;     // stable machine code, e.g. "scene.orphan"
  std::string message;  // written to be fed straight back to the model
  std::string file;     // package file, when relevant
  std::string id;       // entity or asset id, when relevant
};

struct LoadResult {
  bool ok = false;  // no errors (warnings allowed)
  std::vector<Issue> issues;
  std::unique_ptr<Package> package;  // set only when ok
};

inline constexpr uint64_t kMaxPackageBytes = 200ull * 1024 * 1024;

LoadResult load_package(Files files);

// "✗ [code] file #id: message" (or "!" for warnings), as printed by `pnpm -C format cli validate`.
std::string format_issue(const Issue& issue);

}  // namespace dreamsy::pkg
