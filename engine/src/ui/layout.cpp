#include "ui/layout.h"

#include <algorithm>

namespace dreamsy::ui {

using world::Entity;
using world::EntityId;
using world::Point;

Rect intersect(const Rect& a, const Rect& b) {
  const double x0 = std::max(a.x, b.x), y0 = std::max(a.y, b.y);
  const double x1 = std::min(a.x + a.w, b.x + b.w), y1 = std::min(a.y + a.h, b.y + b.h);
  return {x0, y0, x1 - x0, y1 - y0};
}

bool is_ui_type(std::string_view t) { return t == "UIPanel" || t == "UIText" || t == "UIButton"; }

namespace {

bool is_ui(const Entity* e) { return e && is_ui_type(e->type->name); }

// engine-web ANCHOR table: fractions of the container where the element's matching point goes.
Point anchor_fraction(std::string_view a) {
  if (a == "top") return {0.5, 0};
  if (a == "top_right") return {1, 0};
  if (a == "left") return {0, 0.5};
  if (a == "center") return {0.5, 0.5};
  if (a == "right") return {1, 0.5};
  if (a == "bottom_left") return {0, 1};
  if (a == "bottom") return {0.5, 1};
  if (a == "bottom_right") return {1, 1};
  return {0, 0};  // top_left and unknown
}

// The element and all its ancestors (UI or not) are visible (engine-web effectiveVisible).
bool effective_visible(const world::World& w, EntityId id) {
  for (const Entity* e = w.get(id); e; e = w.get(e->parent)) {
    if (!w.visible(*e)) return false;
  }
  return true;
}

}  // namespace

Rect anchor_rect(std::string_view anchor, Point offset, Point size, double cx, double cy, double cw, double ch) {
  const Point a = anchor_fraction(anchor);
  return {cx + a.x * cw + offset.x - a.x * size.x, cy + a.y * ch + offset.y - a.y * size.y, size.x, size.y};
}

Rect ui_child_rect(const world::World& w, EntityId id, double pw, double ph) {
  const Entity& e = *w.get(id);
  const Point size = w.vec(e, "size"), off = w.vec(e, "offset");
  const Entity* p = w.get(e.parent);
  if (!p || p->type->name != "UIPanel" || w.str(*p, "layout") != "stack") {
    return anchor_rect(w.str(e, "anchor"), off, size, 0, 0, pw, ph);
  }
  const double gap = w.num(*p, "gap");
  double y = w.num(*p, "padding");
  for (EntityId cid : p->children) {
    const Entity* c = w.get(cid);
    if (!is_ui(c)) continue;
    if (cid == id) {
      const double ax = anchor_fraction(w.str(e, "anchor")).x;
      return {ax * pw + off.x - ax * size.x, y + off.y, size.x, size.y};
    }
    if (w.visible(*c)) y += w.vec(*c, "offset").y + w.vec(*c, "size").y + gap;
  }
  return anchor_rect(w.str(e, "anchor"), off, size, 0, 0, pw, ph);
}

Rect ui_rect_headless(const world::World& w, EntityId id, double ref_w, double ref_h) {
  const Entity& e = *w.get(id);
  if (is_ui(w.get(e.parent))) {
    const Rect p = ui_rect_headless(w, e.parent, ref_w, ref_h);
    const Rect r = ui_child_rect(w, id, p.w, p.h);
    return {p.x + r.x, p.y + r.y, r.w, r.h};
  }
  return anchor_rect(w.str(e, "anchor"), w.vec(e, "offset"), w.vec(e, "size"), 0, 0, ref_w, ref_h);
}

EntityId ui_hit_headless(const world::World& w, double x, double y, double ref_w, double ref_h) {
  EntityId best;
  double best_key = -1e300;
  double order = 0;
  for (EntityId id : w.walk()) {
    order++;
    const Entity* e = w.get(id);
    if (!is_ui(e) || !effective_visible(w, id)) continue;
    if (e->type->name != "UIButton" && w.flag(*e, "input_transparent")) continue;
    if (!ui_rect_headless(w, id, ref_w, ref_h).contains(x, y)) continue;
    const double key = w.num(*e, "z_index") * 1e6 + order;
    if (key > best_key) {
      best_key = key;
      best = id;
    }
  }
  return best;
}

// ---------------------------------------------------------------- full layout (drawing, device taps)

namespace {

struct Ctx {
  const world::World& w;
  ScrollOffsets& scroll;
  std::vector<UiNode>& out;
};

struct Parent {
  Rect rect;  // the parent's screen rect (scroll of its own ancestors applied)
  double scroll_y = 0;  // the parent's own scroll offset (shifts its children up)
  std::optional<Rect> clip;
  double sx = 1, sy = 1, tx = 0, ty = 0;
  EntityId scroll_panel;
};

// UI children of `id` (direct UI children, or UI found through non-UI containers like Folders)
// in stacking order: z_index, then tree order.
void collect_ui_children(const world::World& w, EntityId id, std::vector<EntityId>& out) {
  for (EntityId c : w.get(id)->children) {
    const Entity* e = w.get(c);
    if (!e) continue;
    if (is_ui(e)) {
      out.push_back(c);
    } else if (w.visible(*e)) {
      collect_ui_children(w, c, out);  // a hidden Folder hides its UI too
    }
  }
}

void sort_by_z(const world::World& w, std::vector<EntityId>& ids) {
  std::stable_sort(ids.begin(), ids.end(), [&](EntityId a, EntityId b) {
    return w.num(*w.get(a), "z_index") < w.num(*w.get(b), "z_index");
  });
}

void visit(Ctx& ctx, EntityId id, const Parent& parent, bool top_level, const UiScreen& screen) {
  const world::World& w = ctx.w;
  const Entity& e = *w.get(id);
  if (!w.visible(e)) return;

  UiNode n;
  n.id = id;
  n.entity = &e;
  if (top_level) {
    const SafeArea& s = screen.safe;
    n.rect = anchor_rect(w.str(e, "anchor"), w.vec(e, "offset"), w.vec(e, "size"), s.left, s.top,
                         screen.ref_w - s.left - s.right, screen.ref_h - s.top - s.bottom);
  } else {
    const Rect r = ui_child_rect(w, id, parent.rect.w, parent.rect.h);
    n.rect = {parent.rect.x + r.x, parent.rect.y + r.y - parent.scroll_y, r.w, r.h};
  }
  n.clip = parent.clip;
  n.scroll_panel = parent.scroll_panel;

  // Visual scale around this element's center, composed with the parents' transform.
  const Point sc = w.vec(e, "scale");
  const double cx = n.rect.x + n.rect.w / 2, cy = n.rect.y + n.rect.h / 2;
  // own(p) = c + s * (p - c) = (c - s*c) + s*p;  combined(p) = parent(own(p))
  n.sx = parent.sx * sc.x;
  n.sy = parent.sy * sc.y;
  n.tx = parent.tx + parent.sx * (cx - sc.x * cx);
  n.ty = parent.ty + parent.sy * (cy - sc.y * cy);

  const std::string& type = e.type->name;
  n.interactive = type == "UIButton" || !w.flag(e, "input_transparent");

  std::vector<EntityId> kids;
  if (type == "UIPanel") collect_ui_children(w, id, kids);
  const bool scrolls = type == "UIPanel" && w.flag(e, "scroll");
  double scroll_y = 0;
  if (scrolls) {
    // Content height: the lowest visible child + 16 px of bottom padding (engine-web's spacer).
    double bottom = 0;
    for (EntityId c : kids) {
      if (!w.visible(*w.get(c))) continue;
      const Rect r = ui_child_rect(w, c, n.rect.w, n.rect.h);
      bottom = std::max(bottom, r.y + r.h);
    }
    n.content_height = bottom + 16;
    double& off = ctx.scroll[id];
    off = std::clamp(off, 0.0, std::max(0.0, n.content_height - n.rect.h));
    scroll_y = off;
  }
  ctx.out.push_back(n);
  if (kids.empty()) return;

  Parent p;
  p.rect = n.rect;
  p.scroll_y = scroll_y;
  p.clip = n.clip;
  if (scrolls || (type == "UIPanel" && w.flag(e, "clip"))) p.clip = n.clip ? intersect(*n.clip, n.rect) : n.rect;
  p.sx = n.sx, p.sy = n.sy, p.tx = n.tx, p.ty = n.ty;
  p.scroll_panel = scrolls ? id : n.scroll_panel;
  sort_by_z(w, kids);
  for (EntityId c : kids) visit(ctx, c, p, false, screen);
}

}  // namespace

std::vector<UiNode> layout_ui(const world::World& w, const UiScreen& screen, ScrollOffsets& scroll) {
  std::vector<UiNode> out;
  Ctx ctx{w, scroll, out};
  // Top-level UI: every UI element without a UI ancestor, found through non-UI entities.
  std::vector<EntityId> top;
  collect_ui_children(w, w.root(), top);
  sort_by_z(w, top);
  for (EntityId id : top) visit(ctx, id, Parent{}, true, screen);
  // Forget offsets of panels that no longer exist.
  std::erase_if(scroll, [&](const auto& kv) { return !w.alive(kv.first); });
  return out;
}

Rect scaled_rect(const UiNode& n, const Rect& r) {
  return {n.tx + n.sx * r.x, n.ty + n.sy * r.y, r.w * n.sx, r.h * n.sy};
}

const UiNode* hit_ui(const std::vector<UiNode>& nodes, double x, double y) {
  for (size_t i = nodes.size(); i-- > 0;) {
    const UiNode& n = nodes[i];
    if (!n.interactive) continue;
    // Hit size is unchanged by `scale` (format/LUAU_API.md); clips are tested unscaled too.
    if (n.clip && !n.clip->contains(x, y)) continue;
    if (n.rect.contains(x, y)) return &n;
  }
  return nullptr;
}

}  // namespace dreamsy::ui
