// World -> draw list: what a running game looks like this frame.
//
// Walks the entity tree the same way engine-web's renderer does (render/renderer2d.ts sync): an
// invisible entity hides its whole subtree; draw order is the accumulated z_index down the tree,
// then tree order (the renderer's sort: layer, z_index, then submission order in side view); every
// spatial entity is placed by its full parent transform. 2.5D height (Entity::z) goes straight into
// the commands, so raised sprites get drop shadows and every view mode projects correctly.
//
// Drawn today: Sprite2D (texture or solid rect, current animation frame, flip, modulate, blend),
// Text2D, TileMap2D, Particles2D. UI entities (UIPanel/UIText/UIButton) are screen-space and drawn by
// play/platform_ui.h (ui/layout.h + ui/overlay.h) on top. Not yet: Light2D/Lighting2D (E10), debug shapes.
#pragma once

#include "render/draw_list.h"
#include "render/textures.h"
#include "script/host.h"

namespace dreamsy::play {

// Clears `out` and fills it from the host's world and camera.
void draw_world(script::Host& host, render::TextureStore& textures, render::DrawList& out);

}  // namespace dreamsy::play
