// The script host: runs a package's Luau scripts with the platform API (format/LUAU_API.md).
//
// A port of engine-web/core/game.ts's scripting half (DREAMSY.MD §14.13). The prelude
// (engine-web/core/prelude.ts, embedded at build time) builds the public API in Luau and calls
// numbered host ops, which are implemented here, natively. Same op numbers, value tags, script
// order and tick order as engine-web, so the two engines can be compared op by op.
//
// Slice E2 covers everything that doesn't need entities: scripts, modules, kits, timers, onTick,
// game signals, random, time, save data, package data, scenes, audio/store/settings events, the
// offline room. Entity ops (GET/SET/CALL/SPAWN/...) raise a clear error until the world arrives
// in E3, and attached scripts (which need their entity) don't run yet.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

#include "base/result.h"
#include "base/rng.h"
#include "pkg/package.h"
#include "script/json_value.h"
#include "script/vm.h"

namespace dreamsy::script {

struct HostOptions {
  uint32_t seed = 1;
  double budget_ms = 250;
  size_t memory_limit = 64u * 1024 * 1024;
  double tick_rate = 60;
  std::function<double()> clock;             // unix seconds for clock.now(); default: wall clock
  std::optional<std::string> scene;          // start here instead of entry_scene (tools/tests)
  std::optional<Json> scene_params;
  Json save;                                 // initial save data (an object)
  std::function<void(const struct LogLine&)> on_log;
};

struct LogLine {
  double time = 0;
  std::string level;  // "info" | "warn" | "error"
  std::string text;
  std::string script;
};

struct ScriptError {
  std::string script;
  int line = 0;  // 0 = unknown
  std::string message;
  std::string traceback;
  int count = 1;
  double time = 0;
};

struct AudioEvent {
  std::string kind;  // "sfx" | "music" | "music_stop"
  std::string id;
  double volume = 1, pitch = 1, fade = 0, time = 0;
};

struct Settings {
  double music = 0.7, sfx = 0.9;
  bool mute = false, vibration = true;
};

class Host {
 public:
  // The package must be valid (pkg::load_package). Runs the prelude and the session scripts.
  static Result<std::unique_ptr<Host>> create(std::shared_ptr<const pkg::Package> package, HostOptions options = {});
  ~Host();

  // One fixed simulation tick (engine-web Game.step order).
  void step();

  double time() const { return time_; }
  int64_t tick() const { return tick_; }
  const std::string& scene() const { return scene_path_; }
  const std::vector<LogLine>& logs() const { return logs_; }
  const std::vector<ScriptError>& errors() const { return errors_; }
  const std::vector<AudioEvent>& audio_events() const { return audio_; }
  const Json& save_data() const { return save_; }
  double time_scale() const { return time_scale_; }
  size_t memory_used() const { return vm_->memory_used(); }

  Settings settings;

 private:
  struct ScriptInst {
    std::string path;
  };
  struct TickCb {
    int64_t id;
    int ref;
    ScriptInst* inst;
  };
  struct Timer {
    int64_t id;
    double due;
    double interval;
    int ref;
    ScriptInst* inst;
    int64_t seq;
  };
  struct Conn {
    int64_t id;
    double entity;  // 0 = game-level signal
    std::string signal;
    int ref;
    ScriptInst* inst;
  };
  struct Refs {
    int make_script = 0, proxy = 0, flush = 0, start = 0, invoke = 0, player = 0, scene_set = 0, done_fire = 0;
  };

  Host(std::shared_ptr<const pkg::Package> package, HostOptions options);
  Status init();

  static int host_call(lua_State* L);
  int dispatch(lua_State* L);
  int net_op(lua_State* L);
  [[noreturn]] void not_yet(lua_State* L, const char* api);

  void run_script(const std::string& path);
  void setup_script_globals(lua_State* T, const std::string& path);
  void call_ref(int ref, ScriptInst* inst, int nargs, const std::function<void(lua_State*)>& push_args = {});
  void fire(double entity, const std::string& signal, const std::function<int(lua_State*)>& push_args);
  void record_error(std::string message, const std::string& traceback, const std::string& fallback_script);
  void log(const std::string& level, const std::string& text, const std::string& script = {});

  std::string resolve_module(lua_State* L, const std::string& from, const std::string& name);
  void require_module(lua_State* L, const std::string& from, const std::string& name);
  std::optional<std::string_view> kit_source(const std::string& path) const;

  void process_scene_change();
  void switch_scene(const std::string& path);
  void remove_timer(int64_t id, bool unref);
  int ref_function(lua_State* L, int index, const std::string& what);
  ScriptInst* inst();
  void write_save(lua_State* L, Json next);

  std::shared_ptr<const pkg::Package> pkg_;
  HostOptions options_;
  std::unique_ptr<Vm> vm_;
  Rng rng_;
  Refs refs_;
  std::vector<std::string> enabled_kits_;

  double dt_;
  double time_ = 0;
  double time_scale_ = 1;
  int64_t tick_ = 0;
  int64_t next_id_ = 1;
  std::string scene_path_;
  std::optional<std::string> pending_scene_;

  std::vector<std::unique_ptr<ScriptInst>> scripts_;
  ScriptInst session_inst_{"(session)"};
  ScriptInst unknown_inst_{"?"};
  ScriptInst* current_ = nullptr;
  std::vector<TickCb> ticks_;
  std::vector<Timer> timers_;
  std::map<int64_t, Conn> conns_;  // id order = creation order
  std::unordered_map<std::string, int> modules_;
  std::set<std::string> loading_modules_;
  std::unordered_map<std::string, Json> file_cache_;

  std::vector<LogLine> logs_;
  std::vector<ScriptError> errors_;
  std::vector<AudioEvent> audio_;
  std::optional<std::string> music_id_;
  Json save_;

  // store (in-memory host, like MemoryStoreHost)
  std::set<std::string> store_owned_;   // delivered passes (what store.owns() sees)
  std::set<std::string> store_passes_;  // passes bought from the in-memory store
  struct Purchase {
    std::string item_id, purchase_id;
  };
  std::vector<Purchase> store_pending_, store_queue_;
  int store_next_ = 1;

  // offline room (engine-web NetSession without a link)
  int net_dispatch_ref_ = 0;
  Json room_state_ = Json::object_value();
  Json room_scores_ = room_state_;
  struct NetMsg {
    std::string kind;
    std::string key;
    Json value;
  };
  std::vector<NetMsg> net_inbox_;
  bool net_ended_ = false;
};

}  // namespace dreamsy::script
