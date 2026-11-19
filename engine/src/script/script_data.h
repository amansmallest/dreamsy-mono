// The Luau prelude, embedded at build time by cmake/gen_script_data.py.
#pragma once

#include <string_view>

namespace dreamsy::script::data {

std::string_view prelude();  // src/script/prelude.luau with the op numbers from ops.h filled in

}  // namespace dreamsy::script::data
