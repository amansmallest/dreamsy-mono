// Data embedded into the engine at build time by cmake/embed_data.cmake.
#pragma once

#include <string_view>

namespace dreamsy::pkg::embedded {

std::string_view catalog_json();  // format/catalog.json
std::string_view kits_json();     // {"<kit>": <engine-web/kits/<kit>/kit.json>, ...}

}  // namespace dreamsy::pkg::embedded
