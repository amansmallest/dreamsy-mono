// dreamsy-player: the windowed engine (web, macOS, later iOS/Android).
//
// Runs a game: the package's scripts at a fixed 60 Hz (script::Host: world, physics, tweens,
// animation, camera) and draws the world every frame (play::draw_world -> render::Renderer).
// --demo shows the E4 renderer test scene (demo_scene.h) instead.
//
//   dreamsy-player [package-dir] [--view side|topdown|oblique|iso] [--smooth] [--frames N] [--demo]
//
// Input until E5 lands: arrows/WASD move (move_x/move_y), space/up = jump, Z/J = action, X/K = action2.
// In game mode, keys 1-4 preview the world in another view mode (2.5D projection).
//
// --smooth forces smooth mode (linear filtering) on a pixel-art package. On the web the package
// is embedded at /pkg and the URL hash sets the options (dreamsy-player.html#iso, #iso-smooth). Keys: 1-4 pick the view mode, Tab cycles, Esc quits.
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <optional>
#include <string>

#include "base/log.h"
#include "base/version.h"
#include "demo_scene.h"
#include "pkg/catalog.h"
#include "play/scene_draw.h"
#include "script/host.h"
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
#ifndef DREAMSY_KIT_PACKS_DIR
#define DREAMSY_KIT_PACKS_DIR "/kits"  // web: fetched with the package once games load by URL (E6)
#endif

// The kits a game enables (and their dependencies), each from <dir>/<kit>.dpk. Kit code isn't in the
// player binary (script/kits.h); only what a game uses is loaded.
Result<script::KitLookup> load_kits(const pkg::Manifest& m) {
  std::vector<std::shared_ptr<const pkg::Files>> packs;
  for (const std::string& kit : pkg::Catalog::get().expand_kits(m.kits.value_or(std::vector<std::string>{}))) {
    const std::string path = std::string(DREAMSY_KIT_PACKS_DIR) + "/" + kit + ".dpk";
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return Error{"kit \"" + kit + "\" is not available (" + path + ")"};
    auto bytes = std::make_shared<pkg::Files::Bytes>();
    std::vector<char> buf(64 * 1024);  // heap, not stack: the web build's stack is only 64 KB
    for (size_t n; (n = std::fread(buf.data(), 1, buf.size(), f)) > 0;) bytes->insert(bytes->end(), buf.begin(), buf.begin() + static_cast<long>(n));
    std::fclose(f);
    auto files = pkg::Files::from_pack(bytes);
    if (!files) return Error{"kit \"" + kit + "\": " + files.error()};
    packs.push_back(std::make_shared<const pkg::Files>(std::move(files).value()));
  }
  return script::kits_from_packs(std::move(packs));
}

struct Options {
  std::string package_dir = DREAMSY_DEMO_PACKAGE;
  render::ViewMode view = render::ViewMode::Side;
  int frames = 0;  // quit after this many frames (0 = run until closed)
  bool smooth = false;  // force smooth mode (linear filtering, no pixel snap) to check it on any package
  bool demo = false;    // renderer test scene instead of running the game
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
  std::shared_ptr<const pkg::Package> package;
  std::unique_ptr<script::Host> host;  // the running game (null in --demo)
  double accumulator = 0;              // unsimulated time, seconds
  uint64_t last_ticks = 0;
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
  app.package = std::shared_ptr<const pkg::Package>(std::move(loaded.package));
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
  if (app.options.demo) {
    app.scene = std::make_unique<player::DemoScene>(*app.package, *app.textures, app.style);
    return true;
  }
  script::HostOptions host_options;
  auto kits = load_kits(app.package->manifest);
  if (!kits) {
    log_error(kits.error());
    return false;
  }
  host_options.kits = std::move(kits).value();
  host_options.on_log = [](const script::LogLine& l) {
    (l.level == "error" ? log_error : l.level == "warn" ? log_warn : log_info)("[game] " + l.text);
  };
  auto host = script::Host::create(app.package, host_options);
  if (!host) {
    log_error("game failed to start: " + host.error());
    return false;
  }
  app.host = std::move(host).value();
  return true;
}

void set_view(App& app, render::ViewMode v);

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
  if (hash.rfind("demo", 0) == 0) {
    app.options.demo = true;
    hash = hash.size() > 5 ? hash.substr(5) : "";
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
  app.last_ticks = stm_now();
  if (app.host && app.options.view != render::ViewMode::Side) set_view(app, app.options.view);
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
  if (app.host) {
    // Fixed 60 Hz simulation, at most 5 ticks per frame (engine-web Game.advance).
    constexpr double kDt = 1.0 / 60.0;
    app.accumulator = std::min(app.accumulator + stm_sec(stm_laptime(&app.last_ticks)), kDt * 5);
    while (app.accumulator >= kDt - 1e-9) {
      app.accumulator -= kDt;
      app.host->step();
    }
    play::draw_world(*app.host, *app.textures, app.draw_list);
  } else {
    const double t = stm_sec(stm_since(app.start_ticks));
    app.scene->build(app.draw_list, app.view, t, app.renderer.stats());
  }
  app.renderer.draw(app.draw_list, *app.textures, *app.fonts, sglue_swapchain(), sapp_width(), sapp_height());
  sg_commit();

  app.frame_count++;
  if (app.options.frames > 0 && app.frame_count >= app.options.frames) {
    const render::FrameStats& s = app.renderer.stats();
    if (app.host) log_info("game time " + std::to_string(app.host->time()) + "s, " + std::to_string(app.host->world().count()) +
                           " entities, " + std::to_string(app.host->errors().size()) + " script errors");
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

// Keyboard -> the game's actions (a stand-in until E5's input system: touch, gamepad, gestures).
void game_key(App& app, sapp_keycode key, bool down) {
  if (!app.host) return;
  script::Input& in = app.host->input();
  auto axis = [&](const char* name, double v) { in.set_axis(name, down ? v : 0); };
  switch (key) {
    case SAPP_KEYCODE_LEFT: case SAPP_KEYCODE_A: axis("move_x", -1); break;
    case SAPP_KEYCODE_RIGHT: case SAPP_KEYCODE_D: axis("move_x", 1); break;
    case SAPP_KEYCODE_DOWN: case SAPP_KEYCODE_S: axis("move_y", 1); break;
    case SAPP_KEYCODE_W: axis("move_y", -1); break;
    case SAPP_KEYCODE_UP: case SAPP_KEYCODE_SPACE: in.set_button("jump", down); break;
    case SAPP_KEYCODE_Z: case SAPP_KEYCODE_J: in.set_button("action", down); break;
    case SAPP_KEYCODE_X: case SAPP_KEYCODE_K: in.set_button("action2", down); break;
    default: break;
  }
}

void set_view(App& app, render::ViewMode v) {
  app.view = v;
  if (app.host) app.host->world().view = static_cast<world::ViewMode>(static_cast<int>(v));
}

void event(const sapp_event* e) {
  App& app = *g_app;
  if (e->type == SAPP_EVENTTYPE_KEY_DOWN && !e->key_repeat) game_key(app, e->key_code, true);
  if (e->type == SAPP_EVENTTYPE_KEY_UP) game_key(app, e->key_code, false);
  if (e->type != SAPP_EVENTTYPE_KEY_DOWN) return;
  switch (e->key_code) {
    case SAPP_KEYCODE_ESCAPE: sapp_request_quit(); break;
    case SAPP_KEYCODE_1: set_view(app, render::ViewMode::Side); break;
    case SAPP_KEYCODE_2: set_view(app, render::ViewMode::TopDown); break;
    case SAPP_KEYCODE_3: set_view(app, render::ViewMode::Oblique); break;
    case SAPP_KEYCODE_4: set_view(app, render::ViewMode::Iso); break;
    case SAPP_KEYCODE_TAB: set_view(app, static_cast<render::ViewMode>((static_cast<int>(app.view) + 1) % 4)); break;
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
    } else if (arg == "--demo") {
      o.demo = true;
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
