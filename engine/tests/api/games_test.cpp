// Headless playtest of every game in games/examples and games/showcase: it loads, runs 300 ticks
// with a player holding right and jumping, pressing every UI button once and tapping the world,
// without a single script error, and the avatar (if any) moves right. Port of
// engine-web/test/games.test.ts (same input, same checks).
//
// run_compare.py --all checks the same games produce identical script output in both engines;
// this test makes "every game runs cleanly" part of the plain C++ test run.
#include "kits/kit_test.h"

#include "pkg/validate.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

// Runs one game folder (repo-relative) the way games.test.ts does.
void playtest(const std::string& dir) {
  CAPTURE(dir);
  FileMap files = read_dir(dir);
  // 3D games aren't supported (docs/engine.md §14: the engine is 2D/2.5D only): skipped, as in engine-web.
  if (contains(files["dreamsy.toml"], "dimension = \"3d\"")) {
    MESSAGE(dir << ": skipped (3D games are not supported)");
    return;
  }
  script::HostOptions opts;
  opts.seed = 7;
  opts.budget_ms = budget(250);  // engine-web's 250 ms (x8 under ASan, see kit_test.h)
  Game game = start(files, opts);
  script::Host& g = *game.host;
  world::World& w = g.world();

  // The avatar is the first `player`-tagged entity (engine-web game.avatar()).
  std::vector<world::EntityId> players = w.tagged("player");
  world::EntityId avatar = players.empty() ? world::EntityId{} : players[0];
  std::optional<double> start_x;
  if (!avatar.is_null()) start_x = w.vec(*w.get(avatar), "position").x;
  double max_x = start_x.value_or(0);

  // UI buttons present at the start, by id (pressed later by id, like game.press(id)).
  std::vector<std::string> buttons;
  for (world::EntityId e : game.of_type("UIButton")) buttons.push_back(w.get(e)->id);

  for (int i = 0; i < 300; ++i) {
    game.axis("move_x", 1);
    game.button("jump", i % 40 < 6);
    // tap-driven games: press every visible button once, spread over the run. (The TS index
    // expression `(i / 20) | 0 % n` is floor(i / 20): one button per 20 ticks, in order.)
    if (i % 20 == 10 && !buttons.empty()) {
      size_t k = static_cast<size_t>(i / 20);
      if (k < buttons.size()) {
        world::EntityId b = w.by_id(buttons[k]);
        if (w.alive(b)) g.press(b);
      }
    }
    if (i == 150) {
      // tap the world at the current Camera2D's position (0, 0 without one)
      world::Point at{0, 0};
      for (world::EntityId e : game.of_type("Camera2D"))
        if (w.flag(*w.get(e), "current")) {
          at = w.vec(*w.get(e), "position");
          break;
        }
      g.tap_world(at.x, at.y);
    }
    g.step();
    if (!avatar.is_null() && w.alive(avatar)) max_x = std::max(max_x, w.vec(*w.get(avatar), "position").x);
  }
  INFO("HUD: " << join(game.hud_texts(), " | "));
  CHECK_NO_ERRORS(game);
  if (start_x) CHECK_MESSAGE(max_x > *start_x + 20, "avatar start x " << *start_x << ", max x " << max_x);
}

std::vector<std::string> game_dirs(const std::string& group) {
  std::vector<std::string> out;
  for (const std::string& name : list_dirs("games/" + group))
    if (repo_exists("games/" + group + "/" + name + "/dreamsy.toml")) out.push_back("games/" + group + "/" + name);
  return out;
}

}  // namespace

TEST_SUITE("api games") {

TEST_CASE("headless playtest: every game in games/examples") {
  std::vector<std::string> dirs = game_dirs("examples");
  CHECK(dirs.size() >= 20);
  for (const std::string& dir : dirs) playtest(dir);
}

TEST_CASE("headless playtest: every game in games/showcase") {
  for (const std::string& dir : game_dirs("showcase")) playtest(dir);
}

}  // TEST_SUITE
