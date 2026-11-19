// Type checking for game scripts (docs/engine.md §14.13): `dreamsy-tool check <package>`.
//
// Runs Luau's analyzer over every script in the package against the typed API declarations
// (format/dreamsy.d.luau, with the Entity props generated from format/catalog.json). Requires resolve
// exactly like the runtime (script/require_path.h), kits included. Problems are reported as
// path:line:column. `--!strict` scripts get errors, other scripts warnings; syntax errors are always errors.
// Kit code is checked as a dependency but its own findings are not reported (they're the engine's).
#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "base/result.h"
#include "pkg/package.h"

namespace dreamsy::check {

struct Issue {
  std::string file;
  int line = 0;    // 1-based
  int column = 0;  // 1-based
  std::string severity;  // "error" | "warning"
  std::string kind;      // "syntax" | "type" | "lint:<Name>"
  std::string message;
};

struct Options {
  bool strict = false;  // treat every script as --!strict (errors instead of warnings)
};

struct Report {
  std::vector<Issue> issues;  // sorted by file, line, column
  int errors = 0;
  int warnings = 0;
};

Result<Report> check_package(const pkg::Package& package, const Options& options = {});

// The complete definitions the checker uses (for the harness / `dreamsy-tool check --print-defs`).
std::string_view definitions();

}  // namespace dreamsy::check
