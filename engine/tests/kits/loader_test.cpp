// Kit loader: require("@kit/<kit>[/<sub>]") resolves to kits/<kit>/. Port of
// engine-web/test/kits/loader.test.ts.
//
// Like the TS test, the games here run on fake kit sources (script::HostOptions::kits, a lookup
// over a std::map) so in-progress kits can't break it. One difference: the C++ engine takes kit
// dependencies from the real kits/*/kit.json catalog compiled into the binary
// (pkg::Catalog::get()), not from the kit sources. So the fakes use real kit names whose real
// dependencies have the shape the test needs:
//   TS fake "rpg" (requires core)  -> "combat"  (really requires procgen)
//   TS fake "core" (requires none) -> "procgen" (really requires nothing)
//   TS "platformer" (not enabled)  -> "platformer"
// The cross-kit test keeps the TS names: "combat" requires "procgen" for real too.
//
// Second difference: the package validator reports a game script's require("@kit/<x>") of a kit
// that isn't enabled as an error (script.kit_not_enabled, same as format/src/validate.ts).
// engine-web's Game.load runs such packages anyway (it logs "[validate]" lines); the C++ host only
// runs valid packages. So the game scripts that require a disabled kit on purpose build the name
// at run time (`require(KIT .. "platformer")`), which the validator's static scan doesn't see.
#include <memory>

#include "kits/kit_test.h"
#include "pkg/catalog.h"
#include "pkg/validate.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

// A one-scene game with `kits` (a manifest line like `kits = ["combat"]`, or empty) and one script.
FileMap game(const std::string& kits, const std::string& script) {
  return {
      {"dreamsy.toml", "format = \"0\"\nname = \"K\"\ndimension = \"2d\"\nentry_scene = \"scenes/main.scene.json\"\n" + kits + "\n"},
      {"scenes/main.scene.json", empty_scene()},
      {"scripts/client/main.luau", script},
  };
}

// A kit lookup over fake sources. The map lives in a shared_ptr owned by the lookup, so the
// string_views it returns stay valid as long as the host holds the lookup.
script::KitLookup fake_kits(FileMap sources) {
  auto files = std::make_shared<const FileMap>(std::move(sources));
  return [files](const std::string& path) -> std::optional<std::string_view> {
    auto it = files->find(path);
    if (it == files->end()) return std::nullopt;
    return std::string_view(it->second);
  };
}

// The TS FAKE map for the first test, with "rpg" -> "combat" and "core" -> "procgen".
FileMap fake_main() {
  return {
      {"kits/combat/init.luau",
       "local util = require(\"./util\")\nlocal core = require(\"@kit/procgen\")\nlocal M = { loads = 0, core = core.name }\n"
       "function M.hello(n) return util.greet(n) end\ncount = (count or 0) + 1\nM.loads = count\nreturn M"},
      {"kits/combat/util.luau", R"(return { greet = function(n) return "hi " .. n .. " " .. tostring(entity == nil) end })"},
      {"kits/combat/battle/init.luau", R"(return { name = "battle" })"},
      {"kits/combat/battle/moves.luau", "local rpg = require(\"@kit/combat\")\nreturn { tackle = 10, kitLoads = rpg.loads }"},
      {"kits/combat/sneaky.luau", R"(return require("../../platformer/init"))"},
      {"kits/procgen/init.luau",
       "-- module top level runs as session code: this onTick survives scene changes\nlocal M = { name = \"core\", ticks = 0 }\n"
       "onTick(function() M.ticks += 1 end)\nreturn M"},
      {"kits/platformer/init.luau", "return {}"},
  };
}

// The TS FAKE map's combat/procgen pair (used by the cross-kit test).
FileMap fake_cross() {
  return {
      {"kits/combat/init.luau",
       "local pg = require(\"@kit/procgen\")\nreturn { roll = pg.roll, bad = function() return require(\"@kit/platformer\") end }"},
      {"kits/procgen/init.luau", "return { roll = function() return 4 end }"},
      {"kits/platformer/init.luau", "return {}"},
  };
}

Game start_fake(const FileMap& files, FileMap kit_sources) {
  script::HostOptions opts;
  opts.kits = fake_kits(std::move(kit_sources));
  return start(files, opts);
}

}  // namespace

TEST_SUITE("kit loader") {

// TS: "bundles real kits via the glob import" (and checks kits/_template/init.luau is among them).
// C++: the test binary registers every real kit as the default lookup (embedded_kits.h). The
// _template kit is deliberately left out of the embedded sources and the kit packs
// (cmake/gen_script_data.py, gen_kit_packs.py skip "_" folders), so this checks a real kit instead.
TEST_CASE("loader: bundles real kits (embedded)") {
  const script::KitLookup& real = script::default_kits();
  REQUIRE(real);
  CHECK(real("kits/core/init.luau").has_value());
  CHECK(real("kits/rpg/init.luau").has_value());
  CHECK_FALSE(real("kits/_template/init.luau").has_value());
}

TEST_CASE("loader: loads kit modules, submodules, siblings and declared deps, cached per game") {
  // TS checks kitDependencies() of its fake map; here the dependencies are the real catalog's.
  const pkg::Catalog& cat = pkg::Catalog::get();
  REQUIRE(cat.kit("combat"));
  REQUIRE(cat.kit("procgen"));
  CHECK(cat.kit("combat")->requires_kits == std::vector<std::string>{"procgen"});
  CHECK(cat.kit("procgen")->requires_kits.empty());
  CHECK(cat.expand_kits({"combat"}) == std::vector<std::string>{"combat", "procgen"});

  FileMap files = game(R"(kits = ["combat"])", R"(
      local KIT = "@kit/"
      local rpg = require("@kit/combat")
      local again = require("@kit/combat")
      print(rpg.hello("fox"), rpg == again, rpg.core)
      print(require("@kit/combat/battle/moves").tackle, require("@kit/combat/battle/moves").kitLoads)
      print("sub", require("@kit/combat/battle").name)
      print("core direct", require("@kit/procgen").name)
      print(pcall(function() return require("@kit/combat/sneaky") end))
      print(pcall(function() return require("@kit/combat/nope") end))
      print(pcall(function() return require(KIT .. "platformer") end))
    )");
  Game g = start_fake(files, fake_main());
  CHECK_NO_ERRORS(g);
  // TS g.enabledKits: the host's enabled list is the manifest's kits expanded by the catalog
  // (host.cpp), checked above.
  std::string l = g.log_text();
  CHECK(contains(l, "hi fox false\ttrue\tcore"));
  CHECK(contains(l, "10\t1"));
  CHECK(contains(l, "sub\tbattle"));
  CHECK(contains(l, "core direct\tcore"));
  CHECK(matches(l, R"(false\t.*escapes kits\/combat\/)"));
  CHECK(matches(l, R"(false\t.*kit module kits\/combat\/nope.luau not found)"));
  CHECK(matches(l, R"(false\t.*kit "platformer" is not enabled \(add kits = \["platformer"\])"));
  // The validator saw the dependency map too: no "kit not enabled" issue for @kit/procgen.
  // (engine-web logs validator warnings as "[validate] ..." lines; the C++ host doesn't, so the
  // package's validation issues are checked directly.)
  auto f = pkg::Files::from_map(files);
  REQUIRE(f.ok());
  pkg::LoadResult r = pkg::load_package(std::move(f).value());
  for (const auto& issue : r.issues) CHECK_FALSE(contains(pkg::format_issue(issue), "procgen"));
}

TEST_CASE("loader: kits require their declared deps (cross-kit); undeclared ones get a kit.json hint") {
  Game g = start_fake(game(R"(kits = ["combat"])", R"(
      local c = require("@kit/combat")
      print("roll", c.roll())
      print(pcall(c.bad))
    )"),
                      fake_cross());
  std::string l = g.log_text();
  CHECK(contains(l, "roll\t4"));
  CHECK(matches(l, R"(in kit "combat": kit "platformer" is not enabled \(declare it in kits\/combat\/kit.json "requires"\))"));
}

TEST_CASE("loader: a game without the kit in its manifest can't require it") {
  // TS uses its fake "rpg"; the real rpg name works the same (it isn't in the manifest).
  Game g = start_fake(game("", R"(local KIT = "@kit/" print(pcall(function() return require(KIT .. "rpg") end)))"), fake_main());
  CHECK(matches(g.log_text(), R"(kit "rpg" is not enabled)"));
}

}  // TEST_SUITE
