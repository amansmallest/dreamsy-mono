--!nonstrict
-- Sprout Speedway: shared game state (wallet, driver level, garage, cup, medals) on core + progression + racing.
-- All numbers live in data/*.json; this module only wires them together.
local Racing = require("@kit/racing")
local core = require("@kit/core")
local prog = require("@kit/progression")
local G = { Racing = Racing, core = core, ready = false }

function G.init()
	if G.ready then return G end
	G.ready = true
	G.content = Racing.content.load()
	G.cfg = G.content.config
	core.setup({ items = {}, quests = {}, dialog = {}, achievements = {},
		currencies = { coins = { name = "Coins", icon = "asset:icon_coin", start = 150, max = 9999999 } },
		theme = { primary = "#e4572e", accent = "#ffd23f", background = "#23402c", text = "#fffbea", font = "bold" },
		save = { key = "sprout_speedway", version = 1 } })
	G.driver = prog.leveler({ name = "driver", curve = { kind = "quadratic", base = 20, linear = 80, maxLevel = 20 } })
	G.garage = Racing.garage.new({ cars = G.content.cars, upgrades = G.cfg.upgrades, currency = G.cfg.currency or "coins", start = "beetle_buggy" })
	G.cupDef = G.content.cups.sprout_cup
	G.cup = nil
	core.save.section("cup", {
		serialize = function() return if G.cup then G.cup:serialize() else nil end,
		deserialize = function(_, t)
			G.cup = nil
			if t then G.cup = Racing.cup.new(G.cupDef, {}) G.cup:deserialize(t) end
		end,
	})
	core.save.load()
	return G
end
function G.save() core.save.save() end

function G.trackIds()
	local ids = {}
	for id in G.content.tracks do table.insert(ids, id) end
	table.sort(ids, function(a, b) return (G.content.tracks[a].order or 0) < (G.content.tracks[b].order or 0) end)
	return ids
end

-- the player's car (garage stats with upgrades)
function G.playerSpec()
	local id = G.garage.selected
	local d = G.content.cars[id]
	return { id = "you", name = "You", sprite = d.sprite, stats = G.garage:stats(id) }
end
-- cup rivals get a little stronger each race (+3% top speed / accel per race)
function G.rivalSpecs(raceIndex: number)
	local out = {}
	for _, r in G.cupDef.rivals do
		local d = G.content.cars[r.car]
		local k = 0.03 * (raceIndex - 1)
		table.insert(out, { id = r.id, name = r.name, sprite = d.sprite, preset = r.preset, color = r.color,
			stats = Racing.car.stats(d, { { stat = "maxSpeed", pct = k }, { stat = "accel", pct = k } }) })
	end
	return out
end
function G.names()
	local n = { you = "You" }
	for _, r in G.cupDef.rivals do n[r.id] = r.name end
	return n
end

function G.newCup()
	local ids = { "you" }
	for _, r in G.cupDef.rivals do table.insert(ids, r.id) end
	G.cup = Racing.cup.new(G.cupDef, ids)
	G.save()
	return G.cup
end

-- race rewards: coins + driver xp by place
function G.reward(place: number)
	local coins = G.cfg.prize[place] or 10
	core.wallet.add("coins", coins)
	G.driver:add(G.cfg.xp[place] or 10)
	return coins
end

-- medal for a time trial total time: 3 gold, 2 silver, 1 bronze, 0 none
function G.medalFor(trackId: string, t: number): number
	local m = G.content.tracks[trackId].medals or {}
	if m.gold and t <= m.gold then return 3 elseif m.silver and t <= m.silver then return 2 elseif m.bronze and t <= m.bronze then return 1 end
	return 0
end
G.MEDALS = { [0] = "-", "Bronze", "Silver", "Gold" }
G.MEDAL_COINS = { 60, 120, 250 }
return G
