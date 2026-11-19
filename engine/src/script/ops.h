// Host op numbers and value tags shared with the Luau prelude (src/script/prelude.luau). The build
// substitutes these numbers into the prelude (cmake/gen_script_data.py), so this is the only copy.
#pragma once

namespace dreamsy::script {

enum Op {
  OP_INIT = 1, OP_PRINT = 2, OP_GET = 3, OP_SET = 4, OP_CALL = 5, OP_ENTITY = 6, OP_TAGGED = 7, OP_SPAWN = 8,
  OP_ONTICK = 9, OP_AFTER = 10, OP_EVERY = 11, OP_CANCEL = 12, OP_RANDOM = 13, OP_TIME = 14,
  OP_CONNECT = 15, OP_DISCONNECT = 16, OP_AXIS = 17, OP_PRESSED = 18, OP_HELD = 19, OP_POINTER = 20,
  OP_TOAST = 21, OP_SCREEN = 22, OP_AVATAR = 23, OP_FROMENTITY = 24, OP_REQUIRE = 25, OP_ERROR = 26, OP_SOUND = 27,
  OP_LOADSCENE = 28, OP_STORE = 29, OP_AUDIO = 30, OP_SETTINGS = 31, OP_TWEEN = 32, OP_SAVE = 33, OP_DIALOG = 34,
  OP_CAMERA = 35, OP_FILES = 36, OP_CLOCK = 37, OP_GAMEPROP = 38, OP_ALIVE = 39, OP_UNTICK = 40,
  OP_LEADERBOARD = 41, OP_PLATFORM = 42, OP_NET = 60,
};

// How a value crosses the boundary: a tag, then its payload (plain: 1 value; vec2: x, y;
// vec3: x, y, z; color: r, g, b, a in 0..1; entity: its handle).
enum Tag { TAG_PLAIN = 0, TAG_VEC2 = 1, TAG_VEC3 = 2, TAG_COLOR = 3, TAG_ENTITY = 4 };

}  // namespace dreamsy::script
