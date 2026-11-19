// A loaded, validated game package (docs/format.md §3), as typed C++ data.
//
// Produced by load_package() (validate.h). Everything here has passed the same checks as the
// TypeScript validator, so the runtime can rely on it: ids are unique, the scene trees are
// well-formed, props have the types the catalog promises, and referenced assets exist.
#pragma once

#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "pkg/catalog.h"
#include "pkg/files.h"

namespace dreamsy::pkg {

// ---------------------------------------------------------------- manifest (dreamsy.toml)

struct StoreItem {
  std::string id;
  std::string kind;  // "pass" | "consumable"
  std::string name;
  std::string description;
  int price = 0;
  std::optional<std::string> icon;  // "asset:<id>"
};

struct Manifest {
  std::string format = "0";
  std::optional<std::string> id;
  std::string name;
  std::optional<std::string> description;
  std::string dimension;                  // "2d" (the C++ engine rejects "3d")
  std::optional<std::string> orientation;  // absent = landscape (§11.1)
  std::optional<std::string> view;         // 2.5D view mode (§14.5): side | topdown | oblique | iso; absent = side
  std::string entry_scene;

  int players_min = 1;
  int players_max = 1;

  std::string server_mode = "none";  // "none" | "rooms" | "persistent" | "async"
  int server_tick_rate = 30;
  bool server_deterministic = false;

  std::optional<std::vector<std::string>> kits;
  bool avatar_enabled = false;
  std::optional<std::vector<std::string>> physics_layers;  // [physics] present

  struct Ui {
    std::optional<std::string> primary, accent, background, text, panel, font;
  };
  std::optional<Ui> ui;

  std::vector<StoreItem> store;

  struct Style {
    std::string preset = "clean";
    std::optional<std::string> pack;
    std::optional<std::vector<std::string>> palette;
    std::optional<std::string> notes;
    std::optional<std::vector<std::string>> references;
    std::optional<int> grid;  // 8 | 16 | 32
  } style;

  bool portrait() const { return orientation && *orientation == "portrait"; }
  // Reference screen: portrait 720x1280, landscape 1280x720 (format/src/schema.ts referenceSize).
  int reference_width() const { return portrait() ? 720 : 1280; }
  int reference_height() const { return portrait() ? 1280 : 720; }
};

// ---------------------------------------------------------------- scenes

struct EntityDef {
  std::string id;
  std::string type;
  std::optional<std::string> name;
  std::vector<std::pair<std::string, PropValue>> props;  // as written; unset props use catalog defaults
  std::vector<std::string> scripts;                       // scripts/client|server/*.luau
  std::vector<std::string> tags;
  std::vector<std::string> children;                      // ordered
  std::string parent;                                     // derived; empty for the root

  const PropValue* prop(std::string_view key) const;
};

struct SceneDef {
  std::string path;  // scenes/<name>.scene.json
  std::string root;
  std::optional<std::string> view;  // overrides Manifest::view for this scene
  std::vector<EntityDef> entities;  // file order
  std::unordered_map<std::string, size_t> index;  // id -> entities[i]

  const EntityDef* entity(std::string_view id) const;
};

// ---------------------------------------------------------------- assets and data files

struct AssetMeta {
  std::string id;
  AssetKind kind = AssetKind::Image;
  std::string file;  // name inside assets/
  std::optional<std::string> license;
};

struct TileDef {
  std::optional<std::string> sprite;  // "asset:<id>"
  std::optional<std::string> color;   // "#rrggbb" | "#rrggbbaa"
  bool solid = false;
  std::vector<std::string> tags;
};

struct Tileset {
  std::map<char, TileDef> tiles;  // keys are single printable ASCII characters
};

struct Anim {
  std::vector<std::string> frames;  // "asset:<id>"
  double fps = 10;
  bool loop = true;
  std::optional<std::string> next;
};
using AnimSet = std::vector<std::pair<std::string, Anim>>;  // file order

struct Sfx {
  std::string wave = "square";
  double attack = 0, sustain = 0.1, decay = 0.2, freq = 440, slide = 0, vibrato = 0, vibrato_speed = 6, duty = 0.5,
         volume = 0.5;
};

struct MusicChannel {
  std::string wave = "square";
  double volume = 0.4, duty = 0.5;
  std::vector<std::string> notes;  // "C4", "-" (hold), "." (rest)
};

struct Music {
  double bpm = 120;
  int steps = 16;
  std::vector<MusicChannel> channels;
  std::optional<std::vector<int>> order;
  bool loop = true;

  std::vector<int> song_order() const;  // format/src/audio.ts songOrder
};

// ---------------------------------------------------------------- the package

struct Package {
  Files files;
  Manifest manifest;
  std::map<std::string, SceneDef> scenes;      // by path
  std::map<std::string, AssetMeta> assets;     // by id
  std::map<std::string, Tileset> tilesets;     // by path
  std::map<std::string, AnimSet> anims;        // by path
  std::map<std::string, Sfx> sfx;              // by path
  std::map<std::string, Music> music;          // by path
};

}  // namespace dreamsy::pkg
