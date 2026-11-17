// The catalog, data-file parsers and load_package() on real games. The rule-by-rule
// comparison with the TS validator lives in tests/conformance/conformance.py.
#include <filesystem>
#include <memory>
#include <string>

#include "doctest.h"
#include "pkg/catalog.h"
#include "pkg/formats.h"
#include "pkg/manifest.h"
#include "pkg/text.h"
#include "pkg/validate.h"

using namespace dreamsy;
using namespace dreamsy::pkg;
namespace fs = std::filesystem;

namespace {

const std::string kRoot = DREAMSY_REPO_ROOT;

LoadResult load_dir(const std::string& rel) {
  auto files = Files::from_dir(kRoot + "/" + rel);
  REQUIRE_MESSAGE(files.ok(), files.error());
  return load_package(std::move(files).value());
}

std::string errors_of(const LoadResult& r) {
  std::string out;
  for (const Issue& i : r.issues) out += format_issue(i) + "\n";
  return out;
}

}  // namespace

TEST_CASE("catalog: embedded from format/catalog.json and engine-web/kits") {
  const Catalog& c = Catalog::get();
  const EntityType* sprite = c.type("Sprite2D");
  REQUIRE(sprite);
  CHECK(sprite->dimension == Dimension::D2);
  CHECK(sprite->container);
  const PropDef* pos = sprite->prop("position");
  REQUIRE(pos);
  CHECK(pos->kind == PropKind::Vec2);
  REQUIRE(pos->default_value);
  CHECK(pos->default_value->num[0] == 0);
  const PropDef* tex = sprite->prop("texture");
  REQUIRE(tex);
  CHECK(tex->kind == PropKind::Asset);
  CHECK(tex->asset_kind == AssetKind::Image);
  CHECK_FALSE(tex->default_value);
  REQUIRE(c.type("TileMap2D"));
  CHECK_FALSE(c.type("TileMap2D")->container);
  CHECK_FALSE(c.type("Nope"));
  REQUIRE(c.style("pixel"));
  CHECK(c.style("pixel")->dimensions == std::vector<std::string>{"2d"});

  CHECK(c.kits().size() == 21);
  CHECK_FALSE(c.kit("_template"));
  // rpg -> core, progression, combat (-> procgen), juice; discovery order like format/src/kits.ts.
  CHECK(c.expand_kits({"rpg"}) == std::vector<std::string>{"rpg", "core", "progression", "combat", "procgen", "juice"});
  CHECK(c.expand_kits({"juice", "rpg"}).front() == "juice");
}

TEST_CASE("manifest: defaults, strictness, TOML errors") {
  auto m = parse_manifest("format = \"0\"\nname = \"X\"\ndimension = \"2d\"\nentry_scene = \"scenes/main.scene.json\"\n");
  REQUIRE_MESSAGE(m.ok(), m.error());
  CHECK(m.value().players_max == 1);
  CHECK(m.value().server_mode == "none");
  CHECK(m.value().server_tick_rate == 30);
  CHECK(m.value().style.preset == "clean");
  CHECK_FALSE(m.value().portrait());
  CHECK(m.value().reference_width() == 1280);

  auto bad = parse_manifest("format = \"0\"\nname = \"\"\ndimension = \"4d\"\nentry_scene = \"x\"\ncolour = 1\n");
  REQUIRE_FALSE(bad);
  for (const char* part : {"name: must not be empty", "dimension:", "entry_scene:", "unknown key \"colour\""}) {
    CHECK_MESSAGE(bad.error().find(part) != std::string::npos, bad.error());
  }
  auto toml = parse_manifest("name = ");
  REQUIRE_FALSE(toml);
  CHECK(starts_with(toml.error(), "not valid TOML:"));
}

TEST_CASE("tilemap grids: rows, padding, unknown characters") {
  CHECK(grid_rows("ab\r\ncd\n\n  \n") == std::vector<std::string>{"ab", "cd"});
  auto files = Files::from_map({{"data/tilesets/t.json", R"({"tiles": {"G": {"solid": true}}})"},
                                {"data/levels/l.txt", "G.G\nGxG\n"}})
                   .value();
  auto r = resolve_tilemap(files, "data/tilesets/t.json", "file:data/levels/l.txt");
  CHECK(r.cols == 3);
  CHECK(r.rows.size() == 2);
  REQUIRE(r.errors.size() == 1);
  CHECK(r.errors[0].find("character \"x\" (first at line 2, column 2)") != std::string::npos);
  CHECK(r.tileset->tiles.at('G').solid);
}

TEST_CASE("music: notes as text or list, song order") {
  auto m = parse_music(R"({"steps": 2, "channels": [{"notes": "C4 - . E4"}]})");
  REQUIRE(m.errors.empty());
  CHECK(m.value->channels[0].notes == std::vector<std::string>{"C4", "-", ".", "E4"});
  CHECK(m.value->song_order() == std::vector<int>{0, 1});
  CHECK(note_frequency("A4").value() == doctest::Approx(440.0));
  CHECK(note_frequency("C#5").value() == doctest::Approx(554.365).epsilon(0.001));
  CHECK_FALSE(note_frequency("H2"));
}

TEST_CASE("svg safety rules") {
  CHECK_FALSE(check_svg(R"svg(<svg viewBox="0 0 1 1"><rect fill="url(#g)"/></svg>)svg"));
  CHECK_FALSE(check_svg("<?xml version=\"1.0\"?>\n<svg viewBox=\"0 0 1 1\"></svg>"));
  CHECK(check_svg(R"(<svg viewBox="0 0 1 1"><SCRIPT/></svg>)").value() == "contains a disallowed element");
  CHECK(check_svg(R"(<svg viewBox="0 0 1 1"><a xlink:href="javascript:x"/></svg>)").has_value());
  CHECK(check_svg(R"svg(<svg viewBox="0 0 1 1"><rect fill="url('#g')"/></svg>)svg").has_value());  // same as the TS regex
  CHECK(check_svg("<svg></svg>").value() == "needs a viewBox");
}

TEST_CASE("every 2D example and showcase game loads") {
  int loaded = 0;
  for (const char* group : {"games/examples", "games/showcase"}) {
    for (const auto& entry : fs::directory_iterator(kRoot + "/" + group)) {
      if (!fs::exists(entry.path() / "dreamsy.toml") || entry.path().filename() == "block-tower") continue;
      CAPTURE(entry.path().string());
      auto files = Files::from_dir(entry.path().string());
      REQUIRE(files.ok());
      LoadResult r = load_package(std::move(files).value());
      CHECK_MESSAGE(r.ok, errors_of(r));
      ++loaded;
    }
  }
  CHECK(loaded >= 25);
}

TEST_CASE("the 3D example is rejected: Dreamsy is 2D/2.5D") {
  LoadResult r = load_dir("games/examples/block-tower");
  CHECK_FALSE(r.ok);
  bool found = false;
  for (const Issue& i : r.issues) found |= i.code == "manifest.dimension_unsupported";
  CHECK(found);
}

TEST_CASE("feature-demo loads into typed data") {
  LoadResult r = load_dir("games/examples/feature-demo");
  REQUIRE_MESSAGE(r.ok, errors_of(r));
  const Package& p = *r.package;
  CHECK(p.manifest.name == "Feature Demo");
  CHECK(p.manifest.portrait());
  CHECK(p.manifest.physics_layers->size() == 4);

  const SceneDef& scene = p.scenes.at("scenes/main.scene.json");
  CHECK(scene.root == "world");
  const EntityDef* player = scene.entity("player");
  REQUIRE(player);
  CHECK(player->type == "Body2D");
  CHECK(player->parent == "world");
  const PropValue* pos = player->prop("position");
  REQUIRE(pos);
  CHECK(pos->kind == PropKind::Vec2);
  CHECK(scene.entity("world")->parent.empty());

  CHECK(p.tilesets.count("data/tilesets/world.json"));
  CHECK(p.anims.count("data/anims/fox.json"));
  CHECK(p.sfx.size() == 4);
  CHECK(p.music.count("data/music/theme.json"));
  CHECK(p.assets.at("owl").kind == AssetKind::Image);
}

TEST_CASE("a game survives dir -> pack -> load with the same content") {
  auto dir = Files::from_dir(kRoot + "/games/examples/tile-quest");
  REQUIRE(dir.ok());
  Sha256Digest hash = dir.value().content_hash();
  auto packed = std::make_shared<const Files::Bytes>(dir.value().to_pack());
  auto files = Files::from_pack(packed);
  REQUIRE(files.ok());
  CHECK(files.value().content_hash() == hash);
  LoadResult r = load_package(std::move(files).value());
  REQUIRE_MESSAGE(r.ok, errors_of(r));
  CHECK(r.package->scenes.size() == 4);
}
