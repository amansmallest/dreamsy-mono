// The Luau prelude, embedded at build time by cmake/gen_script_data.py.
#pragma once

#include <string_view>

namespace dreamsy::script::data {

std::string_view prelude();  // extracted from engine-web/core/prelude.ts

}  // namespace dreamsy::script::data
