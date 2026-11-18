// Shared helpers for the kit and game tests: see kit_test.h.
#include "kits/kit_test.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <regex>
#include <set>
#include <sstream>

#include "pkg/json.h"
#include "pkg/validate.h"

namespace dreamsy::test {

namespace fs = std::filesystem;

// ---------------------------------------------------------------- repo files

std::string repo_path(std::string_view rel) { return std::string(DREAMSY_REPO_ROOT) + "/" + std::string(rel); }

bool repo_exists(std::string_view rel) { return fs::exists(repo_path(rel)); }

std::string read_file(std::string_view rel) {
  std::ifstream in(repo_path(rel), std::ios::binary);
  REQUIRE_MESSAGE(in.good(), "cannot read " << std::string(rel));
  std::stringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

FileMap read_dir(std::string_view rel) {
  FileMap out;
  const fs::path root = repo_path(rel);
  REQUIRE_MESSAGE(fs::is_directory(root), "not a folder: " << std::string(rel));
  for (const auto& entry : fs::recursive_directory_iterator(root)) {
    if (!entry.is_regular_file()) continue;
    std::string path = fs::relative(entry.path(), root).generic_string();
    if (path.rfind(".", 0) == 0 || path.find("/.") != std::string::npos) continue;  // .DS_Store, .git...
    std::ifstream in(entry.path(), std::ios::binary);
    std::stringstream ss;
    ss << in.rdbuf();
    out[path] = ss.str();
  }
  return out;
}

std::vector<std::string> list_dirs(std::string_view rel) {
  std::vector<std::string> out;
  const fs::path root = repo_path(rel);
  if (!fs::is_directory(root)) return out;
  for (const auto& entry : fs::directory_iterator(root))
    if (entry.is_directory()) out.push_back(entry.path().filename().string());
  std::sort(out.begin(), out.end());
  return out;
}

std::vector<std::string> paths_with(const FileMap& files, std::string_view prefix, std::string_view suffix) {
  std::vector<std::string> out;
  for (const auto& [path, _] : files) {
    bool pre = path.rfind(prefix, 0) == 0;
    bool suf = path.size() >= suffix.size() && path.compare(path.size() - suffix.size(), suffix.size(), suffix) == 0;
    if (pre && suf) out.push_back(path);
  }
  return out;  // std::map is already sorted by path
}

Json parse_json(std::string_view text) {
  auto doc = pkg::JsonDoc::parse(text);
  REQUIRE_MESSAGE(doc.ok(), doc.error());
  return Json::from_yyjson(doc.value().root());
}

Json read_json(std::string_view rel) { return parse_json(read_file(rel)); }

// ---------------------------------------------------------------- JSON view

namespace {
const std::string kEmpty;
}

J J::operator[](std::string_view key) const {
  if (!v_ || v_->type != Json::Type::Object) return {};
  for (const auto& m : v_->object)
    if (m.first == key) return J(&m.second);
  return {};
}

J J::operator[](size_t index) const {
  if (!v_) return {};
  if (v_->type == Json::Type::Array) return index < v_->array.size() ? J(&v_->array[index]) : J();
  // A Luau array with holes arrives as an object keyed "1", "2", ...: index it 0-based too.
  if (v_->type == Json::Type::Object) return (*this)[std::to_string(index + 1)];
  return {};
}

double J::num() const { return is_number() ? v_->number : std::nan(""); }

const std::string& J::str() const { return is_string() ? v_->string : kEmpty; }

size_t J::size() const {
  if (is_array()) return v_->array.size();
  if (is_object()) return v_->object.size();
  return 0;
}

bool J::has(std::string_view key) const { return (*this)[key].raw() != nullptr; }

std::vector<std::string> J::keys() const {
  std::vector<std::string> out;
  if (is_object())
    for (const auto& m : v_->object) out.push_back(m.first);
  return out;
}

std::vector<J> J::values() const {
  std::vector<J> out;
  if (is_array())
    for (const auto& x : v_->array) out.emplace_back(&x);
  if (is_object())
    for (const auto& m : v_->object) out.emplace_back(&m.second);
  return out;
}

std::vector<double> J::nums() const {
  std::vector<double> out;
  for (const J& x : values()) out.push_back(x.num());
  return out;
}

std::vector<std::string> J::strs() const {
  std::vector<std::string> out;
  for (const J& x : values()) out.push_back(x.str());
  return out;
}

std::string J::dump() const { return v_ ? v_->stringify() : "undefined"; }

std::string join(const std::vector<std::string>& parts, std::string_view sep) {
  std::string out;
  for (size_t i = 0; i < parts.size(); ++i) {
    if (i) out += sep;
    out += parts[i];
  }
  return out;
}

bool contains(std::string_view haystack, std::string_view needle) { return haystack.find(needle) != std::string_view::npos; }

bool matches(const std::string& text, const std::string& pattern) {
  return std::regex_search(text, std::regex(pattern, std::regex::ECMAScript));
}

// ---------------------------------------------------------------- packages and games

std::shared_ptr<const pkg::Package> load(const FileMap& files) {
  auto f = pkg::Files::from_map(files);
  REQUIRE_MESSAGE(f.ok(), f.error());
  pkg::LoadResult r = pkg::load_package(std::move(f).value());
  if (!r.ok)
    for (const auto& issue : r.issues) MESSAGE(pkg::format_issue(issue));
  REQUIRE(r.ok);
  return std::shared_ptr<const pkg::Package>(std::move(r.package));
}

void Game::step(int n, const std::function<void(int)>& each) {
  for (int i = 0; i < n; ++i) {
    if (each) each(i);
    host->step();
  }
}

int Game::step_until(const std::function<bool()>& done, int max_ticks) {
  int i = 0;
  for (; i < max_ticks && !done(); ++i) host->step();
  return i;
}

std::vector<std::string> Game::logs() const {
  std::vector<std::string> out;
  for (const auto& l : host->logs()) out.push_back(l.text);
  return out;
}

std::vector<std::string> Game::logs_with(std::string_view prefix) const {
  std::vector<std::string> out;
  for (const auto& l : host->logs())
    if (l.text.rfind(prefix, 0) == 0) out.push_back(l.text.substr(prefix.size()));
  return out;
}

std::vector<std::string> Game::errors() const {
  std::vector<std::string> out;
  for (const auto& e : host->errors()) out.push_back(e.script + ":" + std::to_string(e.line) + ": " + e.message);
  return out;
}

world::EntityId Game::id(std::string_view entity_id) const {
  world::EntityId e = host->world().by_id(entity_id);
  REQUIRE_MESSAGE(host->world().alive(e), "no entity " << std::string(entity_id));
  return e;
}

bool Game::alive(std::string_view entity_id) const { return host->world().alive(host->world().by_id(entity_id)); }

world::Entity& Game::entity(std::string_view entity_id) const { return *host->world().get(id(entity_id)); }

world::Point Game::pos(std::string_view entity_id) const {
  return host->world().vec(entity(entity_id), "position");
}

bool Game::visible(world::EntityId e) const {
  const world::World& w = host->world();
  for (const world::Entity* x = w.get(e); x; x = w.get(x->parent))
    if (!w.visible(*x)) return false;
  return true;
}

std::vector<world::EntityId> Game::of_type(std::string_view type) const {
  std::vector<world::EntityId> out;
  for (world::EntityId e : host->world().walk())
    if (host->world().get(e)->type->name == type) out.push_back(e);
  return out;
}

std::vector<std::string> Game::hud_texts() const {
  std::vector<std::string> out;
  for (world::EntityId e : of_type("UIText"))
    if (visible(e)) out.push_back(host->world().str(*host->world().get(e), "text"));
  return out;
}

Game start(const FileMap& files, script::HostOptions options) {
  auto h = script::Host::create(load(files), std::move(options));
  REQUIRE_MESSAGE(h.ok(), h.error());
  return Game{std::move(h).value()};
}

Game start_dir(std::string_view rel, const FileMap& overrides, script::HostOptions options) {
  FileMap files = read_dir(rel);
  for (const auto& [path, data] : overrides) {
    if (data.empty()) files.erase(path);
    else files[path] = data;
  }
  return start(files, std::move(options));
}

std::string manifest(std::string_view kits, std::string_view entry, std::string_view orientation, std::string_view preset,
                     std::string_view extra) {
  std::string m = "format = \"0\"\nname = \"kit test\"\ndimension = \"2d\"\n";
  if (!orientation.empty()) m += "orientation = \"" + std::string(orientation) + "\"\n";
  m += "entry_scene = \"" + std::string(entry) + "\"\n";
  if (!kits.empty()) m += "kits = [" + std::string(kits) + "]\n";
  m += std::string(extra);
  if (!extra.empty() && extra.back() != '\n') m += "\n";
  if (!preset.empty()) m += "[style]\npreset = \"" + std::string(preset) + "\"\n";
  return m;
}

std::string empty_scene(std::string_view root) {
  std::string r(root);
  return R"({"format": "0", "root": ")" + r + R"(", "entities": {")" + r + R"(": {"type": "Node2D"}}})";
}

// ---------------------------------------------------------------- runLuau

LuauRun run_luau(const std::string& src, const LuauOptions& o) {
  FileMap files = o.base;
  std::string kits;
  for (const auto& k : o.kits) kits += (kits.empty() ? "\"" : ", \"") + k + "\"";
  files["dreamsy.toml"] = manifest(kits, "scenes/__run.scene.json", o.orientation, o.preset);
  files["scenes/__run.scene.json"] = empty_scene("run_root");
  for (const auto& [path, data] : o.files) files[path] = data;
  // Only the test script runs: drop the game's own scripts (shared modules stay requireable).
  for (auto it = files.begin(); it != files.end();) {
    bool game_script = it->first.rfind("scripts/client/", 0) == 0 || it->first.rfind("scripts/server/", 0) == 0;
    it = game_script ? files.erase(it) : std::next(it);
  }
  files["scripts/client/__run.luau"] = src;

  script::HostOptions opts;
  opts.seed = o.seed;
  opts.budget_ms = o.budget_ms;
  opts.clock = o.clock;
  opts.save = o.save;
  Game g = start(files, opts);
  g.step(o.steps);
  if (o.until)
    for (int i = 0; i < 100000 && !o.until(g.save()) && g.host->errors().empty(); ++i) g.host->step();
  return LuauRun{g.save(), g.logs(), g.errors()};
}

// ---------------------------------------------------------------- playtest timelines

PlaytestReport simulate(const FileMap& files, const std::vector<TimelineStep>& timeline, double seconds,
                        const SimulateOptions& o) {
  script::HostOptions opts;
  opts.seed = o.seed;
  opts.budget_ms = o.budget_ms;
  opts.scene = o.scene;
  opts.scene_params = o.scene_params;
  opts.save = o.save;
  // clock.now() = base + game time; the host isn't created yet, so the lambda reads it through a pointer.
  script::Host* host_ptr = nullptr;
  double base = o.clock;
  opts.clock = [&host_ptr, base] { return base + (host_ptr ? host_ptr->time() : 0); };
  Game game = start(files, opts);
  host_ptr = game.host.get();
  script::Host& g = *game.host;

  std::set<std::string> held;
  struct Release {
    double at;
    std::string control;
  };
  std::vector<Release> pending_release;
  struct PendingSwipe {
    double at, t0;
    std::pair<double, double> from, to;
  };
  std::vector<PendingSwipe> pending_swipes;
  std::vector<TimelineStep> steps = timeline;
  std::stable_sort(steps.begin(), steps.end(), [](const auto& a, const auto& b) { return a.t < b.t; });

  auto apply_held = [&] {
    double mx = 0, my = 0;
    for (const std::string& c : held) {
      if (c == "left") mx -= 1;
      else if (c == "right") mx += 1;
      else if (c == "up") my -= 1;
      else if (c == "down") my += 1;
      else g.input().set_button(c, true);
    }
    g.input().set_axis("move_x", mx);
    g.input().set_axis("move_y", my);
    for (const char* b : {"jump", "action", "action2"})
      if (!held.count(b)) g.input().set_button(b, false);
  };

  PlaytestReport report;
  std::string last_dialog;
  const int ticks = static_cast<int>(std::lround(seconds * 60));
  size_t si = 0;
  for (int i = 0; i <= ticks; ++i) {
    const double t = i / 60.0;
    while (si < steps.size() && steps[si].t <= t) {
      const TimelineStep& s = steps[si++];
      for (const auto& c : s.hold) held.insert(c);
      for (const auto& c : s.release) held.erase(c);
      for (const auto& c : s.press) {
        held.insert(c);
        pending_release.push_back({t + 0.1, c});
      }
      apply_held();
      if (s.tap) g.tap_screen(s.tap->first, s.tap->second);
      if (s.swipe) {
        g.pointer_down(s.swipe->from.first, s.swipe->from.second);
        pending_swipes.push_back({t + std::max(0.0, s.swipe->seconds), t, s.swipe->from, s.swipe->to});
      }
    }
    for (size_t k = pending_swipes.size(); k-- > 0;) {
      const PendingSwipe& sw = pending_swipes[k];
      double f = sw.at > sw.t0 ? std::min(1.0, (t - sw.t0) / (sw.at - sw.t0)) : 1;
      if (sw.at <= t) {
        g.pointer_up(sw.to.first, sw.to.second);
        pending_swipes.erase(pending_swipes.begin() + static_cast<long>(k));
      } else {
        g.pointer_move(sw.from.first + (sw.to.first - sw.from.first) * f, sw.from.second + (sw.to.second - sw.from.second) * f);
      }
    }
    for (size_t k = pending_release.size(); k-- > 0;) {
      if (pending_release[k].at <= t) {
        held.erase(pending_release[k].control);
        pending_release.erase(pending_release.begin() + static_cast<long>(k));
        apply_held();
      }
    }
    if (i % 60 == 0) {
      std::vector<world::EntityId> players = g.world().tagged("player");
      if (!players.empty()) {
        world::Point p = g.world().vec(*g.world().get(players[0]), "position");
        report.avatar_trace.push_back({std::round(t), std::round(p.x), std::round(p.y)});
      }
    }
    if (const auto& d = g.dialogs().dialogs.current) {
      std::string key = std::to_string(d->id) + ":" + std::to_string(d->index);
      const ui::DialogLine& line = d->lines[d->index];
      bool last_line = d->index == d->lines.size() - 1;
      if (key != last_dialog) {
        last_dialog = key;
        std::string text = (line.speaker ? *line.speaker + ": " : "") + line.text;
        if (d->choice && last_line) text += " [" + join(d->options, " | ") + "]";
        report.dialog_log.push_back(text);
      }
      if (o.auto_dialog && i % 6 == 3) {
        bool line_done = d->shown >= static_cast<double>(line.length);
        if (d->choice && last_line && line_done) {
          int n = static_cast<int>(d->options.size());
          const std::string& a = *o.auto_dialog;
          int idx = a == "first" ? 0 : a == "last" ? n - 1 : std::max(0, std::min(n - 1, std::atoi(a.c_str()) - 1));
          g.dialogs().tap(idx);
        } else {
          g.dialogs().tap(-1);
        }
      }
    }
    if (i < ticks) g.step();
  }

  report.errors = game.errors();
  const auto& logs = g.logs();
  for (size_t k = logs.size() > 30 ? logs.size() - 30 : 0; k < logs.size(); ++k)
    report.logs.push_back("[" + logs[k].level + "] " + logs[k].text);
  for (const auto& toast : g.toasts().toasts()) report.toasts.push_back(toast.text);
  report.entities = g.world().count();
  for (const auto& a : g.audio_events()) {
    if (a.kind == "sfx") report.sfx[a.id]++;
    else if (a.kind == "music") report.music.push_back(a.id);
  }
  if (const auto& d = g.dialogs().dialogs.current) report.dialog = d->lines[d->index].text;
  if (report.dialog_log.size() > 50) report.dialog_log.erase(report.dialog_log.begin(), report.dialog_log.end() - 50);
  report.save = g.save_data();
  return report;
}

// ---------------------------------------------------------------- JSON Schema subset

namespace {

const char* type_name(const Json& v) {
  switch (v.type) {
    case Json::Type::Null: return "null";
    case Json::Type::Bool: return "boolean";
    case Json::Type::Number: return "number";
    case Json::Type::String: return "string";
    case Json::Type::Array: return "array";
    case Json::Type::Object: return "object";
  }
  return "?";
}

bool is_type(const Json& v, const std::string& t) {
  if (t == "integer") return v.type == Json::Type::Number && std::floor(v.number) == v.number;
  return t == type_name(v);
}

bool equal(const Json& a, const Json& b) { return a.stringify() == b.stringify(); }

void check(const Json& v, const Json& s, const Json& root, const std::string& at, std::vector<std::string>& out) {
  J schema(&s);
  if (J ref = schema["$ref"]; ref.is_string()) {
    // "#/definitions/name" or "#/$defs/name"
    J target(&root);
    std::string path = ref.str().substr(ref.str().find('#') + 1);
    std::stringstream parts(path);
    std::string part;
    while (std::getline(parts, part, '/'))
      if (!part.empty()) target = target[part];
    if (!target.exists()) {
      out.push_back(at + ": unresolved $ref " + ref.str());
      return;
    }
    check(v, *target.raw(), root, at, out);
    return;
  }
  if (J t = schema["type"]; t.exists()) {
    bool ok = false;
    if (t.is_string()) ok = is_type(v, t.str());
    for (const J& x : t.is_array() ? t.values() : std::vector<J>{})
      if (is_type(v, x.str())) ok = true;
    if (!ok) {
      out.push_back(at + ": expected " + t.dump() + ", got " + type_name(v));
      return;
    }
  }
  if (J e = schema["enum"]; e.is_array()) {
    bool ok = false;
    for (const J& x : e.values()) ok = ok || equal(*x.raw(), v);
    if (!ok) out.push_back(at + ": " + v.stringify() + " not in " + e.dump());
  }
  if (J c = schema["const"]; c.raw() && !equal(*c.raw(), v)) out.push_back(at + ": expected " + c.dump());
  for (const char* any : {"oneOf", "anyOf"}) {
    J alts = schema[any];
    if (!alts.is_array()) continue;
    int passing = 0;
    for (const J& alt : alts.values()) {
      std::vector<std::string> sub;
      check(v, *alt.raw(), root, at, sub);
      if (sub.empty()) ++passing;
    }
    if (passing == 0) out.push_back(at + ": matches none of " + any);
  }
  if (v.type == Json::Type::Number) {
    if (J m = schema["minimum"]; m.is_number() && v.number < m.num()) out.push_back(at + ": below minimum " + m.dump());
    if (J m = schema["maximum"]; m.is_number() && v.number > m.num()) out.push_back(at + ": above maximum " + m.dump());
  }
  if (v.type == Json::Type::String) {
    if (J p = schema["pattern"]; p.is_string() && !matches(v.string, p.str()))
      out.push_back(at + ": " + v.stringify() + " does not match " + p.str());
    if (J m = schema["minLength"]; m.is_number() && static_cast<double>(v.string.size()) < m.num())
      out.push_back(at + ": shorter than " + m.dump());
  }
  if (v.type == Json::Type::Array) {
    if (J m = schema["minItems"]; m.is_number() && static_cast<double>(v.array.size()) < m.num())
      out.push_back(at + ": fewer than " + m.dump() + " items");
    if (J m = schema["maxItems"]; m.is_number() && static_cast<double>(v.array.size()) > m.num())
      out.push_back(at + ": more than " + m.dump() + " items");
    if (J items = schema["items"]; items.is_object())
      for (size_t i = 0; i < v.array.size(); ++i) check(v.array[i], *items.raw(), root, at + "[" + std::to_string(i) + "]", out);
  }
  if (v.type == Json::Type::Object) {
    J obj(&v);
    for (const J& r : schema["required"].values())
      if (!obj.has(r.str())) out.push_back(at + ": missing required " + r.str());
    J props = schema["properties"];
    J extra = schema["additionalProperties"];
    for (const auto& m : v.object) {
      std::string child = at + "." + m.first;
      if (J p = props[m.first]; p.raw()) check(m.second, *p.raw(), root, child, out);
      else if (extra.is_bool() && !extra.b()) out.push_back(child + ": unknown key");
      else if (extra.is_object()) check(m.second, *extra.raw(), root, child, out);
    }
  }
}

}  // namespace

std::vector<std::string> schema_check(const Json& value, const Json& schema) {
  std::vector<std::string> out;
  check(value, schema, schema, "$", out);
  return out;
}

}  // namespace dreamsy::test
