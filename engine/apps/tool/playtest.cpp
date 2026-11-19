// dreamsy-tool playtest / eval: the harness's headless engine runs (docs/harness.md §5.1, §14.8).
//
// playtest: runs a package with a scripted input timeline (game time) and prints one JSON report:
// what engine-web's tools/playtest.ts simulate() returned to the builder model, plus the scenes the
// run went through and the controls the game read. Same tick loop as simulate(): ticks 0..N, inputs
// applied at the first tick whose time >= step.t, `press` held for 0.1 s, taps through
// Host::tap_screen, swipes as pointer down / moves / up, the avatar sampled once per second, and
// dialogs advanced every 6 ticks with --auto-dialog.
//
//   dreamsy-tool playtest game.zip --seconds 8 --auto-dialog first \
//       --timeline '[{"t":0.5,"hold":["right"]},{"t":1,"press":["jump"]},{"t":2,"tap":[640,600]}]'
//
// eval: runs a Luau client script inside a package (or an empty one) with the given kits enabled
// and prints what it stored with save.set(KEY, ...). The kit balance simulators
// (kits/tycoon/harness.ts, kits/tower-defense/harness.ts) are built on it.
//
//   dreamsy-tool eval --base games/examples/kit-tycoon --kits tycoon --script sim.luau --until out
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <iterator>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "input/usage.h"
#include "pkg/json.h"
#include "pkg/text.h"
#include "pkg/validate.h"
#include "script/host.h"
#include "tool.h"

namespace dreamsy::tool {
namespace {

// engine-web PLAYTEST_EPOCH: clock.now() at game time 0 in tool runs (2026-01-01 UTC).
constexpr double kPlaytestEpoch = 1767225600;
constexpr double kTickRate = 60;

int usage_error(const std::string& message) {
  std::fprintf(stderr, "✗ %s\n", message.c_str());
  return 2;
}

bool parse_number(std::string_view text, double min, double max, double* out) {
  std::string s(text);
  char* end = nullptr;
  double v = std::strtod(s.c_str(), &end);
  if (end == s.c_str() || *end != '\0' || !std::isfinite(v) || v < min || v > max) return false;
  *out = v;
  return true;
}

// A JSON argument: inline text, "@path" (a file) or "-" (stdin).
Result<std::string> json_arg(std::string_view value) {
  if (value == "-") return std::string(std::istreambuf_iterator<char>(std::cin), std::istreambuf_iterator<char>());
  if (!value.empty() && value[0] == '@') {
    auto bytes = read_file(std::string(value.substr(1)));
    if (!bytes) return Error{bytes.error()};
    return std::string(bytes.value()->begin(), bytes.value()->end());
  }
  return std::string(value);
}

Result<script::Json> parse_json_arg(std::string_view flag, std::string_view value, bool object) {
  auto text = json_arg(value);
  if (!text) return Error{std::string(flag) + ": " + text.error()};
  auto doc = pkg::JsonDoc::parse(text.value());
  if (!doc) return Error{std::string(flag) + ": " + doc.error()};
  if (object && !yyjson_is_obj(doc.value().root())) return Error{std::string(flag) + ": expected a JSON object"};
  return script::Json::from_yyjson(doc.value().root());
}

std::string num(double v) { return pkg::number_text(v); }
long long js_round(double v) { return static_cast<long long>(std::floor(v + 0.5)); }  // Math.round

std::string string_array(const std::vector<std::string>& items) {
  std::string out = "[";
  for (size_t i = 0; i < items.size(); ++i) out += (i ? "," : "") + pkg::quote(items[i]);
  return out + "]";
}

std::vector<std::string> last(const std::vector<std::string>& v, size_t n) {
  return v.size() <= n ? v : std::vector<std::string>(v.end() - static_cast<std::ptrdiff_t>(n), v.end());
}

std::string errors_json(const script::Host& host) {
  std::string out = "[";
  bool first = true;
  for (const script::ScriptError& e : host.errors()) {
    out += std::string(first ? "" : ",") + "{\"script\":" + pkg::quote(e.script);
    if (e.line > 0) out += ",\"line\":" + std::to_string(e.line);
    out += ",\"message\":" + pkg::quote(e.message) + ",\"count\":" + std::to_string(e.count) + "}";
    first = false;
  }
  return out + "]";
}

std::vector<std::string> log_lines(const script::Host& host, bool with_level) {
  std::vector<std::string> out;
  for (const script::LogLine& l : host.logs()) out.push_back(with_level ? "[" + l.level + "] " + l.text : l.text);
  return out;
}

// engine-web Game.audioStats: sfx id -> plays, music ids in play order.
std::string audio_json(const script::Host& host) {
  std::vector<std::pair<std::string, int>> sfx;  // first-play order, like a JS object
  std::vector<std::string> music;
  for (const script::AudioEvent& a : host.audio_events()) {
    if (a.kind == "sfx") {
      bool found = false;
      for (auto& [id, n] : sfx)
        if (id == a.id) n++, found = true;
      if (!found) sfx.emplace_back(a.id, 1);
    } else if (a.kind == "music") {
      music.push_back(a.id);
    }
  }
  std::string out = "{\"sfx\":{";
  for (size_t i = 0; i < sfx.size(); ++i) out += (i ? "," : "") + pkg::quote(sfx[i].first) + ":" + std::to_string(sfx[i].second);
  return out + "},\"music\":" + string_array(music) + "}";
}

// The game's scripts concatenated (for input::detect_input_usage).
std::string game_scripts(const pkg::Package& p) {
  std::string out;
  for (const std::string& path : p.files.paths("scripts/"))
    if (auto text = p.files.text(path)) out.append(*text).append("\n");
  return out;
}

// ---------------------------------------------------------------- the timeline

struct Swipe {
  double fx = 0, fy = 0, tx = 0, ty = 0, seconds = 0.15;
};
struct Step {
  double t = 0;
  std::vector<std::string> hold, release, press;
  std::optional<std::pair<double, double>> tap;
  std::optional<Swipe> swipe;
};

Result<std::vector<std::string>> names_of(yyjson_val* v, const char* key) {
  std::vector<std::string> out;
  yyjson_val* arr = yyjson_obj_get(v, key);
  if (!arr) return out;
  if (!yyjson_is_arr(arr)) return Error{std::string("\"") + key + "\" must be an array of control names"};
  size_t i, n;
  yyjson_val* item;
  yyjson_arr_foreach(arr, i, n, item) {
    if (!yyjson_is_str(item)) return Error{std::string("\"") + key + "\" must be an array of control names"};
    out.emplace_back(yyjson_get_str(item));
  }
  return out;
}

Result<std::pair<double, double>> point_of(yyjson_val* v, const char* what) {
  if (!yyjson_is_arr(v) || yyjson_arr_size(v) < 2 || !yyjson_is_num(yyjson_arr_get(v, 0)) || !yyjson_is_num(yyjson_arr_get(v, 1)))
    return Error{std::string("\"") + what + "\" must be [x, y]"};
  return std::pair{yyjson_get_num(yyjson_arr_get(v, 0)), yyjson_get_num(yyjson_arr_get(v, 1))};
}

Result<std::vector<Step>> parse_timeline(const std::string& text) {
  auto doc = pkg::JsonDoc::parse(text);
  if (!doc) return Error{doc.error()};
  yyjson_val* root = doc.value().root();
  if (!yyjson_is_arr(root)) return Error{"the timeline must be a JSON array of steps"};
  std::vector<Step> out;
  size_t i, n;
  yyjson_val* v;
  yyjson_arr_foreach(root, i, n, v) {
    const std::string at = "step " + std::to_string(i) + ": ";
    if (!yyjson_is_obj(v)) return Error{at + "must be an object"};
    Step s;
    yyjson_val* t = yyjson_obj_get(v, "t");
    if (!yyjson_is_num(t)) return Error{at + "needs a number \"t\" (seconds)"};
    s.t = yyjson_get_num(t);
    for (auto [key, list] : {std::pair{"hold", &s.hold}, std::pair{"release", &s.release}, std::pair{"press", &s.press}}) {
      auto names = names_of(v, key);
      if (!names) return Error{at + names.error()};
      *list = std::move(names).value();
    }
    if (yyjson_val* tap = yyjson_obj_get(v, "tap")) {
      auto p = point_of(tap, "tap");
      if (!p) return Error{at + p.error()};
      s.tap = p.value();
    }
    if (yyjson_val* sw = yyjson_obj_get(v, "swipe")) {
      if (!yyjson_is_obj(sw)) return Error{at + "\"swipe\" must be {from, to, seconds?}"};
      auto from = point_of(yyjson_obj_get(sw, "from"), "swipe.from");
      auto to = point_of(yyjson_obj_get(sw, "to"), "swipe.to");
      if (!from) return Error{at + from.error()};
      if (!to) return Error{at + to.error()};
      Swipe w{from.value().first, from.value().second, to.value().first, to.value().second, 0.15};
      if (yyjson_val* secs = yyjson_obj_get(sw, "seconds"); yyjson_is_num(secs)) w.seconds = std::max(0.0, yyjson_get_num(secs));
      s.swipe = w;
    }
    out.push_back(std::move(s));
  }
  // Stable: same-time steps keep their order (Array.prototype.sort is stable).
  std::stable_sort(out.begin(), out.end(), [](const Step& a, const Step& b) { return a.t < b.t; });
  return out;
}

// ---------------------------------------------------------------- playtest

struct PlaytestOptions {
  double seconds = 8;
  std::vector<Step> timeline;
  std::optional<std::string> scene;
  std::optional<script::Json> params;
  script::Json save = script::Json::object_value();
  double clock = kPlaytestEpoch;
  std::optional<std::string> auto_dialog;  // "first" | "last" | 1-based index
  double budget_ms = 250;
  uint32_t seed = 1;
};

std::string load_error_report(const std::string& message) {
  return "{\"loadError\":" + pkg::quote(message) +
         ",\"errors\":[],\"logs\":[],\"toasts\":[],\"entities\":0,\"audio\":{\"sfx\":{},\"music\":[]},\"avatarTrace\":[]}";
}

std::string run_playtest(std::shared_ptr<const pkg::Package> package, const PlaytestOptions& o) {
  script::HostOptions opts;
  opts.seed = o.seed;
  opts.budget_ms = o.budget_ms;
  opts.scene = o.scene;
  opts.scene_params = o.params;
  opts.save = o.save;
  script::Host* host_ptr = nullptr;
  const double clock = o.clock;
  opts.clock = [&host_ptr, clock] { return clock + (host_ptr ? host_ptr->time() : 0.0); };
  if (o.scene && !package->scenes.count(*o.scene)) return load_error_report("unknown scene \"" + *o.scene + "\"");
  auto created = script::Host::create(package, opts);
  if (!created) return load_error_report(created.error());
  std::unique_ptr<script::Host> owned = std::move(created).value();
  script::Host& host = *owned;
  host_ptr = &host;

  static const std::map<std::string, std::pair<std::string, double>, std::less<>> kAxis = {
      {"left", {"move_x", -1}}, {"right", {"move_x", 1}}, {"up", {"move_y", -1}}, {"down", {"move_y", 1}}};
  std::vector<std::string> held;  // insertion order, like a JS Set
  auto is_held = [&held](const std::string& c) { return std::find(held.begin(), held.end(), c) != held.end(); };
  auto add_held = [&](const std::string& c) {
    if (!is_held(c)) held.push_back(c);
  };
  auto remove_held = [&held](const std::string& c) { held.erase(std::remove(held.begin(), held.end(), c), held.end()); };
  auto apply_held = [&] {
    double mx = 0, my = 0;
    for (const std::string& c : held) {
      auto ax = kAxis.find(c);
      if (ax != kAxis.end()) (ax->second.first == "move_x" ? mx : my) += ax->second.second;
      else host.input().set_button(c, true);
    }
    host.input().set_axis("move_x", mx);
    host.input().set_axis("move_y", my);
    for (const char* b : {"jump", "action", "action2"})
      if (!is_held(b)) host.input().set_button(b, false);
  };
  struct Release {
    double at;
    std::string control;
  };
  struct PendingSwipe {
    double at, t0;
    Swipe s;
  };
  std::vector<Release> releases;
  std::vector<PendingSwipe> swipes;

  std::string trace = "[";
  bool trace_first = true;
  std::vector<std::string> dialog_log;
  std::string last_dialog;
  std::string scene = host.scene();
  std::string scenes = "[{\"t\":0,\"scene\":" + pkg::quote(scene) + "}]";
  scenes.pop_back();
  const long long ticks = js_round(o.seconds * kTickRate);
  size_t si = 0;
  for (long long i = 0; i <= ticks; ++i) {
    const double t = static_cast<double>(i) / kTickRate;
    while (si < o.timeline.size() && o.timeline[si].t <= t) {
      const Step& s = o.timeline[si++];
      for (const std::string& c : s.hold) add_held(c);
      for (const std::string& c : s.release) remove_held(c);
      for (const std::string& c : s.press) {
        add_held(c);
        releases.push_back({t + 0.1, c});
      }
      apply_held();
      if (s.tap) host.tap_screen(s.tap->first, s.tap->second);
      if (s.swipe) {
        host.pointer_down(s.swipe->fx, s.swipe->fy);
        swipes.push_back({t + s.swipe->seconds, t, *s.swipe});
      }
    }
    for (size_t k = swipes.size(); k-- > 0;) {
      const PendingSwipe& sw = swipes[k];
      const double f = sw.at > sw.t0 ? std::min(1.0, (t - sw.t0) / (sw.at - sw.t0)) : 1;
      if (sw.at <= t) {
        host.pointer_up(sw.s.tx, sw.s.ty);
        swipes.erase(swipes.begin() + static_cast<std::ptrdiff_t>(k));
      } else {
        host.pointer_move(sw.s.fx + (sw.s.tx - sw.s.fx) * f, sw.s.fy + (sw.s.ty - sw.s.fy) * f);
      }
    }
    for (size_t k = releases.size(); k-- > 0;) {
      if (releases[k].at <= t) {
        remove_held(releases[k].control);
        releases.erase(releases.begin() + static_cast<std::ptrdiff_t>(k));
        apply_held();
      }
    }
    if (i % 60 == 0) {
      const world::World& w = host.world();
      if (const world::Entity* a = w.get(host.avatar())) {
        const world::Mat2D m = w.local(*a);
        trace += std::string(trace_first ? "" : ",") + "{\"t\":" + std::to_string(js_round(t)) + ",\"x\":" + std::to_string(js_round(m.tx)) +
                 ",\"y\":" + std::to_string(js_round(m.ty)) + "}";
        trace_first = false;
      }
    }
    const auto& d = host.dialogs().dialogs.current;
    if (d && d->index < d->lines.size()) {
      const std::string key = std::to_string(d->id) + ":" + std::to_string(d->index);
      const ui::DialogLine& line = d->lines[d->index];
      const bool last_line = d->index == d->lines.size() - 1;
      if (key != last_dialog) {
        last_dialog = key;
        std::string text = (line.speaker ? *line.speaker + ": " : "") + line.text;
        if (d->choice && last_line) text += " [" + pkg::join(d->options, " | ") + "]";
        dialog_log.push_back(text);
      }
      if (o.auto_dialog && i % 6 == 3) {
        if (d->choice && last_line && host.dialogs().dialogs.line_done()) {
          const int count = static_cast<int>(d->options.size());
          int idx = 0;
          if (*o.auto_dialog == "last") idx = count - 1;
          else if (*o.auto_dialog != "first") idx = std::max(0, std::min(count - 1, std::atoi(o.auto_dialog->c_str()) - 1));
          host.dialogs().tap(idx);
        } else {
          host.dialogs().tap(-1);
        }
      }
    }
    if (i < ticks) host.step();
    if (host.scene() != scene) {
      scene = host.scene();
      scenes += ",{\"t\":" + num(host.time()) + ",\"scene\":" + pkg::quote(scene) + "}";
    }
  }
  scenes += "]";

  std::vector<std::string> toasts;
  for (const ui::Toast& t : host.toasts().toasts()) toasts.push_back(t.text);
  std::string dialog;
  if (const auto& d = host.dialogs().dialogs.current; d && d->index < d->lines.size()) {
    const ui::DialogLine& line = d->lines[d->index];
    dialog = ",\"dialog\":{\"text\":" + pkg::quote(line.text);
    if (line.speaker) dialog += ",\"speaker\":" + pkg::quote(*line.speaker);
    if (d->choice) dialog += ",\"options\":" + string_array(d->options);
    dialog += "}";
  }
  const input::InputUsage usage = input::detect_input_usage(game_scripts(*package));
  std::vector<std::string> buttons(usage.buttons.begin(), usage.buttons.end());
  return "{\"errors\":" + errors_json(host) + ",\"logs\":" + string_array(last(log_lines(host, true), 30)) +
         ",\"toasts\":" + string_array(toasts) + ",\"entities\":" + std::to_string(host.world().count()) +
         ",\"audio\":" + audio_json(host) + ",\"avatarTrace\":" + trace + "]" + dialog +
         ",\"dialogLog\":" + string_array(last(dialog_log, 50)) + ",\"save\":" + host.save_data().stringify() +
         ",\"scene\":" + pkg::quote(host.scene()) + ",\"scenes\":" + scenes +
         ",\"controls\":{\"read\":" + string_array(host.input().read_names()) + ",\"scripts\":{\"move\":" + (usage.move ? "true" : "false") +
         ",\"look\":" + (usage.look ? "true" : "false") + ",\"buttons\":" + string_array(buttons) + "}}" +
         ",\"time\":" + num(host.time()) + ",\"ticks\":" + std::to_string(host.tick()) + "}";
}

std::string issues_text(const pkg::LoadResult& r) {
  std::vector<std::string> lines;
  for (const pkg::Issue& i : r.issues)
    if (i.severity == pkg::Severity::Error && lines.size() < 10) lines.push_back(pkg::format_issue(i));
  return "invalid package: " + pkg::join(lines, "; ");
}

}  // namespace

int cmd_playtest(int argc, char** argv) {
  if (argc < 3) return usage_error("playtest needs a package");
  PlaytestOptions o;
  for (int i = 3; i < argc; ++i) {
    std::string_view flag = argv[i];
    if (i + 1 >= argc) return usage_error(std::string(flag) + " needs a value");
    std::string_view value = argv[++i];
    if (flag == "--timeline") {
      auto text = json_arg(value);
      if (!text) return usage_error("--timeline: " + text.error());
      auto tl = parse_timeline(text.value());
      if (!tl) return usage_error("--timeline: " + tl.error());
      o.timeline = std::move(tl).value();
    } else if (flag == "--seconds") {
      if (!parse_number(value, 0, 3600, &o.seconds)) return usage_error("--seconds: 0..3600");
    } else if (flag == "--scene") {
      o.scene = std::string(value);
    } else if (flag == "--params" || flag == "--save") {
      auto j = parse_json_arg(flag, value, true);
      if (!j) return usage_error(j.error());
      if (flag == "--params") o.params = j.value();
      else o.save = j.value();
    } else if (flag == "--clock") {
      if (!parse_number(value, -1e12, 1e12, &o.clock)) return usage_error("--clock: unix seconds");
    } else if (flag == "--auto-dialog") {
      double n = 0;
      if (value != "first" && value != "last" && !parse_number(value, 1, 1000, &n)) return usage_error("--auto-dialog: first | last | N");
      o.auto_dialog = std::string(value);
    } else if (flag == "--budget") {
      if (!parse_number(value, 1, 10000000, &o.budget_ms)) return usage_error("--budget: milliseconds");
    } else if (flag == "--seed") {
      double s = 0;
      if (!parse_number(value, 0, 4294967295.0, &s)) return usage_error("--seed: 0..2^32-1");
      o.seed = static_cast<uint32_t>(s);
    } else {
      return usage_error("unknown flag " + std::string(flag));
    }
  }
  auto files = load_files(argv[2]);
  if (!files) {
    std::printf("%s\n", load_error_report(files.error()).c_str());
    return 1;
  }
  pkg::LoadResult loaded = pkg::load_package(std::move(files).value());
  if (!loaded.ok) {
    std::printf("%s\n", load_error_report(issues_text(loaded)).c_str());
    return 1;
  }
  std::printf("%s\n", run_playtest(std::shared_ptr<const pkg::Package>(std::move(loaded.package)), o).c_str());
  return 0;
}

// ---------------------------------------------------------------- eval

int cmd_eval(int argc, char** argv) {
  std::string script_arg, base, until;
  std::vector<std::string> kits;
  double ticks = 1, max_ticks = 100000, budget = 250, seed = 1, clock = kPlaytestEpoch;
  script::Json save = script::Json::object_value();
  for (int i = 2; i < argc; ++i) {
    std::string_view flag = argv[i];
    if (i + 1 >= argc) return usage_error(std::string(flag) + " needs a value");
    std::string_view value = argv[++i];
    if (flag == "--script") script_arg = value;
    else if (flag == "--base") base = value;
    else if (flag == "--until") until = value;
    else if (flag == "--kits") {
      for (std::string_view k : pkg::split(value, ','))
        if (!pkg::trim(k).empty()) kits.emplace_back(pkg::trim(k));
    } else if (flag == "--save") {
      auto j = parse_json_arg(flag, value, true);
      if (!j) return usage_error(j.error());
      save = j.value();
    } else {
      double* target = flag == "--ticks" ? &ticks : flag == "--max-ticks" ? &max_ticks : flag == "--budget" ? &budget
                     : flag == "--seed" ? &seed : flag == "--clock" ? &clock : nullptr;
      const double lo = flag == "--clock" ? -1e12 : 0, hi = flag == "--clock" ? 1e12 : flag == "--seed" ? 4294967295.0 : 1e8;
      if (!target) return usage_error("unknown flag " + std::string(flag));
      if (!parse_number(value, lo, hi, target)) return usage_error("bad value for " + std::string(flag));
    }
  }
  if (script_arg.empty()) return usage_error("eval needs --script FILE (or - for stdin)");
  auto source = script_arg == "-" ? json_arg("-") : json_arg("@" + script_arg);
  if (!source) return usage_error(source.error());

  // The run package: the base's files with its client/server scripts emptied (shared modules stay
  // requireable; only the given script runs), a manifest enabling `kits`, an empty entry scene and the script.
  std::map<std::string, std::string> files;
  if (!base.empty()) {
    auto f = load_files(base);
    if (!f) return usage_error(f.error());
    for (const std::string& p : f.value().paths()) {
      if (pkg::starts_with(p, "scripts/client/") || pkg::starts_with(p, "scripts/server/")) {
        files[p] = "";  // emptied, not removed: the base's scenes may still attach it
        continue;
      }
      auto b = f.value().bytes(p);
      files[p] = std::string(reinterpret_cast<const char*>(b->data()), b->size());
    }
  }
  std::vector<std::string> quoted;
  for (const std::string& k : kits) quoted.push_back(pkg::quote(k));
  files["dreamsy.toml"] = "format = \"0\"\nname = \"kit run\"\ndimension = \"2d\"\norientation = \"portrait\"\n"
                          "entry_scene = \"scenes/__run.scene.json\"\nkits = [" + pkg::join(quoted, ", ") + "]\n[style]\npreset = \"clean\"\n";
  files["scenes/__run.scene.json"] = R"({"format":"0","root":"run_root","entities":{"run_root":{"type":"Node2D"}}})";
  files["scripts/client/__run.luau"] = source.value();
  auto run_files = pkg::Files::from_map(files);
  if (!run_files) return usage_error(run_files.error());
  pkg::LoadResult loaded = pkg::load_package(std::move(run_files).value());
  if (!loaded.ok) {
    std::printf("{\"loadError\":%s}\n", pkg::quote(issues_text(loaded)).c_str());
    return 1;
  }
  script::HostOptions opts;
  opts.seed = static_cast<uint32_t>(seed);
  opts.budget_ms = budget;
  opts.save = save;
  script::Host* host_ptr = nullptr;
  opts.clock = [&host_ptr, clock] { return clock + (host_ptr ? host_ptr->time() : 0.0); };
  auto created = script::Host::create(std::shared_ptr<const pkg::Package>(std::move(loaded.package)), opts);
  if (!created) {
    std::printf("{\"loadError\":%s}\n", pkg::quote(created.error()).c_str());
    return 1;
  }
  script::Host& host = *created.value();
  host_ptr = &host;
  const std::string key = until.empty() ? "out" : until;
  for (int64_t i = 0; i < static_cast<int64_t>(ticks); ++i) host.step();
  if (!until.empty()) {
    for (int64_t i = 0; i < static_cast<int64_t>(max_ticks) && !host.save_data().find(key) && host.errors().empty(); ++i) host.step();
  }
  const script::Json* out = host.save_data().find(key);
  std::printf("{\"out\":%s,\"save\":%s,\"errors\":%s,\"logs\":%s,\"ticks\":%lld,\"time\":%s}\n", out ? out->stringify().c_str() : "null",
              host.save_data().stringify().c_str(), errors_json(host).c_str(), string_array(log_lines(host, false)).c_str(),
              static_cast<long long>(host.tick()), num(host.time()).c_str());
  return host.errors().empty() ? 0 : 1;
}

}  // namespace dreamsy::tool
