// Leaderboards (DREAMSY.MD §13), the parts the C++ host implements: the game-time run timer, the
// Luau API (start / finish / elapsed / cancel / running / submit and its argument checks) and the
// local scores the pause menu shows; plus the m:ss.cc time format.
// Port of engine-web/test/leaderboard.test.ts.
//
// Not ported (the C++ engine has no leaderboard backend or ghosts yet; submissions never resolve
// during a headless run): MemoryLeaderboardHost ranking, ghost recording / sampling / replay
// (raceGhost, armGhost, ghost entities), leaderboard.result, and simulate() awaiting submits.
#include "kits/kit_test.h"

#include "ui/shell.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kSvg = R"(<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#f00"/></svg>)";

void add_asset(FileMap& files, const std::string& id) {
  files["assets/" + id + ".svg"] = kSvg;
  files["assets/" + id + ".meta.json"] = R"({"kind": "image", "file": ")" + id + R"(.svg"})";
}

// TS package_files(script, extraScene): a hero with an animated sprite and a label.
FileMap package_files(const std::string& script) {
  FileMap files{
      {"dreamsy.toml", "format = \"0\"\nname = \"Race\"\ndimension = \"2d\"\nentry_scene = \"scenes/main.scene.json\"\n"},
      {"scenes/main.scene.json", R"({"format": "0", "root": "world", "entities": {
        "world": {"type": "Node2D", "children": ["hero", "label"]},
        "hero": {"type": "Node2D", "tags": ["player"], "props": {"position": [100, 50]}, "children": ["spr"]},
        "spr": {"type": "Sprite2D", "props": {"anims": "data/anims/hero.json", "anim": "run", "size": [20, 30], "position": [0, -10], "z_index": 3}},
        "label": {"type": "UIText", "props": {"text": ""}}}})"},
      {"scripts/client/main.luau", script},
      {"data/anims/hero.json", R"({"run": {"frames": ["asset:f1", "asset:f2"], "fps": 10}, "idle": {"frames": ["asset:f3"], "fps": 1}})"},
  };
  for (const char* id : {"f1", "f2", "f3"}) add_asset(files, id);
  return files;
}

std::string label(const Game& g) { return g->world().str(g.entity("label"), "text"); }

}  // namespace

TEST_SUITE("api leaderboard") {

TEST_CASE("leaderboard: ghost recording: formats times as mm:ss.cc") {
  CHECK(ui::format_board_value(0, true) == "00:00.00");
  CHECK(ui::format_board_value(83.456, true) == "01:23.46");
}

TEST_CASE("leaderboard: timer runs in game time: excludes pause and follows game.timeScale") {
  // TS sets g.timeScale = 0.5 from the test; the C++ host exposes time scale to scripts only, so the
  // script sets it when the game resumes. TS reads g.leaderboardRuns.fastest; here the script shows
  // leaderboard.elapsed() every tick.
  Game g = start(package_files(R"(
    leaderboard.start()
    game.resumed:connect(function() game.timeScale = 0.5 end)
    onTick(function() entity("label").text = string.format("%.6f", leaderboard.elapsed()) end))"));
  g.step(60);  // 1 s
  g->pause();  // paused: the player doesn't step, so no time passes (TS advance(1) == 0)
  g->resume();
  g.step(60);  // 0.5 s of game time
  CHECK_CLOSE(std::stod(label(g)), 1.5, 5);
  CHECK_NO_ERRORS(g);
}

TEST_CASE("leaderboard: start/finish times the run; cancel/elapsed/running/submit and argument errors") {
  // The TS script minus the leaderboard.result handler (submissions never resolve offline).
  Game g = start(package_files(R"(
local log = {}
local function show() entity("label").text = table.concat(log, " ") end
local hero = entity("hero")
leaderboard.start()
onTick(function(dt) hero.position = hero.position + vec2(60 * dt, 0) end)
after(0.5, function() table.insert(log, string.format("el:%.2f", leaderboard.elapsed())) show() end)
after(1, function() local t = leaderboard.finish() table.insert(log, string.format("fin:%.2f", t)) show() end)
after(1.2, function()
  leaderboard.start("lap")
  leaderboard.cancel("lap")
  table.insert(log, "running:" .. tostring(leaderboard.running("lap")))
  leaderboard.submit("score", 300)
  local ok, err = pcall(leaderboard.submit, "score", "x")
  table.insert(log, "err:" .. tostring(not ok))
  local ok2 = pcall(leaderboard.start, "bad name!")
  table.insert(log, "bad:" .. tostring(not ok2))
  show()
end)
after(2, function() leaderboard.start() leaderboard.raceGhost("pb") end)
)"));
  g.step(62);
  CHECK(matches(label(g), R"(^el:0\.50 fin:1\.00$)"));
  g.step(20);
  CHECK(matches(label(g), R"(running:false err:true bad:true)"));
  // TS host.submitted: [["fastest", "asc", 1], ["score", "desc", 300]]
  const auto& scores = g->local_scores();
  REQUIRE(scores.size() == 2);
  CHECK(scores[0].board == "fastest");
  CHECK(scores[0].ascending);
  CHECK(scores[0].value == 1);
  CHECK(scores[1].board == "score");
  CHECK_FALSE(scores[1].ascending);
  CHECK(scores[1].value == 300);
  g.step(50);  // raceGhost("pb") at t = 2 is accepted (no ghost offline)
  g->request_restart();
  CHECK_NO_ERRORS(g);
}

}  // TEST_SUITE
