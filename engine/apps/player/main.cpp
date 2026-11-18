// dreamsy-player: the windowed engine (web, macOS, later iOS/Android).
//
// Runs a game: the package's scripts at a fixed 60 Hz (script::Host: world, physics, tweens,
// animation, camera) and draws the world every frame (play::draw_world -> render::Renderer).
// --demo shows the E4 renderer test scene (demo_scene.h) instead.
//
//   dreamsy-player [package-dir] [--view side|topdown|oblique|iso] [--smooth] [--frames N] [--demo] [--touch]
//
// Input (src/input, play/platform_ui.h): arrows/WASD move, Space/Z jump (Up/W too in games that never
// read move_y), E/J/Enter/X action, Q/K/C action2; mouse and multi-touch drive input.pointer*, taps
// on UI and world, dialogs and (on touch devices, or with --touch / #touch) the on-screen controls.
// Esc/P pause. In game mode, keys 1-4 preview the world in another view mode (2.5D projection).
//
// --smooth forces smooth mode (linear filtering) on a pixel-art package. On the web the package
// is embedded at /pkg and the URL hash sets the options as dash-separated words
// (dreamsy-player.html#iso, #iso-smooth, #demo-iso, #touch). Keys: 1-4 pick the view mode, Tab cycles.
#include <algorithm>
#include <functional>
#include <map>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <optional>
#include <string>

#include "base/log.h"
#include "base/version.h"
#include "demo_scene.h"
#include "pkg/catalog.h"
#include "pkg/text.h"
#include "pkg/zip_import.h"
#include "input/usage.h"
#include "play/platform_ui.h"
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

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif
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

using Bytes = pkg::Files::Bytes;

// Reads a whole file (heap buffer: the web build's stack is small).
std::shared_ptr<Bytes> read_file(const std::string& path) {
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return nullptr;
  auto bytes = std::make_shared<Bytes>();
  std::vector<char> buf(64 * 1024);
  for (size_t n; (n = std::fread(buf.data(), 1, buf.size(), f)) > 0;) bytes->insert(bytes->end(), buf.begin(), buf.begin() + static_cast<long>(n));
  std::fclose(f);
  return bytes;
}

// Kit pack bytes by kit name: from DREAMSY_KIT_PACKS_DIR natively, or fetched over HTTP on the web.
using KitBytes = std::function<std::shared_ptr<Bytes>(const std::string& kit)>;

std::shared_ptr<Bytes> kit_from_disk(const std::string& kit) {
  return read_file(std::string(DREAMSY_KIT_PACKS_DIR) + "/" + kit + ".dpk");
}

std::vector<std::string> kits_of(const pkg::Manifest& m) {
  return pkg::Catalog::get().expand_kits(m.kits.value_or(std::vector<std::string>{}));
}

// The kits a game enables (and their dependencies), each a <kit>.dpk. Kit code isn't in the
// player binary (script/kits.h); only what a game uses is loaded.
// `kit_sources` receives every kit script, for the input-usage scan (input/usage.h).
Result<script::KitLookup> load_kits(const pkg::Manifest& m, const KitBytes& kit_bytes, std::string& kit_sources) {
  std::vector<std::shared_ptr<const pkg::Files>> packs;
  for (const std::string& kit : kits_of(m)) {
    std::shared_ptr<Bytes> bytes = kit_bytes(kit);
    if (!bytes) return Error{"kit \"" + kit + "\" is not available"};
    auto files = pkg::Files::from_pack(bytes);
    if (!files) return Error{"kit \"" + kit + "\": " + files.error()};
    for (const std::string& file : files.value().paths("kits/")) {
      if (auto text = files.value().text(file)) kit_sources.append(*text);
    }
    packs.push_back(std::make_shared<const pkg::Files>(std::move(files).value()));
  }
  return script::kits_from_packs(std::move(packs));
}

struct Options {
  std::string package_dir = DREAMSY_DEMO_PACKAGE;  // a directory, a .dpk or a .zip
  std::string package_url;                          // web: ?pkg=<url> (.dpk or .zip), fetched at start
  std::string kits_url = "kits/";                   // web: where <kit>.dpk files are (?kits=<url>)
  // Forces a view mode (dev: --view / #iso / keys 1-4). Unset = the scene's own view (manifest
  // or scene `view`, DREAMSY.MD §14.5).
  std::optional<render::ViewMode> view;
  int frames = 0;  // quit after this many frames (0 = run until closed)
  bool smooth = false;  // force smooth mode (linear filtering, no pixel snap) to check it on any package
  bool demo = false;    // renderer test scene instead of running the game
  bool touch = false;   // force the on-screen controls (they show by default on touch devices only)
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
  std::unique_ptr<play::PlatformUi> ui;  // input routing, UI entities, dialogs, controls (with host)
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
  bool loading = false;  // web: waiting for ?pkg= / kit downloads
  std::map<std::string, std::shared_ptr<Bytes>> fetched_kits;
};

std::unique_ptr<App> g_app;

// A package from a directory, a .dpk or a .zip (bytes already read for the last two).
Result<pkg::Files> open_package(const std::string& name, std::shared_ptr<Bytes> bytes) {
  if (!bytes) return pkg::Files::from_dir(name);
  if (pkg::ends_with(name, ".zip")) return pkg::import_zip(*bytes);
  return pkg::Files::from_pack(std::move(bytes));
}

// Validates the package and starts the game (or the --demo scene).
bool start(App& app, pkg::Files files, const KitBytes& kit_bytes) {
  pkg::LoadResult loaded = pkg::load_package(std::move(files));
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
  std::string kit_sources;
  auto kits = load_kits(app.package->manifest, kit_bytes, kit_sources);
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

  // Which controls the game reads (engine-web detectInputUsage), and whether Up/W also jump.
  std::string game_scripts;
  for (const std::string& path : app.package->files.paths("scripts/")) {
    if (auto text = app.package->files.text(path)) game_scripts.append(*text);
  }
  const input::InputUsage usage = input::detect_input_usage(game_scripts + kit_sources);
  bool touch = app.options.touch;
#ifdef __EMSCRIPTEN__
  touch = touch || emscripten_run_script_int("('ontouchstart' in window || navigator.maxTouchPoints > 0) ? 1 : 0") != 0;
#elif defined(__ANDROID__) || (defined(__APPLE__) && TARGET_OS_IPHONE)
  touch = true;
#endif
  app.ui = std::make_unique<play::PlatformUi>(*app.host, *app.textures, *app.fonts, usage,
                                              !input::scripts_mention_move_y(game_scripts), touch);
  if (Status s = app.ui->init(); !s) {
    log_error(s.error());
    return false;
  }
  return true;
}

// Native/embedded: the package is a local path.
bool load(App& app) {
  const std::string& name = app.options.package_dir;
  std::shared_ptr<Bytes> bytes;
  if (pkg::ends_with(name, ".dpk") || pkg::ends_with(name, ".zip")) {
    bytes = read_file(name);
    if (!bytes) {
      log_error("can't read " + name);
      return false;
    }
  }
  auto files = open_package(name, std::move(bytes));
  if (!files) {
    log_error("can't open package " + name + ": " + files.error());
    return false;
  }
  return start(app, std::move(files).value(), kit_from_disk);
}

void set_view(App& app, render::ViewMode v);
void finish_init(App& app);

#ifdef __EMSCRIPTEN__
// Web: ?pkg=<url> loads a package over HTTP, then each kit it enables from <kits_url><kit>.dpk.
struct Download {
  std::string what;  // "" = the package, else a kit name
};
std::shared_ptr<Bytes> g_package_bytes;
std::vector<std::string> g_kits_to_fetch;

void fetch_next(App& app);

void on_fetch_error(void* arg) {
  std::unique_ptr<Download> d(static_cast<Download*>(arg));
  log_error(d->what.empty() ? "can't download " + g_app->options.package_url : "can't download kit \"" + d->what + "\"");
  g_app->loading = false;
}

void on_fetch(void* arg, void* data, int size) {
  std::unique_ptr<Download> d(static_cast<Download*>(arg));
  auto bytes = std::make_shared<Bytes>(static_cast<uint8_t*>(data), static_cast<uint8_t*>(data) + size);
  App& app = *g_app;
  if (d->what.empty()) {
    g_package_bytes = bytes;
    // Peek at the manifest to learn which kits to fetch.
    auto files = open_package(app.options.package_url, bytes);
    if (!files) {
      log_error("can't open " + app.options.package_url + ": " + files.error());
      app.loading = false;
      return;
    }
    pkg::LoadResult peek = pkg::load_package(std::move(files).value());
    if (peek.ok) g_kits_to_fetch = kits_of(peek.package->manifest);
  } else {
    app.fetched_kits[d->what] = bytes;
  }
  fetch_next(app);
}

void fetch_next(App& app) {
  if (!g_kits_to_fetch.empty()) {
    std::string kit = g_kits_to_fetch.back();
    g_kits_to_fetch.pop_back();
    std::string url = app.options.kits_url + kit + ".dpk";
    emscripten_async_wget_data(url.c_str(), new Download{kit}, on_fetch, on_fetch_error);
    return;
  }
  app.loading = false;
  auto files = open_package(app.options.package_url, g_package_bytes);
  if (!files) {
    log_error("can't open " + app.options.package_url + ": " + files.error());
    return;
  }
  auto kit_bytes = [&app](const std::string& kit) -> std::shared_ptr<Bytes> {
    auto it = app.fetched_kits.find(kit);
    return it == app.fetched_kits.end() ? nullptr : it->second;
  };
  if (start(app, std::move(files).value(), kit_bytes)) finish_init(app);
}
#endif

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
  // dreamsy-player.html#<words>: a view mode, "smooth", "demo", "touch", separated by dashes.
  const std::string hash = emscripten_run_script_string("window.location.hash.slice(1)");
  for (size_t start = 0; start <= hash.size();) {
    size_t end = hash.find('-', start);
    if (end == std::string::npos) end = hash.size();
    const std::string word = hash.substr(start, end - start);
    if (word == "smooth") app.options.smooth = true;
    else if (word == "demo") app.options.demo = true;
    else if (word == "touch") app.options.touch = true;
    else if (auto v = parse_view(word.c_str())) app.options.view = *v;
    start = end + 1;
  }
#endif
  app.view = app.options.view.value_or(render::ViewMode::Side);

#ifdef __EMSCRIPTEN__
  // ?pkg=<url to a .dpk or .zip>[&kits=<base url>]: load a game over HTTP instead of the embedded one.
  app.options.package_url = emscripten_run_script_string("new URLSearchParams(location.search).get('pkg') || ''");
  const std::string kits = emscripten_run_script_string("new URLSearchParams(location.search).get('kits') || ''");
  if (!kits.empty()) app.options.kits_url = kits.back() == '/' ? kits : kits + "/";
  if (!app.options.package_url.empty()) {
    app.loading = true;
    log_info("downloading " + app.options.package_url);
    emscripten_async_wget_data(app.options.package_url.c_str(), new Download{""}, on_fetch, on_fetch_error);
    return;
  }
#endif
  if (!load(app)) return;
  finish_init(app);
}

// After the package is loaded: renderer, first frame timing, view mode.
void finish_init(App& app) {
  if (Status s = app.renderer.init(app.style); !s) {
    log_error(s.error());
    return;
  }
  app.ok = true;
  app.last_ticks = stm_now();
  if (app.host && app.options.view) set_view(app, *app.options.view);
  if (app.host && !app.options.view) app.view = static_cast<render::ViewMode>(static_cast<int>(app.host->world().view));
  log_info("package \"" + app.package->manifest.name + "\": reference " + std::to_string(app.style.ref_w) + "x" +
           std::to_string(app.style.ref_h) + (app.style.pixel_snap ? ", pixel-art mode" : ", smooth mode"));
}

void frame() {
  App& app = *g_app;
  if (!app.ok) {
    // Still downloading: dark grey. Nothing loaded: dark red, so the failure is visible.
    sg_pass pass{};
    pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
    pass.action.colors[0].clear_value = app.loading ? sg_color{0.08f, 0.08f, 0.1f, 1} : sg_color{0.3f, 0.05f, 0.08f, 1};
    pass.swapchain = sglue_swapchain();
    sg_begin_pass(&pass);
    sg_end_pass();
    sg_commit();
    return;
  }
  if (app.host) {
    // Layout points per reference px: the game rect's scale over the display's pixel density
    // (on the web, CSS px per game px). Safe-area insets: TODO(E9), read from the platform.
    const render::Fit fit = render::fit_rect(app.style.ref_w, app.style.ref_h, static_cast<float>(sapp_width()),
                                             static_cast<float>(sapp_height()));
    app.ui->set_screen(fit.s / std::max(0.5f, sapp_dpi_scale()), {});
    // Fixed 60 Hz simulation, at most 5 ticks per frame (engine-web Game.advance). Paused: no ticks.
    constexpr double kDt = 1.0 / 60.0;
    const double elapsed = stm_sec(stm_laptime(&app.last_ticks));
    if (app.host->paused()) {
      app.accumulator = 0;
    } else {
      app.accumulator = std::min(app.accumulator + elapsed, kDt * 5);
    }
    while (app.accumulator >= kDt - 1e-9) {
      app.accumulator -= kDt;
      app.host->step();
    }
    app.ui->update(static_cast<float>(elapsed));
    play::draw_world(*app.host, *app.textures, app.draw_list);
    app.ui->draw(app.draw_list, stm_sec(stm_since(app.start_ticks)));
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

// sokol key codes -> the keys the engine maps (input/keyboard.h).
input::Key key_of(sapp_keycode k) {
  switch (k) {
    case SAPP_KEYCODE_LEFT: return input::Key::Left;
    case SAPP_KEYCODE_RIGHT: return input::Key::Right;
    case SAPP_KEYCODE_UP: return input::Key::Up;
    case SAPP_KEYCODE_DOWN: return input::Key::Down;
    case SAPP_KEYCODE_A: return input::Key::A;
    case SAPP_KEYCODE_C: return input::Key::C;
    case SAPP_KEYCODE_D: return input::Key::D;
    case SAPP_KEYCODE_E: return input::Key::E;
    case SAPP_KEYCODE_J: return input::Key::J;
    case SAPP_KEYCODE_K: return input::Key::K;
    case SAPP_KEYCODE_Q: return input::Key::Q;
    case SAPP_KEYCODE_S: return input::Key::S;
    case SAPP_KEYCODE_W: return input::Key::W;
    case SAPP_KEYCODE_X: return input::Key::X;
    case SAPP_KEYCODE_Z: return input::Key::Z;
    case SAPP_KEYCODE_SPACE: return input::Key::Space;
    case SAPP_KEYCODE_ENTER: case SAPP_KEYCODE_KP_ENTER: return input::Key::Enter;
    case SAPP_KEYCODE_ESCAPE: return input::Key::Escape;
    case SAPP_KEYCODE_P: return input::Key::P;
    default: return input::Key::Other;
  }
}

// Window events -> the platform UI (keys, mouse, touches, focus), positions in reference px.
void game_event(App& app, const sapp_event* e) {
  if (!app.ui) return;
  play::PlatformUi& ui = *app.ui;
  auto ref = [&](float x, float y) {
    const render::Vec2 p = render::framebuffer_to_ref(app.renderer.fit(), {x, y});
    return input::Vec2{p.x, p.y};
  };
  switch (e->type) {
    case SAPP_EVENTTYPE_KEY_DOWN:
      if (!e->key_repeat) ui.key(key_of(e->key_code), true);
      break;
    case SAPP_EVENTTYPE_KEY_UP: ui.key(key_of(e->key_code), false); break;
    case SAPP_EVENTTYPE_UNFOCUSED: ui.blur(); break;
    case SAPP_EVENTTYPE_MOUSE_DOWN:
      if (e->mouse_button == SAPP_MOUSEBUTTON_LEFT) ui.pointer(play::PointerPhase::Down, play::kMousePointerId, ref(e->mouse_x, e->mouse_y));
      break;
    case SAPP_EVENTTYPE_MOUSE_MOVE: ui.pointer(play::PointerPhase::Move, play::kMousePointerId, ref(e->mouse_x, e->mouse_y)); break;
    case SAPP_EVENTTYPE_MOUSE_UP:
      if (e->mouse_button == SAPP_MOUSEBUTTON_LEFT) ui.pointer(play::PointerPhase::Up, play::kMousePointerId, ref(e->mouse_x, e->mouse_y));
      break;
    case SAPP_EVENTTYPE_MOUSE_SCROLL: ui.wheel(ref(e->mouse_x, e->mouse_y), -e->scroll_y * 40); break;
    case SAPP_EVENTTYPE_TOUCHES_BEGAN:
    case SAPP_EVENTTYPE_TOUCHES_MOVED:
    case SAPP_EVENTTYPE_TOUCHES_ENDED:
    case SAPP_EVENTTYPE_TOUCHES_CANCELLED: {
      const play::PointerPhase phase = e->type == SAPP_EVENTTYPE_TOUCHES_BEGAN   ? play::PointerPhase::Down
                                       : e->type == SAPP_EVENTTYPE_TOUCHES_MOVED ? play::PointerPhase::Move
                                       : e->type == SAPP_EVENTTYPE_TOUCHES_ENDED ? play::PointerPhase::Up
                                                                                 : play::PointerPhase::Cancel;
      for (int i = 0; i < e->num_touches; i++) {
        const sapp_touchpoint& t = e->touches[i];
        if (!t.changed) continue;
        ui.pointer(phase, static_cast<int64_t>(t.identifier), ref(t.pos_x, t.pos_y));
      }
      break;
    }
    default: break;
  }
}

void set_view(App& app, render::ViewMode v) {
  app.view = v;
  if (app.host) app.host->world().view = static_cast<world::ViewMode>(static_cast<int>(v));
}

void event(const sapp_event* e) {
  App& app = *g_app;
  game_event(app, e);
  if (e->type != SAPP_EVENTTYPE_KEY_DOWN) return;
  switch (e->key_code) {
    case SAPP_KEYCODE_ESCAPE:
      if (!app.host) sapp_request_quit();  // the demo quits; games pause (platform UI)
      break;
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
    } else if (arg == "--touch") {
      o.touch = true;
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
  const bool archive = pkg::ends_with(o.package_dir, ".dpk") || pkg::ends_with(o.package_dir, ".zip");
  if (auto files = open_package(o.package_dir, archive ? read_file(o.package_dir) : nullptr)) {
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
