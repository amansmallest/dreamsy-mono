#include "script/theme.h"

#include <algorithm>
#include <cstdlib>
#include <map>
#include <vector>

namespace dreamsy::script {

namespace {

const std::map<std::string, Theme> kPresetDefaults = {
    {"pixel", {"#3b5dc9", "#ffcd75", "#1a1c2c", "#f4f4f4", "pixel", "pixel"}},
    {"blocky", {"#4caf50", "#ffd54f", "#263238", "#ffffff", "sharp", "bold"}},
    {"toon", {"#ff7a45", "#ffd93d", "#2b2d6e", "#ffffff", "rounded", "rounded"}},
    {"clean", {"#3d7eff", "#ffb547", "#1d2230", "#f5f7fb", "rounded", "bold"}},
    {"custom", {"#6c7cff", "#ffc857", "#202233", "#f5f5f5", "rounded", "bold"}},
};

void rgb(const std::string& hex, double out[3]) {
  long n = std::strtol(hex.substr(1, 6).c_str(), nullptr, 16);
  out[0] = static_cast<double>((n >> 16) & 255);
  out[1] = static_cast<double>((n >> 8) & 255);
  out[2] = static_cast<double>(n & 255);
}

double lum(const std::string& h) {
  double c[3];
  rgb(h, c);
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}

double sat(const std::string& h) {
  double c[3];
  rgb(h, c);
  double mx = std::max({c[0], c[1], c[2]}), mn = std::min({c[0], c[1], c[2]});
  return mx == 0 ? 0 : (mx - mn) / mx;
}

}  // namespace

Theme resolve_theme(const pkg::Manifest& m) {
  auto it = kPresetDefaults.find(m.style.preset);
  Theme base = it != kPresetDefaults.end() ? it->second : kPresetDefaults.at("clean");
  if (m.style.palette && m.style.palette->size() >= 3) {
    const std::vector<std::string>& pal = *m.style.palette;
    std::vector<std::string> by_lum = pal;
    std::stable_sort(by_lum.begin(), by_lum.end(), [](const auto& a, const auto& b) { return lum(a) < lum(b); });
    base.background = by_lum.front();
    base.text = lum(by_lum.back()) > 0.6 ? by_lum.back() : "#ffffff";
    std::vector<std::string> vivid;
    for (const std::string& c : pal)
      if (c != base.background && c != base.text) vivid.push_back(c);
    auto score = [](const std::string& c) { return sat(c) * (0.4 + lum(c)); };
    std::stable_sort(vivid.begin(), vivid.end(), [&](const auto& a, const auto& b) { return score(b) < score(a); });
    auto mid = std::find_if(vivid.begin(), vivid.end(), [](const auto& c) { return lum(c) > 0.25 && lum(c) < 0.7; });
    if (mid != vivid.end()) base.primary = *mid;
    else if (!vivid.empty()) base.primary = vivid.front();
    std::vector<std::string> rest;
    for (const std::string& c : vivid)
      if (c != base.primary) rest.push_back(c);
    std::stable_sort(rest.begin(), rest.end(),
                     [](const auto& a, const auto& b) { return lum(b) * sat(b) < lum(a) * sat(a); });
    if (!rest.empty()) base.accent = rest.front();
  }
  if (m.ui) {
    const pkg::Manifest::Ui& ui = *m.ui;
    if (ui.primary) base.primary = *ui.primary;
    if (ui.accent) base.accent = *ui.accent;
    if (ui.background) base.background = *ui.background;
    if (ui.text) base.text = *ui.text;
    if (ui.panel) base.panel = *ui.panel;
    if (ui.font) base.font = *ui.font;
  }
  return base;
}

}  // namespace dreamsy::script
