// platform.runEnded argument handling. Port of the portable part of engine-web/test/run-end.test.ts.
//
// The C++ host doesn't emit run-end events to an app host yet (Host has no onRunEnd: OP_PLATFORM
// only validates the call), so the event payloads, the 3 s throttle, the leaderboard- and
// room-driven run ends are not ported (app integration, DREAMSY.MD §14.10 E6/E9; rooms: E8).
// The WebView / iframe bridge tests are browser-only (obsolete for C++).
#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

FileMap package_files(const std::string& script) {
  return {
      {"dreamsy.toml", "format = \"0\"\nname = \"Runner\"\ndimension = \"2d\"\nentry_scene = \"scenes/main.scene.json\"\n"},
      {"scenes/main.scene.json", empty_scene()},
      {"scripts/client/main.luau", script},
  };
}

}  // namespace

TEST_SUITE("api run_end") {

TEST_CASE("run_end: platform.runEnded accepts no reason or any reason string, rejects non-strings") {
  // TS also checks the reported reason (default gameover, unknown -> gameover): no events in C++.
  for (const char* arg : {"", "\"quit\"", "\"finish\"", "\"dead\""}) {
    CAPTURE(arg);
    Game g = start(package_files(std::string("after(0.01, function() platform.runEnded(") + arg + ") end)"));
    g.step(3);
    CHECK_NO_ERRORS(g);
  }
  Game g = start(package_files("after(0.01, function() platform.runEnded(5) end)"));
  g.step(3);
  CHECK(matches(join(g.errors()), R"(platform\.runEnded expects an optional reason string)"));
}

}  // TEST_SUITE
