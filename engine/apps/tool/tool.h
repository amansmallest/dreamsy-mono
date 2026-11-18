// dreamsy-tool internals shared between main.cpp and the playtest/eval commands (playtest.cpp).
#pragma once

#include <memory>
#include <string>

#include "base/result.h"
#include "pkg/files.h"

namespace dreamsy::tool {

Result<std::shared_ptr<pkg::Files::Bytes>> read_file(const std::string& path);
// A directory, a .dpk pack or a legacy .zip (converted on the fly).
Result<pkg::Files> load_files(const std::string& path);

// `dreamsy-tool playtest`: a scripted playtest with a JSON report (the harness's playtest tool).
int cmd_playtest(int argc, char** argv);
// `dreamsy-tool eval`: runs a Luau snippet in a package (kit balance simulations) -> JSON.
int cmd_eval(int argc, char** argv);

}  // namespace dreamsy::tool
