// sfx / music recording, settings.get, pause/resume/restart (no rendering, no audio device).
// Port of engine-web/test/audio-shell.test.ts.
//
// Host::audio_events() is engine-web's Game.audioLog. engine-web's Game.advance() (the frame-time
// accumulator, at most 5 ticks per call) lives in apps/player/main.cpp in the C++ engine, so the
// pause test steps ticks directly; while paused the player simply doesn't call step().
#include "kits/kit_test.h"

#include <sstream>

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kManifest = "format = \"0\"\nname = \"T\"\ndimension = \"2d\"\nentry_scene = \"scenes/main.scene.json\"\n";

// A scene with one UIText "label"; `attach` runs the script on the label (re-runs with the scene).
FileMap package_files(const std::string& script, bool attach = false) {
  std::string label = R"("label": {"type": "UIText", "props": {"text": ""})";
  label += attach ? R"(, "scripts": ["scripts/client/main.luau"]})" : "}";
  return {
      {"dreamsy.toml", kManifest},
      {"scenes/main.scene.json",
       R"({"format": "0", "root": "world", "entities": {"world": {"type": "Node2D", "children": ["label"]}, )" + label + "}}"},
      {"data/sfx/jump.json", R"({"wave": "square", "freq": 300, "slide": 1, "decay": 0.15})"},
      {"data/music/theme.json", R"({"bpm": 120, "steps": 4, "channels": [{"wave": "triangle", "notes": "C4 - E4 ."}]})"},
      {"scripts/client/main.luau", script},
  };
}

std::string label(const Game& g) { return g->world().str(g.entity("label"), "text"); }

// One audio event as text, without its time (TS maps time to undefined).
std::string event_text(const script::AudioEvent& e) {
  std::ostringstream s;
  s << e.kind << " " << e.id;
  if (e.kind == "sfx") s << " volume=" << e.volume << " pitch=" << e.pitch;
  else s << " fade=" << e.fade;
  return s.str();
}

}  // namespace

TEST_SUITE("api audio_shell") {

TEST_CASE("audio_shell: audio: records sfx.play / music.play / music.stop with options") {
  Game g = start(package_files(R"(
      sfx.play("jump")
      sfx.play("jump", { volume = 0.5, pitch = 1.5 })
      music.play("theme", { fade = 2 })
      music.play("theme") -- already playing: ignored
      after(0.5, function() music.stop(1) end))"));
  g.step(40);
  std::vector<std::string> events;
  for (const script::AudioEvent& e : g->audio_events()) events.push_back(event_text(e));
  CHECK(events == std::vector<std::string>{"sfx jump volume=1 pitch=1", "sfx jump volume=0.5 pitch=1.5", "music theme fade=2",
                                           "music_stop  fade=1"});
  // TS musicId === null: the C++ host keeps it private; the recorded music_stop shows it was cleared.
  const pkg::Sfx& jump = g->package().sfx.at("data/sfx/jump.json");
  CHECK(jump.wave == "square");
  CHECK(jump.freq == 300);
  CHECK(jump.slide == 1);
  CHECK(jump.attack == 0);
  CHECK(jump.volume == 0.5);
  CHECK_NO_ERRORS(g);
}

TEST_CASE("audio_shell: audio: missing sounds are script errors naming the file") {
  Game g = start(package_files(R"(local ok, e = pcall(sfx.play, "boom") entity("label").text = tostring(e))"));
  CHECK(matches(label(g), R"(no sound "boom" \(add data\/sfx\/boom\.json\))"));
}

TEST_CASE("audio_shell: audio: settings.get reads the platform settings (mute -> 0)") {
  Game g = start(package_files(
      R"(onTick(function() entity("label").text = settings.get("music") .. "," .. settings.get("sfx") .. "," .. tostring(settings.get("mute")) end))"));
  g.step();
  CHECK(label(g) == "0.7,0.9,false");
  g->settings.mute = true;
  g.step();
  CHECK(label(g) == "0,0,true");
}

TEST_CASE("audio_shell: audio: playtest report lists sounds played") {
  PlaytestReport r = simulate(package_files(R"(sfx.play("jump") every(0.25, function() sfx.play("jump") end) music.play("theme"))"), {}, 1);
  CHECK(r.sfx == std::map<std::string, int>{{"jump", 5}});
  CHECK(r.music == std::vector<std::string>{"theme"});
}

TEST_CASE("audio_shell: pause freezes ticks and fires game.paused / game.resumed") {
  Game g = start(package_files(R"(
      local n, log = 0, {}
      onTick(function() n += 1 end)
      game.paused:connect(function() table.insert(log, "paused@" .. n) end)
      game.resumed:connect(function() table.insert(log, "resumed@" .. n) entity("label").text = table.concat(log, " ") end))"));
  g.step(5);  // TS g.advance(0.1): advance() runs at most 5 ticks per call
  g->pause();
  CHECK(g->paused());
  // TS expect(g.advance(1)).toBe(0): the C++ player loop doesn't step while paused (apps/player).
  g->resume();
  CHECK_FALSE(g->paused());
  CHECK(label(g) == "paused@5 resumed@5");
  const int64_t t = g->tick();
  g.step();  // TS advance(1/60) runs exactly one tick
  CHECK(g->tick() == t + 1);
}

TEST_CASE("audio_shell: restart: default reloads the entry scene; game.restartRequested overrides") {
  Game g = start(package_files(R"(script.entity.text = "fresh")", true));  // attached: re-runs with the scene
  g->world().set_raw(g.entity("label"), "text", world::Value::string("dirty"));
  CHECK(label(g) == "dirty");
  g->request_restart();
  CHECK(label(g) == "fresh");

  Game h = start(package_files(R"(game.restartRequested:connect(function() entity("label").text = "custom restart" end))"));
  h->request_restart();
  CHECK(label(h) == "custom restart");
}

}  // TEST_SUITE
