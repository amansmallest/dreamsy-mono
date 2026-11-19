// Shared helpers for the kit and game tests (tests/kits/*_test.cpp, tests/games_test.cpp).
//
// These are the C++ side of engine-web's test helpers: `Package.fromFiles` + `Game.load` (start()),
// the kits' `runLuau` harness (run_luau(): run a Luau snippet inside a game and read back what it
// saved as JSON), `MemorySaveHost` (save data carried between runs as a Json value), and a small
// read-only JSON view (J) so assertions read like the TypeScript ones:
//
//   TS:   const o = await lua(`out.c1 = t:costOf("lemon", 1)`);  expect(o.c1).toBeCloseTo(4);
//   C++:  J o = lua(R"(out.c1 = t:costOf("lemon", 1))");          CHECK_CLOSE(o["c1"].num(), 4, 2);
//
// Everything here is test code: it may REQUIRE (stop the test case) when a package is invalid.
#pragma once

#include <cmath>
#include <functional>
#include <map>
#include <optional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "doctest.h"
#include "pkg/package.h"
#include "script/host.h"
#include "script/json_value.h"

namespace dreamsy::test {

using script::Json;

// ---------------------------------------------------------------- CPU budget under sanitizers

// The debug preset builds with AddressSanitizer, which makes Luau several times slower than in
// engine-web (or a release build). Tests that run whole kit games keep engine-web's 250 ms per-call
// budget in release/web builds and get 8x that under ASan: budget(250). The budget isn't what those
// tests check; tests of the budget itself use exact values.
#if defined(__SANITIZE_ADDRESS__)
inline constexpr double kBudgetScale = 8;
#elif defined(__has_feature)
#if __has_feature(address_sanitizer)
inline constexpr double kBudgetScale = 8;
#else
inline constexpr double kBudgetScale = 1;
#endif
#else
inline constexpr double kBudgetScale = 1;
#endif
inline double budget(double ms) { return ms * kBudgetScale; }

// Package files by path (text or binary bytes in a std::string), like the TS `Record<string, string>`.
using FileMap = std::map<std::string, std::string>;

// ---------------------------------------------------------------- repo files

// Absolute path of a file or folder in the repo ("games/examples/kit-tycoon").
std::string repo_path(std::string_view rel);
bool repo_exists(std::string_view rel);
// A repo file's contents; fails the test if it can't be read.
std::string read_file(std::string_view rel);
// Every file under a repo folder, keyed by its path inside the folder (a package's files).
FileMap read_dir(std::string_view rel);
// Sub-folders of a repo folder (names only, sorted).
std::vector<std::string> list_dirs(std::string_view rel);
// Paths in `files` that start with `prefix` and end with `suffix` (sorted).
std::vector<std::string> paths_with(const FileMap& files, std::string_view prefix, std::string_view suffix = "");

// Strict JSON text -> Json (fails the test on bad JSON).
Json parse_json(std::string_view text);
Json read_json(std::string_view rel);

// ---------------------------------------------------------------- JSON view

// A read-only view of a Json value with forgiving lookups: a missing key or index gives a null
// view instead of crashing, so `o["a"]["b"].num()` works like `o.a?.b` in TS.
class J {
 public:
  J() = default;
  J(const Json* v) : v_(v) {}  // NOLINT: implicit on purpose (J o = run.out;)

  J operator[](std::string_view key) const;
  J operator[](size_t index) const;  // 0-based, like TS arrays
  J operator[](int index) const { return (*this)[static_cast<size_t>(index)]; }

  bool exists() const { return v_ && v_->type != Json::Type::Null; }  // !== undefined/null
  bool is_null() const { return !exists(); }
  bool is_number() const { return v_ && v_->type == Json::Type::Number; }
  bool is_string() const { return v_ && v_->type == Json::Type::String; }
  bool is_bool() const { return v_ && v_->type == Json::Type::Bool; }
  bool is_array() const { return v_ && v_->type == Json::Type::Array; }
  bool is_object() const { return v_ && v_->type == Json::Type::Object; }

  // Values. num() of a non-number is NaN (so a CHECK on it fails visibly), str() of a non-string "".
  double num() const;
  int64_t i() const { return static_cast<int64_t>(std::llround(num())); }
  const std::string& str() const;
  bool b() const { return v_ && v_->type == Json::Type::Bool && v_->boolean; }
  // Luau truthiness: anything but nil/false.
  bool truthy() const { return exists() && !(is_bool() && !v_->boolean); }

  // Length of an array or object (0 otherwise).
  size_t size() const;
  bool has(std::string_view key) const;
  // Object keys in order (TS Object.keys).
  std::vector<std::string> keys() const;
  // Array items, or object values in order (TS Object.values; Luau arrays with holes arrive as objects).
  std::vector<J> values() const;
  // Numbers / strings of values(), for compact comparisons.
  std::vector<double> nums() const;
  std::vector<std::string> strs() const;

  // JSON.stringify of the value ("undefined" when missing): compare whole structures in one CHECK.
  std::string dump() const;
  const Json* raw() const { return v_; }

 private:
  const Json* v_ = nullptr;
};

// doctest prints J values as their JSON text in failure messages.
inline doctest::String toString(const J& j) { return doctest::String(j.dump().c_str()); }

// TS `toBeCloseTo(expected, digits)`: |actual - expected| < 10^-digits / 2 (vitest's rule).
inline bool close_to(double actual, double expected, int digits = 2) {
  if (actual == expected) return true;
  return std::fabs(actual - expected) < std::pow(10.0, -digits) / 2;
}
#define CHECK_CLOSE(actual, expected, digits)                                                              \
  do {                                                                                                     \
    double check_close_a_ = (actual), check_close_e_ = (expected);                                         \
    CHECK_MESSAGE(::dreamsy::test::close_to(check_close_a_, check_close_e_, (digits)),                     \
                  #actual " = " << check_close_a_ << ", expected " << check_close_e_ << " (" << (digits)   \
                                << " digits)");                                                            \
  } while (0)

// Joins strings with a separator (for log assertions).
std::string join(const std::vector<std::string>& parts, std::string_view sep = "\n");
bool contains(std::string_view haystack, std::string_view needle);
// std::regex_search, ECMAScript syntax (TS `toMatch(/.../)`).
bool matches(const std::string& text, const std::string& pattern);

// ---------------------------------------------------------------- packages and games

// Loads a package from files. The test stops (REQUIRE) with the validator's issues if it is invalid.
std::shared_ptr<const pkg::Package> load(const FileMap& files);

// A running game: the script host plus conveniences used by most tests.
struct Game {
  std::unique_ptr<script::Host> host;

  script::Host* operator->() const { return host.get(); }
  // Ticks the game `n` times; `each(i)` runs before tick i (set input there).
  void step(int n = 1, const std::function<void(int)>& each = {});
  // Steps until `done()` (checked before each tick) or `max_ticks`; returns the ticks stepped.
  int step_until(const std::function<bool()>& done, int max_ticks);

  std::vector<std::string> logs() const;                       // print() texts, in order
  std::string log_text() const { return join(logs()); }        // ... joined with "\n"
  std::vector<std::string> logs_with(std::string_view prefix) const;  // texts starting with prefix, prefix removed
  std::vector<std::string> errors() const;                     // "script:line: message"
  const Json& save() const { return host->save_data(); }

  // Entities by id (fails the test if missing). pos()/prop() read catalog props.
  world::EntityId id(std::string_view entity_id) const;
  bool alive(std::string_view entity_id) const;
  world::Point pos(std::string_view entity_id = "player") const;
  world::Entity& entity(std::string_view entity_id) const;
  // Visible = its own `visible` prop and every parent's (engine-web game.effectiveVisible).
  bool visible(world::EntityId e) const;
  // Ids of every entity of a type, in scene-tree order (TS [...g.world.walk()].filter(type)).
  std::vector<world::EntityId> of_type(std::string_view type) const;
  // The `text` of every visible UIText, in tree order (the HUD as the player sees it).
  std::vector<std::string> hud_texts() const;
  // A tap at reference (UI) px, like game.tapScreen (returns "dialog", the hit entity id, or "").
  std::string tap(double x, double y) { return host->tap_screen(x, y); }
  // Presses the UIButton with this id (game.press).
  void press(std::string_view entity_id) { host->press(id(entity_id)); }

  // Input, like engine-web's game.input.setAxis / setButton.
  void axis(std::string_view name, double v) { host->input().set_axis(name, v); }
  void button(std::string_view name, bool down) { host->input().set_button(name, down); }
};

// Every script error must be gone (TS: expect(g.errors).toEqual([])).
#define CHECK_NO_ERRORS(game) CHECK_MESSAGE((game).errors().empty(), ::dreamsy::test::join((game).errors()))

// Game.load(Package.fromFiles(files), options).
Game start(const FileMap& files, script::HostOptions options = {});
// A game from a repo folder plus overrides (files with an empty value are removed).
Game start_dir(std::string_view rel, const FileMap& overrides = {}, script::HostOptions options = {});

// A manifest for test packages: `kits` like `"rpg", "core"` (already quoted, comma separated).
std::string manifest(std::string_view kits, std::string_view entry = "scenes/main.scene.json",
                     std::string_view orientation = "", std::string_view preset = "",
                     std::string_view extra = "");
// A scene whose only entity is an empty Node2D root.
std::string empty_scene(std::string_view root = "world");

// ---------------------------------------------------------------- the kits' runLuau harness

// kits/<kit>/harness.ts runLuau: runs `src` as the only client script of a package (the base
// package's own client/server scripts are dropped; shared modules and data stay), steps it, and
// returns what it stored with save.set("out", ...).
struct LuauOptions {
  std::vector<std::string> kits;  // manifest kits
  FileMap base;                   // the package to run inside (e.g. read_dir("games/examples/kit-tycoon"))
  FileMap files;                  // extra / replacement files
  int steps = 1;
  // After `steps`, keep stepping until this returns true for the save data (max 100000 ticks or an error).
  std::function<bool(const Json& save)> until;
  std::function<double()> clock;
  Json save = Json::object_value();  // initial save data (a shared MemorySaveHost: pass the last run's save)
  double budget_ms = budget(250);
  uint32_t seed = 1;
  std::string orientation = "portrait";
  std::string preset = "clean";
};

struct LuauRun {
  Json save;  // all save data at the end
  std::vector<std::string> logs, errors;
  J out() const { return J(&save)["out"]; }
};

LuauRun run_luau(const std::string& src, const LuauOptions& options);

// ---------------------------------------------------------------- playtest timelines

// engine-web/tools/playtest.ts simulate(): run a package with a scripted input timeline (times are
// game seconds). Controls: "left" "right" "up" "down" (axes) and "jump" "action" "action2" (buttons).
struct TimelineStep {
  double t = 0;
  std::vector<std::string> hold, release, press;  // press = hold for 0.1 s
  std::optional<std::pair<double, double>> tap;   // tap_screen at reference px
  struct Swipe {
    std::pair<double, double> from, to;
    double seconds = 0.15;
  };
  std::optional<Swipe> swipe;
};

struct SimulateOptions {
  Json save = Json::object_value();   // preloaded save data
  std::optional<std::string> scene;   // start mid-game
  std::optional<Json> scene_params;
  double clock = 1767225600;          // clock.now() base (PLAYTEST_EPOCH); game time is added
  std::optional<std::string> auto_dialog;  // "first" | "last" | "1", "2"...: answer dialogs and choices
  double budget_ms = budget(250);
  uint32_t seed = 1;
};

struct PlaytestReport {
  std::vector<std::string> errors;  // "script:line: message"
  std::vector<std::string> logs;    // the last 30, "[level] text"
  std::vector<std::string> toasts;
  size_t entities = 0;
  std::map<std::string, int> sfx;   // sfx id -> times played
  std::vector<std::string> music;   // music ids in play order
  struct Sample {
    double t, x, y;
  };
  std::vector<Sample> avatar_trace;  // the avatar's position once per second (rounded)
  std::optional<std::string> dialog;  // text of the dialog line open at the end
  std::vector<std::string> dialog_log;  // lines shown ("speaker: text", choices add " [a | b]"), last 50
  Json save;
};

PlaytestReport simulate(const FileMap& files, const std::vector<TimelineStep>& timeline, double seconds,
                        const SimulateOptions& options = {});

// ---------------------------------------------------------------- JSON Schema subset

// Checks `value` against a JSON Schema using the keywords the kit schemas use: type (incl. arrays
// of types and "integer"), required, properties, additionalProperties (bool or schema), items,
// minItems/maxItems, minLength, enum, const, pattern, minimum/maximum, oneOf/anyOf, $ref to
// "#/definitions/..." or "#/$defs/...". Returns "path: message" problems (empty = valid).
std::vector<std::string> schema_check(const Json& value, const Json& schema);

}  // namespace dreamsy::test
