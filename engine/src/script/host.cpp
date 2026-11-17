#include "script/host.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <set>

#include "lua.h"
#include "lualib.h"
#include "pkg/catalog.h"
#include "pkg/json.h"
#include "pkg/text.h"
#include "script/lua_util.h"
#include "script/require_path.h"
#include "script/script_data.h"
#include "script/theme.h"

namespace dreamsy::script {

namespace {

// Op numbers and value tags: engine-web/core/prelude.ts OP / TAG (the prelude is embedded from there).
enum Op {
  OP_INIT = 1, OP_PRINT = 2, OP_GET = 3, OP_SET = 4, OP_CALL = 5, OP_ENTITY = 6, OP_TAGGED = 7, OP_SPAWN = 8,
  OP_ONTICK = 9, OP_AFTER = 10, OP_EVERY = 11, OP_CANCEL = 12, OP_RANDOM = 13, OP_TIME = 14,
  OP_CONNECT = 15, OP_DISCONNECT = 16, OP_AXIS = 17, OP_PRESSED = 18, OP_HELD = 19, OP_POINTER = 20,
  OP_TOAST = 21, OP_SCREEN = 22, OP_AVATAR = 23, OP_FROMENTITY = 24, OP_REQUIRE = 25, OP_ERROR = 26, OP_SOUND = 27,
  OP_LOADSCENE = 28, OP_STORE = 29, OP_AUDIO = 30, OP_SETTINGS = 31, OP_TWEEN = 32, OP_SAVE = 33, OP_DIALOG = 34,
  OP_CAMERA = 35, OP_FILES = 36, OP_CLOCK = 37, OP_GAMEPROP = 38, OP_ALIVE = 39, OP_UNTICK = 40,
  OP_LEADERBOARD = 41, OP_PLATFORM = 42, OP_NET = 60,
};
enum Tag { TAG_PLAIN = 0, TAG_VEC2 = 1 };

constexpr int kMaxSceneChain = 8;
constexpr size_t kMaxSaveBytes = 64 * 1024;
constexpr size_t kMaxLogs = 500;

double wall_clock() {
  using namespace std::chrono;
  return duration<double>(system_clock::now().time_since_epoch()).count();
}

}  // namespace

// ================================================================ setup

Host::Host(std::shared_ptr<const pkg::Package> package, HostOptions options)
    : pkg_(std::move(package)), options_(std::move(options)), rng_(options_.seed), dt_(1.0 / options_.tick_rate) {
  save_ = options_.save;
  if (save_.type != Json::Type::Object) save_ = Json::object_value();
}

Host::~Host() = default;

Result<std::unique_ptr<Host>> Host::create(std::shared_ptr<const pkg::Package> package, HostOptions options) {
  if (!package) return Error{"no package"};
  std::unique_ptr<Host> host(new Host(std::move(package), std::move(options)));
  if (Status s = host->init(); !s) return Error{s.error()};
  return host;
}

Status Host::init() {
  const pkg::Manifest& m = pkg_->manifest;
  enabled_kits_ = pkg::Catalog::get().expand_kits(m.kits.value_or(std::vector<std::string>{}));
  scene_path_ = options_.scene.value_or(m.entry_scene);
  if (!pkg_->scenes.count(scene_path_)) return Error{"no scene " + scene_path_};

  vm_ = Vm::create({options_.memory_limit, options_.budget_ms});
  lua_State* L = vm_->main();
  lua_pushlightuserdata(L, this);
  lua_pushcclosure(L, &Host::host_call, "host", 1);
  lua_setglobal(L, "__host");

  if (Status s = vm_->load(L, "=dreamsy", data::prelude()); !s) return Error{"prelude failed to compile: " + s.error()};
  if (auto err = vm_->pcall(L, 0, 0)) return Error{"prelude failed: " + err->message + "\n" + err->traceback};
  lua_settop(L, 0);
  vm_->sandbox();

  call_ref(refs_.scene_set, nullptr, 2, [&](lua_State* S) {
    push_str(S, scene_path_);
    if (options_.scene_params) push_json(S, *options_.scene_params);
    else lua_pushnil(S);
  });
  // buildScene: entities and their attached scripts arrive with the world (E3).

  // Unattached client/server scripts: the session (they survive loadScene).
  std::set<std::string> attached;
  for (const auto& [path, scene] : pkg_->scenes)
    for (const pkg::EntityDef& e : scene.entities) attached.insert(e.scripts.begin(), e.scripts.end());
  for (const char* dir : {"scripts/server/", "scripts/client/"}) {
    for (const std::string& p : pkg_->files.paths(dir))
      if (pkg::ends_with(p, ".luau") && !attached.count(p)) run_script(p);
  }
  call_ref(refs_.start, nullptr, 0);
  fire(0, "sceneLoaded", [&](lua_State* S) {
    push_str(S, scene_path_);
    return 1;
  });
  process_scene_change();
  return Status::success();
}

// ================================================================ scripts

void Host::log(const std::string& level, const std::string& text, const std::string& script) {
  LogLine line{time_, level, text, script};
  if (options_.on_log) options_.on_log(line);
  logs_.push_back(std::move(line));
  if (logs_.size() > kMaxLogs) logs_.erase(logs_.begin(), logs_.begin() + static_cast<long>(logs_.size() - kMaxLogs));
}

void Host::record_error(std::string message, const std::string& traceback, const std::string& fallback_script) {
  // "scripts/x.luau:12: msg" -> script, line, msg; else the first scripts/...luau:N in the traceback.
  auto parse_location = [](std::string_view s, size_t at, std::string* script, int* line) -> size_t {
    if (!pkg::starts_with(s.substr(at), "scripts/")) return std::string_view::npos;
    size_t colon = s.find(':', at);
    if (colon == std::string_view::npos) return std::string_view::npos;
    std::string_view path = s.substr(at, colon - at);
    if (!pkg::ends_with(path, ".luau") || path.find_first_of(" \t\n\r") != std::string_view::npos) return std::string_view::npos;
    size_t k = colon + 1, start = k;
    while (k < s.size() && pkg::is_digit(s[k])) ++k;
    if (k == start) return std::string_view::npos;
    *script = std::string(path);
    *line = std::atoi(std::string(s.substr(start, k - start)).c_str());
    return k;
  };
  std::string script = fallback_script;
  int line = 0;
  size_t end = parse_location(message, 0, &script, &line);
  if (end != std::string::npos && end + 1 < message.size() && message[end] == ':' && message[end + 1] == ' ') {
    message = message.substr(end + 2);
  } else {
    script = fallback_script;
    line = 0;
    for (size_t at = traceback.find("scripts/"); at != std::string::npos; at = traceback.find("scripts/", at + 1)) {
      if (parse_location(traceback, at, &script, &line) != std::string::npos) break;
      script = fallback_script;
      line = 0;
    }
  }
  for (ScriptError& e : errors_) {
    if (e.script == script && e.line == line && e.message == message) {
      ++e.count;
      return;
    }
  }
  errors_.push_back({script, line, message, traceback, 1, time_});
  log("error", script + (line ? ":" + std::to_string(line) : "") + ": " + message, script);
}

void Host::run_script(const std::string& path) {
  scripts_.push_back(std::make_unique<ScriptInst>(ScriptInst{path}));
  ScriptInst* script = scripts_.back().get();
  auto src = pkg_->files.text(path);
  if (!src) {
    record_error("script " + path + " does not exist", "", path);
    return;
  }
  lua_State* L = vm_->main();
  int top = lua_gettop(L);
  lua_State* T = vm_->new_sandbox_thread();
  if (Status s = vm_->load(T, "@" + path, *src); !s) {
    record_error(s.error(), "", path);
    lua_settop(L, top);
    return;
  }
  setup_script_globals(T, path);
  ScriptInst* prev = current_;
  current_ = script;
  auto err = vm_->pcall(T, 0, 0);
  current_ = prev;
  if (err) record_error(err->message, err->traceback, path);
  lua_settop(L, top);
}

void Host::setup_script_globals(lua_State* T, const std::string& path) {
  lua_State* L = vm_->main();
  lua_getref(L, refs_.make_script);
  lua_pushnil(L);  // owner entity: none until E3
  push_str(L, path);
  if (auto err = vm_->pcall(L, 2, 2)) DREAMSY_CHECK(false, "prelude makeScript failed");
  lua_xmove(L, T, 2);
  lua_setglobal(T, "require");
  lua_setglobal(T, "script");
}

void Host::call_ref(int ref, ScriptInst* inst, int nargs, const std::function<void(lua_State*)>& push_args) {
  if (!ref) return;
  lua_State* L = vm_->main();
  int top = lua_gettop(L);
  lua_getref(L, ref);
  if (push_args) push_args(L);
  ScriptInst* prev = current_;
  current_ = inst;
  auto err = vm_->pcall(L, nargs, 0);
  current_ = prev;
  if (err) record_error(err->message, err->traceback, inst ? inst->path : "?");
  lua_settop(L, top);
}

void Host::fire(double entity, const std::string& signal, const std::function<int(lua_State*)>& push_args) {
  std::vector<int64_t> ids;
  for (const auto& [id, c] : conns_)
    if (c.entity == entity && c.signal == signal) ids.push_back(id);
  for (int64_t id : ids) {
    auto it = conns_.find(id);
    if (it == conns_.end()) continue;  // disconnected by an earlier handler
    Conn c = it->second;
    lua_State* L = vm_->main();
    int top = lua_gettop(L);
    lua_getref(L, c.ref);
    int n = push_args(L);
    ScriptInst* prev = current_;
    current_ = c.inst;
    auto err = vm_->pcall(L, n, 0);
    current_ = prev;
    if (err) record_error(err->message, err->traceback, c.inst->path);
    lua_settop(L, top);
  }
}

Host::ScriptInst* Host::inst() { return current_ ? current_ : &unknown_inst_; }

int Host::ref_function(lua_State* L, int index, const std::string& what) {
  if (lua_type(L, index) != LUA_TFUNCTION) raise(L, what + " expects a function");
  return lua_ref(L, index);
}

void Host::remove_timer(int64_t id, bool unref) {
  auto it = std::find_if(timers_.begin(), timers_.end(), [&](const Timer& t) { return t.id == id; });
  if (it == timers_.end()) return;
  int ref = it->ref;
  timers_.erase(it);
  if (unref) lua_unref(vm_->main(), ref);
}

// ================================================================ require

std::optional<std::string_view> Host::kit_source(const std::string& path) const {
  auto kits = data::kit_sources();
  auto it = std::lower_bound(kits.begin(), kits.end(), path, [](const data::KitSource& k, const std::string& p) { return k.path < p; });
  if (it == kits.end() || it->path != path) return std::nullopt;
  return it->source;
}

std::string Host::resolve_module(lua_State* L, const std::string& from, const std::string& name) {
  auto path = resolve_require(from, name, enabled_kits_, [this](const std::string& p) { return kit_source(p).has_value(); });
  if (!path) raise(L, path.error());
  return std::move(path).value();
}

void Host::require_module(lua_State* L, const std::string& from, const std::string& name) {
  std::string path = resolve_module(L, from, name);
  if (auto it = modules_.find(path); it != modules_.end()) {
    lua_getref(L, it->second);
    return;
  }
  const std::string req = "require(\"" + name + "\")";
  if (loading_modules_.count(path)) raise(L, req + ": circular require of " + path);
  std::optional<std::string_view> src = pkg::starts_with(path, "kits/") ? kit_source(path) : pkg_->files.text(path);
  if (!src) raise(L, req + ": module " + path + " not found");

  lua_State* M = vm_->main();
  int top = lua_gettop(M);
  loading_modules_.insert(path);
  std::optional<std::string> failure;
  lua_State* T = vm_->new_sandbox_thread();
  if (Status s = vm_->load(T, "@" + path, *src); !s) {
    failure = s.error();
  } else {
    setup_script_globals(T, path);
    // Module top level belongs to the session: its onTick/timers/connections survive the requirer.
    ScriptInst* prev = current_;
    current_ = &session_inst_;
    auto err = vm_->pcall(T, 0, 1);
    current_ = prev;
    if (err) failure = err->message;
    else modules_[path] = lua_ref(T, -1);
  }
  loading_modules_.erase(path);
  lua_settop(M, top);
  if (failure) raise(L, *failure);
  lua_getref(L, modules_.at(path));
}

// ================================================================ ticks and scenes

void Host::step() {
  ++tick_;
  const double sdt = dt_ * time_scale_;
  time_ += sdt;
  call_ref(refs_.flush, nullptr, 0);

  // offline room: kv/score/ended messages queued by scripts, delivered at tick start
  if (!net_inbox_.empty() && net_dispatch_ref_) {
    std::vector<NetMsg> msgs = std::move(net_inbox_);
    net_inbox_.clear();
    for (const NetMsg& m : msgs) {
      call_ref(net_dispatch_ref_, nullptr, m.kind == "ended" ? 2 : 3, [&](lua_State* S) {
        push_str(S, m.kind);
        if (m.kind == "ended") {
          push_json(S, m.value);
        } else {
          push_str(S, m.key);
          push_json(S, m.value);
        }
      });
    }
  }

  // store purchases resolved last tick
  if (!store_queue_.empty()) {
    std::vector<Purchase> q = std::move(store_queue_);
    store_queue_.clear();
    for (const Purchase& p : q) {
      auto item = std::find_if(pkg_->manifest.store.begin(), pkg_->manifest.store.end(),
                               [&](const pkg::StoreItem& i) { return i.id == p.item_id; });
      if (item != pkg_->manifest.store.end() && item->kind == "pass") store_owned_.insert(p.item_id);
      else if (std::none_of(store_pending_.begin(), store_pending_.end(),
                            [&](const Purchase& x) { return x.purchase_id == p.purchase_id; }))
        store_pending_.push_back(p);
      fire(0, "storePurchased", [&](lua_State* S) {
        push_str(S, p.item_id);
        push_str(S, p.purchase_id);
        return 2;
      });
    }
  }

  // timers: due time, then creation order; `every` reschedules before its call
  for (;;) {
    Timer* best = nullptr;
    for (Timer& t : timers_) {
      if (t.due <= time_ + 1e-9 && (!best || t.due < best->due || (t.due == best->due && t.seq < best->seq))) best = &t;
    }
    if (!best) break;
    Timer t = *best;
    if (t.interval > 0) {
      best->due += t.interval;
      best->seq = next_id_++;
    } else {
      remove_timer(t.id, false);
    }
    call_ref(t.ref, t.inst, 0);
    if (t.interval <= 0) lua_unref(vm_->main(), t.ref);
  }

  // onTick: a snapshot; callbacks removed mid-iteration are skipped, new ones start next tick
  std::vector<TickCb> snapshot = ticks_;
  for (const TickCb& cb : snapshot) {
    bool alive = std::any_of(ticks_.begin(), ticks_.end(), [&](const TickCb& t) { return t.id == cb.id; });
    if (!alive) continue;
    call_ref(cb.ref, cb.inst, 1, [&](lua_State* S) { lua_pushnumber(S, sdt); });
  }
  process_scene_change();
}

void Host::process_scene_change() {
  for (int i = 0; pending_scene_ && i < kMaxSceneChain; ++i) {
    std::string path = *pending_scene_;
    pending_scene_.reset();
    switch_scene(path);
  }
  pending_scene_.reset();
}

void Host::switch_scene(const std::string& path) {
  if (!pkg_->scenes.count(path)) return;
  // Entity-owned callbacks die with their entities (E3); session callbacks survive.
  scene_path_ = path;
  log("info", "[scene] loaded " + path);
  call_ref(refs_.scene_set, nullptr, 1, [&](lua_State* S) { push_str(S, path); });
  fire(0, "sceneLoaded", [&](lua_State* S) {
    push_str(S, path);
    return 1;
  });
}

void Host::write_save(lua_State* L, Json next) {
  size_t bytes = next.stringify().size();
  if (bytes > kMaxSaveBytes) {
    raise(L, "save: save data would be " + std::to_string(bytes) + " bytes; max " + std::to_string(kMaxSaveBytes) + " (64KB) per game");
  }
  save_ = std::move(next);
}

// ================================================================ host ops

int Host::host_call(lua_State* L) {
  Host* host = static_cast<Host*>(lua_tolightuserdata(L, lua_upvalueindex(1)));
  return host->dispatch(L);
}

void Host::not_yet(lua_State* L, const char* api) {
  raise(L, std::string(api) + " is not available yet in the C++ engine (entities arrive in slice E3)");
}

int Host::dispatch(lua_State* L) {
  const int op = static_cast<int>(lua_tonumber(L, 1));
  switch (op) {
    case OP_INIT: {
      int* slots[] = {&refs_.make_script, &refs_.proxy, &refs_.flush, &refs_.start,
                      &refs_.invoke,      &refs_.player, &refs_.scene_set, &refs_.done_fire};
      for (int i = 0; i < 8; ++i) *slots[i] = lua_isnoneornil(L, i + 2) ? 0 : lua_ref(L, i + 2);
      return 0;
    }
    case OP_PRINT:
      log("info", str_arg(L, 2), current_ ? current_->path : std::string());
      return 0;
    case OP_ONTICK: {
      int ref = ref_function(L, 2, "onTick");
      int64_t id = next_id_++;
      ticks_.push_back({id, ref, inst()});
      lua_pushnumber(L, static_cast<double>(id));
      return 1;
    }
    case OP_UNTICK: {
      auto id = static_cast<int64_t>(num_arg(L, 2));
      auto it = std::find_if(ticks_.begin(), ticks_.end(), [&](const TickCb& t) { return t.id == id; });
      if (it != ticks_.end()) {
        lua_unref(L, it->ref);
        ticks_.erase(it);
      }
      return 0;
    }
    case OP_AFTER:
    case OP_EVERY: {
      double secs = num_arg(L, 2);
      int ref = ref_function(L, 3, op == OP_AFTER ? "after" : "every");
      int64_t id = next_id_++;
      double interval = op == OP_EVERY ? std::max(dt_, secs) : 0;
      timers_.push_back({id, time_ + std::max(0.0, secs), interval, ref, inst(), id});
      lua_pushnumber(L, static_cast<double>(id));
      return 1;
    }
    case OP_CANCEL:
      remove_timer(static_cast<int64_t>(num_arg(L, 2)), true);
      return 0;
    case OP_RANDOM: {
      double r = rng_.next();
      if (lua_isnoneornil(L, 2)) {
        lua_pushnumber(L, r);
      } else {
        double a = num_arg(L, 2), b = lua_isnoneornil(L, 3) ? a : num_arg(L, 3);
        lua_pushnumber(L, a + (b - a) * r);
      }
      return 1;
    }
    case OP_TIME:
      lua_pushnumber(L, time_);
      return 1;
    case OP_CONNECT: {
      double e = num_arg(L, 2);
      if (e != 0) not_yet(L, "entity signals");
      std::string signal = str_arg(L, 3);
      int ref = ref_function(L, 4, signal + ":connect");
      int64_t id = next_id_++;
      conns_[id] = Conn{id, 0, signal, ref, inst()};
      lua_pushnumber(L, static_cast<double>(id));
      return 1;
    }
    case OP_DISCONNECT: {
      auto it = conns_.find(static_cast<int64_t>(num_arg(L, 2)));
      if (it != conns_.end()) {
        lua_unref(L, it->second.ref);
        conns_.erase(it);
      }
      return 0;
    }
    case OP_AXIS:  // input arrives with the platform layer (E5); headless input is idle
      lua_pushnumber(L, 0);
      return 1;
    case OP_PRESSED:
    case OP_HELD:
      lua_pushboolean(L, false);
      return 1;
    case OP_POINTER:
      lua_pushnumber(L, TAG_PLAIN);
      lua_pushnil(L);
      return 2;
    case OP_REQUIRE:
      require_module(L, str_arg(L, 2), str_arg(L, 3));
      return 1;
    case OP_ERROR:
      record_error(lua_isnoneornil(L, 2) ? "error" : str_arg(L, 2), str_arg(L, 3), current_ ? current_->path : "?");
      return 0;
    case OP_LOADSCENE: {
      std::string path = str_arg(L, 2);
      if (!pkg_->scenes.count(path)) {
        std::string name = path;
        if (pkg::starts_with(name, "scenes/")) name = name.substr(7);
        if (pkg::ends_with(name, ".scene.json")) name = name.substr(0, name.size() - 11);
        std::string guess = "scenes/" + name + ".scene.json";
        std::string all;
        for (const auto& [p, _] : pkg_->scenes) all += (all.empty() ? "" : ", ") + p;
        raise(L, "loadScene: no scene \"" + path + "\"" +
                     (pkg_->scenes.count(guess) ? " (did you mean \"" + guess + "\"?)" : "; scenes: " + all));
      }
      pending_scene_ = path;
      return 0;
    }
    case OP_AUDIO: {
      std::string what = str_arg(L, 2);
      if (what == "sfx") {
        std::string id = str_arg(L, 3);
        std::string path = "data/sfx/" + id + ".json";
        if (!pkg_->files.has(path)) raise(L, "sfx.play: no sound \"" + id + "\" (add " + path + ")");
        if (!pkg_->sfx.count(path)) raise(L, "sfx.play: " + path + " is invalid");
        double volume = std::clamp(num_arg_or(L, 4, 1), 0.0, 1.0), pitch = std::clamp(num_arg_or(L, 5, 1), 0.1, 8.0);
        audio_.push_back({"sfx", id, volume, pitch, 0, time_});
        return 0;
      }
      if (what == "music") {
        std::string id = str_arg(L, 3);
        std::string path = "data/music/" + id + ".json";
        if (!pkg_->files.has(path)) raise(L, "music.play: no song \"" + id + "\" (add " + path + ")");
        if (!pkg_->music.count(path)) raise(L, "music.play: " + path + " is invalid");
        if (music_id_ == id) return 0;  // already playing: keep going (re-entering a scene)
        music_id_ = id;
        audio_.push_back({"music", id, 1, 1, std::max(0.0, num_arg_or(L, 4, 0)), time_});
        return 0;
      }
      if (what == "stop") {
        if (!music_id_) return 0;
        music_id_.reset();
        audio_.push_back({"music_stop", "", 1, 1, std::max(0.0, num_arg_or(L, 3, 0)), time_});
        return 0;
      }
      raise(L, "audio: unknown call " + what);
    }
    case OP_SETTINGS: {
      std::string name = str_arg(L, 2);
      if (name == "music") lua_pushnumber(L, settings.mute ? 0 : settings.music);
      else if (name == "sfx") lua_pushnumber(L, settings.mute ? 0 : settings.sfx);
      else if (name == "mute") lua_pushboolean(L, settings.mute);
      else if (name == "vibration") lua_pushboolean(L, settings.vibration);
      else raise(L, "settings.get: unknown setting \"" + name + "\" (use \"music\", \"sfx\", \"mute\" or \"vibration\")");
      return 1;
    }
    case OP_STORE: {
      std::string what = str_arg(L, 2);
      const auto& items = pkg_->manifest.store;
      if (what == "items") {
        lua_createtable(L, static_cast<int>(items.size()), 0);
        for (size_t i = 0; i < items.size(); ++i) {
          const pkg::StoreItem& it = items[i];
          lua_createtable(L, 0, 6);
          push_str(L, it.id), lua_setfield(L, -2, "id");
          push_str(L, it.kind), lua_setfield(L, -2, "kind");
          push_str(L, it.name), lua_setfield(L, -2, "name");
          push_str(L, it.description), lua_setfield(L, -2, "description");
          lua_pushnumber(L, it.price), lua_setfield(L, -2, "price");
          if (it.icon) push_str(L, *it.icon), lua_setfield(L, -2, "icon");
          lua_rawseti(L, -2, static_cast<int>(i + 1));
        }
        return 1;
      }
      if (what == "owns") {
        lua_pushboolean(L, store_owned_.count(str_arg(L, 3)) > 0);
        return 1;
      }
      if (what == "pending") {
        lua_createtable(L, static_cast<int>(store_pending_.size()), 0);
        for (size_t i = 0; i < store_pending_.size(); ++i) {
          lua_createtable(L, 0, 2);
          push_str(L, store_pending_[i].item_id), lua_setfield(L, -2, "itemId");
          push_str(L, store_pending_[i].purchase_id), lua_setfield(L, -2, "purchaseId");
          lua_rawseti(L, -2, static_cast<int>(i + 1));
        }
        return 1;
      }
      if (what == "prompt") {
        std::string id = str_arg(L, 3);
        auto item = std::find_if(items.begin(), items.end(), [&](const pkg::StoreItem& i) { return i.id == id; });
        if (item == items.end()) {
          std::string all;
          for (const auto& i : items) all += (all.empty() ? "" : ", ") + i.id;
          raise(L, "store: no item \"" + id + "\"" + (items.empty() ? " (declare [[store]] items in dreamsy.toml)" : " (items: " + all + ")"));
        }
        // In-memory store (engine-web MemoryStoreHost): passes once, consumables always; delivered next tick.
        if (item->kind == "pass" && store_passes_.count(id)) return 0;
        Purchase p{id, "mem_" + std::to_string(store_next_++)};
        if (item->kind == "pass") store_passes_.insert(id);
        store_queue_.push_back(p);
        return 0;
      }
      if (what == "consume") {
        std::string pid = str_arg(L, 3);
        std::erase_if(store_pending_, [&](const Purchase& p) { return p.purchase_id == pid; });
        return 0;
      }
      raise(L, "store: unknown call " + what);
    }
    case OP_PLATFORM: {
      std::string what = str_arg(L, 2);
      if (what != "runEnded") raise(L, "platform: unknown call " + what);
      return 0;  // run-end events reach the app host in E6
    }
    case OP_SAVE: {
      std::string what = str_arg(L, 2);
      if (what == "keys") {
        lua_createtable(L, static_cast<int>(save_.object.size()), 0);
        for (size_t i = 0; i < save_.object.size(); ++i) {
          push_str(L, save_.object[i].first);
          lua_rawseti(L, -2, static_cast<int>(i + 1));
        }
        return 1;
      }
      bool key_ok = lua_type(L, 3) == LUA_TSTRING;
      std::string key = str_arg(L, 3);
      if (!key_ok || key.empty() || pkg::utf16_length(key) > 128) raise(L, "save." + what + " expects a key string (1..128 chars)");
      if (what == "get") {
        if (const Json* v = save_.find(key)) push_json(L, *v);
        else lua_pushvalue(L, 4);
        return 1;
      }
      if (what == "set") {
        Json v = read_json(L, 4);
        Json next = save_;
        if (v.type == Json::Type::Null) next.remove(key);
        else next.set(key, std::move(v));
        write_save(L, std::move(next));
        return 0;
      }
      if (what == "remove") {
        if (save_.find(key)) {
          Json next = save_;
          next.remove(key);
          write_save(L, std::move(next));
        }
        return 0;
      }
      raise(L, "save: unknown call " + what);
    }
    case OP_FILES: {
      std::string what = str_arg(L, 2);
      std::string raw = str_arg(L, 3);
      while (!raw.empty() && raw.back() == '/') raw.pop_back();
      bool bad = raw.empty() || raw[0] == '/';
      for (std::string_view seg : pkg::split(raw, '/')) bad = bad || seg.empty() || seg == "." || seg == "..";
      if (bad) raise(L, "data." + what + ": bad path \"" + raw + "\" (use package paths like \"data/creatures\")");
      if (what == "list") {
        std::vector<std::string> paths;
        for (const std::string& p : pkg_->files.paths(raw + "/"))
          if (!pkg::starts_with(p, "assets/") || pkg::ends_with(p, ".json")) paths.push_back(p);
        lua_createtable(L, static_cast<int>(paths.size()), 0);
        for (size_t i = 0; i < paths.size(); ++i) {
          push_str(L, paths[i]);
          lua_rawseti(L, -2, static_cast<int>(i + 1));
        }
        return 1;
      }
      if (what == "read") {
        bool readable = false;
        for (const char* ext : {".json", ".txt", ".luau", ".md"}) readable = readable || pkg::ends_with(raw, ext);
        if (!readable) raise(L, "data.read: only .json, .txt, .luau and .md files can be read (\"" + raw + "\")");
        auto cached = file_cache_.find(raw);
        if (cached == file_cache_.end()) {
          auto text = pkg_->files.text(raw);
          if (!text) raise(L, "data.read: no file \"" + raw + "\"");
          Json v;
          if (pkg::ends_with(raw, ".json")) {
            auto doc = pkg::JsonDoc::parse(*text);
            if (!doc) raise(L, "data.read: " + raw + " is not valid JSON: " + doc.error().substr(16));
            v = Json::from_yyjson(doc.value().root());
          } else {
            v.type = Json::Type::String;
            v.string = std::string(*text);
          }
          cached = file_cache_.emplace(raw, std::move(v)).first;
        }
        push_json(L, cached->second);
        return 1;
      }
      if (what == "exists") {
        lua_pushboolean(L, pkg_->files.has(raw));
        return 1;
      }
      raise(L, "data: unknown call " + what);
    }
    case OP_ALIVE:
      lua_pushboolean(L, false);
      return 1;
    case OP_CLOCK:
      lua_pushnumber(L, options_.clock ? options_.clock() : wall_clock());
      return 1;
    case OP_GAMEPROP: {
      std::string what = str_arg(L, 2);
      if (what == "getTimeScale") {
        lua_pushnumber(L, time_scale_);
        return 1;
      }
      if (what == "setTimeScale") {
        double v = num_arg(L, 3);
        if (!std::isfinite(v)) raise(L, "game.timeScale must be a number 0..4");
        time_scale_ = std::clamp(v, 0.0, 4.0);
        return 0;
      }
      if (what == "theme") {
        Theme t = resolve_theme(pkg_->manifest);
        lua_createtable(L, 0, 6);
        push_str(L, t.primary), lua_setfield(L, -2, "primary");
        push_str(L, t.accent), lua_setfield(L, -2, "accent");
        push_str(L, t.background), lua_setfield(L, -2, "background");
        push_str(L, t.text), lua_setfield(L, -2, "text");
        push_str(L, t.panel), lua_setfield(L, -2, "panel");
        push_str(L, t.font), lua_setfield(L, -2, "font");
        return 1;
      }
      if (what == "session") {
        ScriptInst* prev = current_;
        current_ = &session_inst_;
        lua_pushvalue(L, 3);
        auto err = vm_->pcall(L, 0, 0);
        current_ = prev;
        if (err) {
          std::string msg = err->message;
          lua_pop(L, 1);
          raise(L, msg);
        }
        return 0;
      }
      raise(L, "game: unknown call " + what);
    }
    case OP_TOAST:  // UI arrives with the platform layer (E5); headless toasts are dropped
      return 0;
    case OP_SOUND:
      return 0;
    case OP_NET:
      return net_op(L);

    case OP_GET:
    case OP_SET:
    case OP_CALL: not_yet(L, "entity properties and methods");
    case OP_ENTITY:
    case OP_TAGGED: not_yet(L, "entity lookup");
    case OP_SPAWN: not_yet(L, "spawn()");
    case OP_SCREEN: not_yet(L, "ui.showScreen");
    case OP_AVATAR:
    case OP_FROMENTITY: not_yet(L, "avatars");
    case OP_TWEEN: not_yet(L, "tween()");
    case OP_DIALOG: not_yet(L, "ui.dialog");
    case OP_CAMERA: not_yet(L, "camera");
    case OP_LEADERBOARD: not_yet(L, "leaderboard");
  }
  raise(L, "unknown host op " + std::to_string(op));
}

// Offline room: engine-web NetSession without a link. One local player; room state, scores and
// match end work in-process (delivered at the start of the next tick).
int Host::net_op(lua_State* L) {
  std::string what = str_arg(L, 2);
  auto push_local_player = [&] {
    Json p = Json::object_value();
    p.set("id", Json::string_value("local"));
    p.set("name", Json::string_value("Player"));
    p.set("team", Json{});
    p.set("userId", Json::string_value("local"));
    push_json(L, p);
  };
  if (what == "bind") {
    net_dispatch_ref_ = lua_ref(L, 3);
    return 0;
  }
  if (what == "self") {
    push_local_player();
    return 1;
  }
  if (what == "active") {
    lua_pushboolean(L, false);
    return 1;
  }
  if (what == "prop") {
    std::string k = str_arg(L, 3);
    if (k == "max" || k == "min" || k == "match" || k == "seed") lua_pushnumber(L, 1);
    else if (k == "isHost") lua_pushboolean(L, true);
    else if (k == "isSpectator") lua_pushboolean(L, false);
    else if (k == "spectators") lua_pushnumber(L, 0);
    else lua_pushnil(L);  // code, mode: offline
    return 1;
  }
  if (what == "players") {
    lua_createtable(L, 1, 0);
    push_local_player();
    lua_rawseti(L, -2, 1);
    return 1;
  }
  if (what == "player") {
    if (str_arg(L, 3) == "local") push_local_player();
    else lua_pushnil(L);
    return 1;
  }
  if (what == "host") {
    push_str(L, "local");
    return 1;
  }
  if (what == "avatar" || what == "fromEntity" || what == "replicate") not_yet(L, "avatars");
  if (what == "send") return 0;  // no link: remote events are delivered in-process by the prelude
  if (what == "setState") {
    std::string k = str_arg(L, 3);
    Json v = read_json(L, 4);
    room_state_.set(k, v);
    net_inbox_.push_back({"kv", k, v});
    return 0;
  }
  if (what == "state") {
    const Json* v = room_state_.find(str_arg(L, 3));
    push_json(L, v ? *v : Json{});
    return 1;
  }
  if (what == "addScore") {
    std::string k = str_arg(L, 3);
    double d = num_arg(L, 4);
    if (!std::isfinite(d) || std::fabs(d) > 1e6) raise(L, "room.addScore: amount must be a number (|n| ≤ 1e6)");
    const Json* cur = room_scores_.find(k);
    Json v = Json::number_value((cur ? cur->number : 0) + d);
    room_scores_.set(k, v);
    net_inbox_.push_back({"score", k, v});
    return 0;
  }
  if (what == "score") {
    const Json* v = room_scores_.find(str_arg(L, 3));
    lua_pushnumber(L, v ? v->number : 0);
    return 1;
  }
  if (what == "scores") {
    push_json(L, room_scores_);
    return 1;
  }
  if (what == "finish") {
    if (net_ended_) return 0;
    std::string w = lua_isnoneornil(L, 3) ? "" : str_arg(L, 3);
    if (!w.empty() && w != "draw" && w != "red" && w != "blue" && w != "local") {
      raise(L, "room.finish: winner must be a Player, \"red\", \"blue\", \"draw\" or nil (got \"" + w + "\")");
    }
    net_ended_ = true;
    bool team = w == "red" || w == "blue";
    Json r = Json::object_value();
    r.set("winner", !w.empty() && w != "draw" && !team ? Json::string_value(w) : Json{});
    r.set("team", team ? Json::string_value(w) : Json{});
    r.set("draw", Json::bool_value(w.empty() || w == "draw"));
    r.set("reason", Json::string_value("finish"));
    r.set("scores", room_scores_);
    r.set("match", Json::number_value(1));
    net_inbox_.push_back({"ended", "", r});
    return 0;
  }
  if (what == "teamColor") {
    std::string t = str_arg(L, 3);
    push_str(L, t == "red" ? "#ff2a2a" : t == "blue" ? "#2a6bff" : "#ffffff");  // net/protocol.ts TEAM_COLORS
    return 1;
  }
  raise(L, "room: unknown call " + what);
}

}  // namespace dreamsy::script
