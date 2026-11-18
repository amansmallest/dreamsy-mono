// Input state fed by the host (keyboard, touch controls, headless tools). A port of
// engine-web/core/input.ts. The platform layer (E5) feeds it from real devices; until then the
// tool feeds it from a scripted input plan (`dreamsy-tool run --input`).
#pragma once

#include <algorithm>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>

namespace dreamsy::script {

class Input {
 public:
  void set_axis(const std::string& name, double v) { axes_[name] = std::clamp(v, -1.0, 1.0); }
  void set_button(const std::string& name, bool down) {
    if (down && !down_.count(name)) edges_.insert(name);
    if (down) down_.insert(name);
    else down_.erase(name);
  }
  // Press and release within one tick still registers as pressed.
  void tap(const std::string& name) { edges_.insert(name); }

  // While true (a blocking ui.dialog is open) scripts see no input; the engine reads raw_*.
  bool blocked = false;
  std::optional<std::pair<double, double>> pointer;  // UI reference px while touching

  double axis(const std::string& name) const { return blocked ? 0 : raw_axis(name); }
  bool held(const std::string& name) const { return !blocked && down_.count(name); }
  bool pressed(const std::string& name) const { return !blocked && tick_edges_.count(name); }
  double raw_axis(const std::string& name) const {
    auto it = axes_.find(name);
    return it == axes_.end() ? 0 : it->second;
  }
  bool raw_pressed(const std::string& name) const { return tick_edges_.count(name) > 0; }

  // Called by the simulation at the start of each tick: edges since the last tick become visible.
  void begin_tick() {
    tick_edges_ = std::move(edges_);
    edges_.clear();
  }

 private:
  std::map<std::string, double> axes_;
  std::set<std::string> down_;
  std::set<std::string> edges_;       // since the last tick
  std::set<std::string> tick_edges_;  // visible to scripts this tick
};

}  // namespace dreamsy::script
