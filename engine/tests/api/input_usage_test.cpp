// Which inputs a game uses (input/usage.h), first-read tracking (InputState::ever_read) and stick
// shaping (touch_controls.h shape_stick). Port of engine-web/test/input-usage.test.ts.
//
// engine-web's detectInputUsage(game) also resolved the kits the game requires (and their
// "requires") and scanned their sources. In the C++ engine that closure is built by the player
// (apps/player/main.cpp required_kits/load_kits) and handed to detect_input_usage() as one
// concatenated source, so these tests pass the concatenation the player would build.
// InputState.recentlyRead is already covered by input_test.cpp "input: recently_read is a 45-tick
// window; raw reads don't count".
#include "kits/kit_test.h"

#include "input/input_state.h"
#include "input/touch_controls.h"
#include "input/usage.h"

using namespace dreamsy;
using namespace dreamsy::test;

TEST_SUITE("api input_usage") {

TEST_CASE("input_usage: detectInputUsage includes buttons read inside required kits (platformer jump)") {
  const std::string game = "local kit = require(\"@kit/fakeplat\")\nlocal a = input.axis(\"move_x\")\nif input.pressed(\"action2\") then end";
  const std::string fakeplat = "if input.pressed(\"jump\") then end";   // kits/fakeplat/init.luau (requires fakecore)
  const std::string fakecore = "local x = input.held(\"action\")";      // kits/fakecore/init.luau
  input::InputUsage u = input::detect_input_usage(game + fakeplat + fakecore);
  CHECK(u.move);
  CHECK(u.buttons == std::set<std::string>{"action", "action2", "jump"});
}

TEST_CASE("input_usage: detectInputUsage ignores kits the game doesn't require") {
  // No kits required: only the game's own source is scanned.
  input::InputUsage u = input::detect_input_usage("if input.pressed(\"action2\") then end");
  CHECK(u.buttons == std::set<std::string>{"action2"});
}

TEST_CASE("input_usage: InputState.onFirstRead reports each name once, the first time scripts read it") {
  // C++ has no onFirstRead callback: the touch controls poll ever_read() instead. Same facts:
  // every name scripts read is recorded (once), names never read are not.
  input::InputState s;
  CHECK_FALSE(s.ever_read("jump"));
  s.pressed("jump");
  s.held("jump");
  s.axis("move_x");
  s.pressed("action2");
  CHECK(s.ever_read("jump"));
  CHECK(s.ever_read("move_x"));
  CHECK(s.ever_read("action2"));
  CHECK_FALSE(s.ever_read("action"));
}

TEST_CASE("input_usage: shapeStick drops the small axis when the thumb clearly pushes the other way") {
  input::Vec2 a = input::shape_stick(0.9f, 0.35f);  // steering right with a thumb drifting down
  CHECK(a.x > 0.8f);
  CHECK(a.y == 0);
  input::Vec2 dz = input::shape_stick(0.1f, 0.1f);  // dead zone
  CHECK(dz.x == 0);
  CHECK(dz.y == 0);
  input::Vec2 d = input::shape_stick(0.6f, 0.6f);  // real diagonal passes through
  CHECK(d.x > 0.3f);
  CHECK(d.y > 0.3f);
  CHECK_CLOSE(input::shape_stick(1, 0).x, 1, 5);
}

}  // TEST_SUITE
