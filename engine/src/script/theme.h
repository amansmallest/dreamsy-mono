// Platform UI theme from dreamsy.toml [ui], with defaults derived from style.palette / preset.
// Port of engine-web/core/theme.ts resolveTheme (same colors for the same manifest).
#pragma once

#include <string>

#include "pkg/package.h"

namespace dreamsy::script {

struct Theme {
  std::string primary, accent, background, text, panel, font;
};

Theme resolve_theme(const pkg::Manifest& m);

}  // namespace dreamsy::script
