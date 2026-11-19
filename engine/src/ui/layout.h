// UI entity layout (UIPanel / UIText / UIButton): where each element sits on the reference screen.
//
// One module for drawing (ui/overlay.h) and hit testing (the host's taps, play/platform_ui.h), so
// what you see is what you tap. A port of engine-web core/view2d.ts (anchorRect, uiChildRect),
// core/game.ts (uiRect, uiHit) and the layout half of render/ui.ts (stacking order, safe area,
// scroll lists, clipping).
//
//   - Top-level UI (no UI ancestor) anchors inside the safe area of the reference screen.
//   - Children of a UIPanel anchor inside the panel; a panel with layout = "stack" places its
//     visible UI children top to bottom (padding, gap), the child's anchor only picks the column.
//   - Draw order follows the DOM engine-web builds: a parent under its children; siblings by
//     z_index, then tree order. Toasts, dialogs and the platform shell are always on top.
//   - scroll = true panels clip their children and scroll vertically (content height = the lowest
//     child + 16 px); clip = true panels clip without scrolling.
//   - `scale` is visual only (around the element's center): layout and hit size are unchanged.
//   - An invisible element (or any invisible ancestor, UI or not) hides its subtree.
#pragma once

#include <map>
#include <optional>
#include <string_view>
#include <vector>

#include "world/world.h"

namespace dreamsy::ui {

struct Rect {
  double x = 0, y = 0, w = 0, h = 0;

  bool contains(double px, double py) const { return px >= x && py >= y && px <= x + w && py <= y + h; }
};

// Intersection (empty rects have w or h <= 0).
Rect intersect(const Rect& a, const Rect& b);

// The safe area inside the reference screen (notch, home indicator), reference px.
struct SafeArea {
  double top = 0, right = 0, bottom = 0, left = 0;
};

struct UiScreen {
  double ref_w = 1280, ref_h = 720;
  SafeArea safe;
  // The whole window (the "container" in engine-web) in reference px. It includes the letterbox
  // bars, so x/y are <= 0 and the size >= the reference screen. The platform's own controls (pause
  // button and menu, touch controls) live here, like engine-web's; the game's UI stays inside the
  // reference screen. Empty (w = 0) means the window is exactly the reference screen.
  Rect container;

  Rect window() const { return container.w > 0 && container.h > 0 ? container : Rect{0, 0, ref_w, ref_h}; }
};

bool is_ui_type(std::string_view type_name);  // UIPanel, UIText, UIButton

// [x, y, w, h] of an element with `anchor` (top_left ... bottom_right), `offset` and `size` inside
// the container (cx, cy, cw, ch) (engine-web anchorRect).
Rect anchor_rect(std::string_view anchor, world::Point offset, world::Point size, double cx, double cy, double cw,
                 double ch);

// A UI child's rect inside its parent's local box (0, 0, pw, ph): stack layout or anchor (uiChildRect).
Rect ui_child_rect(const world::World& w, world::EntityId id, double pw, double ph);

// Headless rect of an element (engine-web Game.uiRect: no safe area, no scrolling; an element
// whose direct parent isn't UI anchors to the screen).
Rect ui_rect_headless(const world::World& w, world::EntityId id, double ref_w, double ref_h);

// Headless hit test (engine-web Game.uiHit): the visible, non-input-transparent UI element under
// the point with the highest z_index * 1e6 + tree order. UIButtons are never transparent.
world::EntityId ui_hit_headless(const world::World& w, double x, double y, double ref_w, double ref_h);

// Orders entity ids (for std::map / std::set keys).
struct EntityIdLess {
  bool operator()(world::EntityId a, world::EntityId b) const {
    return a.index != b.index ? a.index < b.index : a.generation < b.generation;
  }
};

// Vertical scroll offsets of scroll panels (px scrolled down), by entity. Kept by the platform UI.
using ScrollOffsets = std::map<world::EntityId, double, EntityIdLess>;

// One laid-out element, in draw order.
struct UiNode {
  world::EntityId id;
  const world::Entity* entity = nullptr;
  Rect rect;                 // on screen (reference px), scroll applied, before visual scale
  std::optional<Rect> clip;  // children of clip/scroll panels: draw and hit only inside this
  // Visual scale: each element's `scale` scales it and its children around its own center. The
  // levels fold into one per-axis transform, drawn = (tx, ty) + (sx, sy) * point, applied to the
  // rect and the clip alike. Identity when nothing is scaled.
  double sx = 1, sy = 1, tx = 0, ty = 0;
  world::EntityId scroll_panel;  // nearest scroll panel ancestor (null if none)
  double content_height = 0;     // scroll panels: height of the scrolled content
  bool interactive = false;      // takes taps (UIButton; panels/texts unless input_transparent)
};

// Lays out every visible UI element. `scroll` offsets are clamped to their panel's range.
std::vector<UiNode> layout_ui(const world::World& w, const UiScreen& screen, ScrollOffsets& scroll);

// The topmost interactive node under the point (reverse draw order, clips respected); nullptr if none.
const UiNode* hit_ui(const std::vector<UiNode>& nodes, double x, double y);

// A node's rect after its visual scale (what gets drawn).
Rect scaled_rect(const UiNode& n, const Rect& r);

}  // namespace dreamsy::ui
