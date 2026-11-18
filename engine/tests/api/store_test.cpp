// store (Stars): items / prompt / purchased / owns / pending / consume against the host's built-in
// in-memory store (engine-web MemoryStoreHost). Port of engine-web/test/store.test.ts.
//
// The C++ Host has no pluggable store backend yet (engine-web's StoreHost: owned/pending loaded at
// boot, a prompt that the user cancels, host failures), so "boot loads owned + pending" and "host
// failures are logged, not fatal" are not ported (app integration: DREAMSY.MD §14.10 E6/E9).
#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kManifest = R"(format = "0"
name = "Shop"
dimension = "2d"
entry_scene = "scenes/main.scene.json"

[[store]]
id = "vip"
kind = "pass"
name = "VIP"
description = "Gold hat"
price = 100

[[store]]
id = "gems"
kind = "consumable"
name = "50 gems"
price = 20
)";

FileMap package_files(const std::string& script) {
  return {
      {"dreamsy.toml", kManifest},
      {"scenes/main.scene.json",
       R"({"format": "0", "root": "world", "entities": {"world": {"type": "Node2D", "children": ["label"]}, "label": {"type": "UIText", "props": {"text": ""}}}})"},
      {"scripts/client/shop.luau", script},
  };
}

std::string label(const Game& g) { return g->world().str(g.entity("label"), "text"); }

const char* kShop = R"(
local gems = 0
local log = {}
local function show() entity("label").text = table.concat(log, " ") .. " | gems=" .. gems .. " vip=" .. tostring(store.owns("vip")) .. " pending=" .. #store.pending() end
-- grant consumables bought earlier (e.g. while the game was closed)
for _, p in store.pending() do
  gems += 50
  store.consume(p.purchaseId)
  table.insert(log, "restored:" .. p.purchaseId)
end
store.purchased:connect(function(itemId, purchaseId)
  table.insert(log, "bought:" .. itemId .. ":" .. purchaseId)
  if itemId == "gems" then
    gems += 50
    store.consume(purchaseId)
  end
  show()
end)
local items = store.items()
table.insert(log, #items .. ":" .. items[1].id .. ":" .. items[1].kind .. ":" .. items[1].price .. ":" .. items[2].name)
show()
after(0.1, function() store.prompt("vip") store.prompt("gems") end)
after(0.5, function() store.prompt("vip") end) -- already owned: nothing happens
after(0.6, function()
  local ok, err = pcall(store.prompt, "nope")
  table.insert(log, "err:" .. tostring(string.find(tostring(err), 'no item "nope"') ~= nil))
  show()
end)
)";

}  // namespace

TEST_SUITE("api store") {

TEST_CASE("store: items, prompt -> purchased next tick, owns, consume (in-memory host)") {
  Game g = start(package_files(kShop));
  CHECK(label(g) == "2:vip:pass:100:50 gems | gems=0 vip=false pending=0");
  g.step(6);
  CHECK(matches(label(g), R"(vip=false)"));  // not before the next tick
  g.step();
  // pending=0: the consumable was consumed (TS host.unconsumed == []).
  CHECK(label(g) == "2:vip:pass:100:50 gems bought:vip:mem_1 bought:gems:mem_2 | gems=50 vip=true pending=0");
  g.step(40);
  // The second prompt("vip") made no purchase (TS host.purchases.length == 2): no third "bought:".
  CHECK(matches(label(g), R"(bought:gems:mem_2 err:true \| gems=50 vip=true)"));
  CHECK_FALSE(contains(label(g), "mem_3"));
  CHECK_NO_ERRORS(g);
}

TEST_CASE("store: playtest simulate() defaults to the in-memory store and delivers purchases") {
  PlaytestReport r = simulate(package_files(std::string(kShop) + "\nstore.purchased:connect(function(id) print(\"PURCHASED \" .. id) end)"), {}, 1);
  CHECK(r.errors.empty());
  std::vector<std::string> purchased;
  for (const std::string& l : r.logs)
    if (contains(l, "PURCHASED")) purchased.push_back(l);
  CHECK(purchased == std::vector<std::string>{"[info] PURCHASED vip", "[info] PURCHASED gems"});
}

}  // TEST_SUITE
