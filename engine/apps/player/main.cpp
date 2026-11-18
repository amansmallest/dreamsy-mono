// dreamsy-player: the windowed engine (web, macOS, later iOS/Android).
//
// E4: loads a package and draws a renderer test scene from its assets (demo_scene.h) with the
// real renderer (src/render). E3 will fill the draw list from the world instead, and E6 runs games.
//
//   dreamsy-player [package-dir] [--view side|topdown|oblique|iso] [--smooth] [--frames N]
//
// --smooth forces smooth mode (linear filtering) on a pixel-art package. On the web the package
// is embedded at /pkg and the URL hash sets the options (dreamsy-player.html#iso, #iso-smooth). Keys: 1-4 pick the view mode, Tab cycles, Esc quits.
#include <cstdlib>
#include <cstring>
#include <memory>
#include <optional>
#include <string>

#include "base/log.h"
#include "base/version.h"
#include "demo_scene.h"
#include "pkg/validate.h"
#include "render/atlas.h"
#include "render/font.h"
#include "render/renderer.h"
#include "render/style.h"
#include "render/textures.h"
#include "sokol_app.h"
#include "sokol_gfx.h"
#include "sokol_glue.h"
#include "sokol_log.h"
#include "sokol_time.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace {

using namespace dreamsy;

#ifndef DREAMSY_DEMO_PACKAGE
#define DREAMSY_DEMO_PACKAGE "/pkg"
#endif

struct Options {
  std::string package_dir = DREAMSY_DEMO_PACKAGE;
  render::ViewMode view = render::ViewMode::Side;
  int frames = 0;  // quit after this many frames (0 = run until closed)
  bool smooth = false;  // force smooth mode (linear filtering, no pixel snap) to check it on any package
};

std::optional<render::ViewMode> parse_view(const char* s) {
  if (std::strcmp(s, "side") == 0) return render::ViewMode::Side;
  if (std::strcmp(s, "topdown") == 0) return render::ViewMode::TopDown;
  if (std::strcmp(s, "oblique") == 0) return render::ViewMode::Oblique;
  if (std::strcmp(s, "iso") == 0) return render::ViewMode::Iso;
  return std::nullopt;
}

// Everything the player owns. One instance, created in sokol_main, freed in cleanup.
struct App {
  Options options;
  std::unique_ptr<pkg::Package> package;
  render::RenderStyle style;
  std::unique_ptr<render::Atlas> atlas;
  std::unique_ptr<render::TextureStore> textures;
  std::unique_ptr<render::FontStore> fonts;
  std::unique_ptr<player::DemoScene> scene;
  render::Renderer renderer;
  render::DrawList draw_list;
  render::ViewMode view = render::ViewMode::Side;
  uint64_t start_ticks = 0;
  int frame_count = 0;
  bool ok = false;
};

std::unique_ptr<App> g_app;

bool load(App& app) {
  auto files = pkg::Files::from_dir(app.options.package_dir);
  if (!files) {
    log_error("can't open package " + app.options.package_dir + ": " + files.error());
    return false;
  }
  pkg::LoadResult loaded = pkg::load_package(std::move(files).value());
  for (const pkg::Issue& issue : loaded.issues) {
    if (issue.severity == pkg::Severity::Error) log_error(pkg::format_issue(issue));
  }
  if (!loaded.ok) return false;
  app.package = std::move(loaded.package);
  app.style = render::style_from_manifest(app.package->manifest);
  if (app.options.smooth) {
    app.style.nearest = false;
    app.style.pixel_snap = false;
  }
  app.atlas = std::make_unique<render::Atlas>();
  app.textures = std::make_unique<render::TextureStore>(app.package.get(), *app.atlas, app.style.nearest);
  app.fonts = std::make_unique<render::FontStore>(*app.atlas, app.style.theme_font);
  if (Status s = app.fonts->init(); !s) {
    log_error(s.error());
    return false;
  }
  app.scene = std::make_unique<player::DemoScene>(*app.package, *app.textures, app.style);
  return true;
}

void init() {
  App& app = *g_app;
  sg_desc gfx{};
  gfx.environment = sglue_environment();
  gfx.logger.func = slog_func;
  sg_setup(&gfx);
  stm_setup();
  app.start_ticks = stm_now();
  log_info(std::string("dreamsy player ") + kEngineVersion + " (" +
           (sg_query_backend() == SG_BACKEND_GLES3 ? "webgl2/gles3" : "metal") + ")");

#ifdef __EMSCRIPTEN__
  // dreamsy-player.html#iso picks the view mode; #iso-smooth also forces smooth mode.
  std::string hash = emscripten_run_script_string("window.location.hash.slice(1)");
  if (const size_t dash = hash.find('-'); dash != std::string::npos) {
    app.options.smooth = hash.substr(dash + 1) == "smooth";
    hash.resize(dash);
  }
  if (auto v = parse_view(hash.c_str())) app.options.view = *v;
#endif
  app.view = app.options.view;

  if (!load(app)) return;
  if (Status s = app.renderer.init(app.style); !s) {
    log_error(s.error());
    return;
  }
  app.ok = true;
  log_info("package \"" + app.package->manifest.name + "\": reference " + std::to_string(app.style.ref_w) + "x" +
           std::to_string(app.style.ref_h) + (app.style.pixel_snap ? ", pixel-art mode" : ", smooth mode"));
}

void frame() {
  App& app = *g_app;
  if (!app.ok) {
    // Nothing loaded: clear to a dark red so the failure is visible, and keep the window up.
    sg_pass pass{};
    pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
    pass.action.colors[0].clear_value = {0.3f, 0.05f, 0.08f, 1};
    pass.swapchain = sglue_swapchain();
    sg_begin_pass(&pass);
    sg_end_pass();
    sg_commit();
    return;
  }
  const double t = stm_sec(stm_since(app.start_ticks));
  app.scene->build(app.draw_list, app.view, t, app.renderer.stats());
  app.renderer.draw(app.draw_list, *app.textures, *app.fonts, sglue_swapchain(), sapp_width(), sapp_height());
  sg_commit();

  app.frame_count++;
  if (app.options.frames > 0 && app.frame_count >= app.options.frames) {
    const render::FrameStats& s = app.renderer.stats();
    log_info("frame " + std::to_string(app.frame_count) + " (" + player::view_mode_name(app.view) +
             "): " + std::to_string(s.draw_calls) + " draw calls, " + std::to_string(s.quads) + " quads, " +
             std::to_string(s.culled) + " culled, " + std::to_string(s.atlas_pages) + " atlas pages, " +
             std::to_string(app.fonts->cached_glyphs()) + " glyphs, framebuffer " + std::to_string(sapp_width()) +
             "x" + std::to_string(sapp_height()));
    sapp_request_quit();
  }
}

void cleanup() {
  g_app->renderer.shutdown();
  sg_shutdown();
  g_app.reset();
}

void event(const sapp_event* e) {
  App& app = *g_app;
  if (e->type != SAPP_EVENTTYPE_KEY_DOWN) return;
  switch (e->key_code) {
    case SAPP_KEYCODE_ESCAPE: sapp_request_quit(); break;
    case SAPP_KEYCODE_1: app.view = render::ViewMode::Side; break;
    case SAPP_KEYCODE_2: app.view = render::ViewMode::TopDown; break;
    case SAPP_KEYCODE_3: app.view = render::ViewMode::Oblique; break;
    case SAPP_KEYCODE_4: app.view = render::ViewMode::Iso; break;
    case SAPP_KEYCODE_TAB: app.view = static_cast<render::ViewMode>((static_cast<int>(app.view) + 1) % 4); break;
    default: break;
  }
}

}  // namespace

sapp_desc sokol_main(int argc, char** argv) {
  g_app = std::make_unique<App>();
  Options& o = g_app->options;
  for (int i = 1; i < argc; i++) {
    const std::string arg = argv[i];
    if (arg == "--view" && i + 1 < argc) {
      if (auto v = parse_view(argv[++i])) {
        o.view = *v;
      } else {
        log_warn(std::string("unknown view mode: ") + argv[i]);
      }
    } else if (arg == "--smooth") {
      o.smooth = true;
    } else if (arg == "--frames" && i + 1 < argc) {
      o.frames = std::atoi(argv[++i]);
    } else if (!arg.empty() && arg[0] != '-') {
      o.package_dir = arg;
    }
  }

  // Window shape from the package's orientation (portrait 9:16, landscape 16:9); the renderer
  // letterboxes anyway, this just avoids big bars.
  bool portrait = false;
  if (auto files = pkg::Files::from_dir(o.package_dir)) {
    if (auto toml = files.value().text("dreamsy.toml")) portrait = toml->find("\"portrait\"") != std::string_view::npos;
  }

  sapp_desc desc{};
  desc.init_cb = init;
  desc.frame_cb = frame;
  desc.cleanup_cb = cleanup;
  desc.event_cb = event;
  desc.width = portrait ? 540 : 960;
  desc.height = portrait ? 960 : 540;
  desc.high_dpi = true;
  desc.window_title = "Dreamsy";
  desc.logger.func = slog_func;
  return desc;
}
