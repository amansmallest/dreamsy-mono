// store (Stars): owns / prompt / purchased / pending / consume against the in-memory host and a custom host.
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game, MemoryStoreHost, type StoreHost, type StorePurchase } from "../core/index.js";
import { simulate } from "../tools/playtest.js";

const MANIFEST = `format = "0"
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
`;

function pkg(script: string) {
  const scene = { format: "0", root: "world", entities: { world: { type: "Node2D", children: ["label"] }, label: { type: "UIText", props: { text: "" } } } };
  return Package.fromFiles({ "dreamsy.toml": MANIFEST, "scenes/main.scene.json": JSON.stringify(scene), "scripts/client/shop.luau": script });
}
const label = (g: Game) => g.world.byId.get("label")!.get<string>("text");
const flush = () => new Promise((r) => setTimeout(r, 0));
const noErrors = (g: Game) => expect(g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);

const SHOP = `
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
`;

describe("store", () => {
  it("items, prompt → purchased next tick, owns, consume (in-memory host)", async () => {
    const host = new MemoryStoreHost([
      { id: "vip", kind: "pass", name: "VIP", description: "", price: 100 },
      { id: "gems", kind: "consumable", name: "50 gems", description: "", price: 20 },
    ]);
    const g = await Game.load(pkg(SHOP), { store: host });
    expect(label(g)).toBe("2:vip:pass:100:50 gems | gems=0 vip=false pending=0");
    for (let i = 0; i < 6; i++) g.step();
    await flush(); // host resolves
    expect(label(g)).toMatch(/vip=false/); // not before the next tick
    g.step();
    expect(label(g)).toBe("2:vip:pass:100:50 gems bought:vip:mem_1 bought:gems:mem_2 | gems=50 vip=true pending=0");
    expect(host.unconsumed).toEqual([]);
    for (let i = 0; i < 40; i++) { g.step(); await flush(); }
    expect(label(g)).toMatch(/bought:gems:mem_2 err:true \| gems=50 vip=true/);
    expect(host.purchases.length).toBe(2);
    noErrors(g);
  });

  it("boot loads owned + pending; pending consumables are granted and consumed", async () => {
    const consumed: string[] = [];
    const host: StoreHost = {
      owned: async () => ["vip"],
      pending: async () => [{ itemId: "gems", purchaseId: "pur_old" }],
      prompt: async (): Promise<StorePurchase | null> => null, // user cancelled
      consume: async (id) => { consumed.push(id); },
    };
    const g = await Game.load(pkg(SHOP), { store: host });
    expect(label(g)).toBe("restored:pur_old 2:vip:pass:100:50 gems | gems=50 vip=true pending=0");
    for (let i = 0; i < 20; i++) { g.step(); await flush(); }
    expect(consumed).toEqual(["pur_old"]);
    expect(label(g)).not.toMatch(/bought/);
    noErrors(g);
  });

  it("host failures are logged, not fatal", async () => {
    const host: StoreHost = {
      owned: async () => { throw new Error("offline"); },
      pending: async () => [],
      prompt: async () => { throw new Error("402"); },
      consume: async () => {},
    };
    const g = await Game.load(pkg(SHOP), { store: host });
    for (let i = 0; i < 20; i++) { g.step(); await flush(); }
    expect(g.logs.map((l) => l.text).join("\n")).toMatch(/could not load purchases: offline[\s\S]*purchase of "vip" failed: 402/);
    noErrors(g);
  });

  it("playtest simulate() defaults to the in-memory store and delivers purchases", async () => {
    const r = await simulate(pkg(SHOP + `\nstore.purchased:connect(function(id) print("PURCHASED " .. id) end)`), [], 1);
    expect(r.errors).toEqual([]);
    expect(r.logs.filter((l) => l.includes("PURCHASED"))).toEqual(["[info] PURCHASED vip", "[info] PURCHASED gems"]);
  });
});
