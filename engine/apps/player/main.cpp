// dreamsy-player: the windowed engine (web, macOS, later iOS/Android).
//
// E0: proves the graphics stack on every target by drawing a spinning square. E4 replaces
// this with the real renderer and E6 with package loading.
#include <string>

#include "base/log.h"
#include "base/version.h"
#include "sokol_app.h"
#include "sokol_gfx.h"
#include "sokol_glue.h"
#include "sokol_log.h"
#include "sokol_time.h"
#include "util/sokol_gl.h"

namespace {

uint64_t g_start_ticks = 0;

void init() {
  sg_desc gfx{};
  gfx.environment = sglue_environment();
  gfx.logger.func = slog_func;
  sg_setup(&gfx);

  sgl_desc_t gl{};
  gl.logger.func = slog_func;
  sgl_setup(&gl);

  stm_setup();
  g_start_ticks = stm_now();
  dreamsy::log_info(std::string("dreamsy player ") + dreamsy::kEngineVersion + " (" +
                    (sg_query_backend() == SG_BACKEND_METAL_MACOS ? "metal" : "gl") + ")");
}

void frame() {
  const float t = static_cast<float>(stm_sec(stm_since(g_start_ticks)));
  const float w = sapp_widthf();
  const float h = sapp_heightf();

  sgl_defaults();
  sgl_matrix_mode_projection();
  sgl_ortho(0.0f, w, h, 0.0f, -1.0f, 1.0f);  // pixels, y down
  sgl_matrix_mode_modelview();
  sgl_translate(w * 0.5f, h * 0.5f, 0.0f);
  sgl_rotate(t, 0.0f, 0.0f, 1.0f);

  const float s = 0.15f * (w < h ? w : h);
  sgl_begin_quads();
  sgl_v2f_c3b(-s, -s, 255, 120, 180);
  sgl_v2f_c3b(s, -s, 120, 200, 255);
  sgl_v2f_c3b(s, s, 255, 220, 120);
  sgl_v2f_c3b(-s, s, 160, 255, 160);
  sgl_end();

  sg_pass pass{};
  pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
  pass.action.colors[0].clear_value = {0.08f, 0.07f, 0.12f, 1.0f};
  pass.swapchain = sglue_swapchain();
  sg_begin_pass(&pass);
  sgl_draw();
  sg_end_pass();
  sg_commit();
}

void cleanup() {
  sgl_shutdown();
  sg_shutdown();
}

void event(const sapp_event* e) {
  if (e->type == SAPP_EVENTTYPE_KEY_DOWN && e->key_code == SAPP_KEYCODE_ESCAPE) sapp_request_quit();
}

}  // namespace

sapp_desc sokol_main(int, char**) {
  sapp_desc desc{};
  desc.init_cb = init;
  desc.frame_cb = frame;
  desc.cleanup_cb = cleanup;
  desc.event_cb = event;
  desc.width = 960;
  desc.height = 540;
  desc.high_dpi = true;
  desc.window_title = "Dreamsy";
  desc.logger.func = slog_func;
  return desc;
}
