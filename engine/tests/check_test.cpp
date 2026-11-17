// dreamsy-tool check: catches typical script mistakes, stays quiet on valid games.
#include <filesystem>
#include <map>
#include <string>

#include "check/check.h"
#include "doctest.h"
#include "pkg/validate.h"

using namespace dreamsy;
namespace fs = std::filesystem;

namespace {

const std::string kRoot = DREAMSY_REPO_ROOT;

check::Report check_files(std::map<std::string, std::string> files) {
  files["dreamsy.toml"] = "format = \"0\"\nname = \"t\"\ndimension = \"2d\"\nentry_scene = \"scenes/main.scene.json\"\n";
  files["scenes/main.scene.json"] = R"({"format": "0", "root": "r", "entities": {"r": {"type": "Folder"}}})";
  auto f = pkg::Files::from_map(files);
  REQUIRE(f.ok());
  pkg::LoadResult r = pkg::load_package(std::move(f).value());
  REQUIRE(r.ok);
  auto report = check::check_package(*r.package);
  REQUIRE_MESSAGE(report.ok(), report.error());
  return std::move(report).value();
}

bool has(const check::Report& r, const std::string& severity, const std::string& needle) {
  for (const check::Issue& i : r.issues)
    if (i.severity == severity && i.message.find(needle) != std::string::npos) return true;
  return false;
}

}  // namespace

TEST_CASE("check: definitions include the catalog's entity props") {
  std::string_view defs = check::definitions();
  CHECK(defs.find("declare extern type Entity with") != std::string_view::npos);
  CHECK(defs.find("\tposition: Vec2") != std::string_view::npos);
  CHECK(defs.find("\tauto_flip: boolean") != std::string_view::npos);
  CHECK(defs.find("\n\t--@ENTITY_PROPS") == std::string_view::npos);  // the marker line was replaced
}

TEST_CASE("check: strict scripts get errors for real mistakes") {
  auto r = check_files({{"scripts/client/main.luau", R"(--!strict
local e = entity("player")
if e then
  e.positon = vec2(1, 2)
  e:applyImpulse(1, 2)
end
local n: number = "text"
after("soon", function() end)
local v = vec2(1, 2) + 3
)"}});
  CHECK(has(r, "error", "positon"));
  CHECK(has(r, "error", "'number', but got 'string'"));
  CHECK(has(r, "error", "Vec2"));
  CHECK(r.errors >= 4);
}

TEST_CASE("check: non-strict scripts get warnings; typos in globals are caught") {
  auto r = check_files({{"scripts/client/main.luau", "local p = entitiy('player')\nafter('soon', function() end)\n"}});
  CHECK(r.errors == 0);
  CHECK(has(r, "warning", "Unknown global 'entitiy'"));
  CHECK(has(r, "warning", "'number', but got 'string'"));
}

TEST_CASE("check: lenient findings in strict scripts are warnings") {
  auto r = check_files({{"scripts/client/main.luau", R"(--!strict
local hud = entity("hud")
print(hud.position)
local modes = { 1, 10, "max" }
local list = {}
table.insert(list, { id = 1 })
for _, item in list do print(item.id) end
print(script.entity.position)
)"}});
  CHECK(r.errors == 0);
}

TEST_CASE("check: requires resolve like the runtime (relative + kits)") {
  auto r = check_files({{"scripts/shared/config.luau", "--!strict\nreturn { speed = 5 }\n"},
                        {"scripts/client/main.luau", "--!strict\nlocal cfg = require('../shared/config')\nlocal s: string = cfg.speed\n"}});
  CHECK(has(r, "error", "'string', but got 'number'"));  // the module's type flowed through require
}

TEST_CASE("check: every valid game in the repo has zero errors") {
  for (const char* group : {"games/examples", "games/showcase"}) {
    for (const auto& entry : fs::directory_iterator(kRoot + "/" + group)) {
      if (!fs::exists(entry.path() / "dreamsy.toml") || entry.path().filename() == "block-tower") continue;
      CAPTURE(entry.path().string());
      auto files = pkg::Files::from_dir(entry.path().string());
      REQUIRE(files.ok());
      pkg::LoadResult loaded = pkg::load_package(std::move(files).value());
      REQUIRE(loaded.ok);
      auto report = check::check_package(*loaded.package);
      REQUIRE(report.ok());
      std::string errs;
      for (const check::Issue& i : report.value().issues)
        if (i.severity == "error") errs += i.file + ":" + std::to_string(i.line) + ": " + i.message + "\n";
      CHECK_MESSAGE(report.value().errors == 0, errs);
    }
  }
}
