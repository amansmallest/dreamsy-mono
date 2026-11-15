--!nonstrict
-- internal: shared refs + run config (defaults merged with data/roguelite.json / setup({ config })).
local S = {}
S.core = require("@kit/core")
S.prog = require("@kit/progression")
S.procgen = require("@kit/procgen")
S.current = nil -- the live Run (nil between runs)

S.DEFAULTS = {
	runCurrency = "gold",                -- run-scoped (reset every run)
	metaCurrency = "embers",             -- persistent (meta tree, unlocks)
	metaName = "Embers",
	startGold = 0,
	choices = { 2, 3 },                  -- doors offered per step (min, max)
	-- room type weights for steps 2..n-1 (biome.weights overrides per key)
	weights = { combat = 50, elite = 10, treasure = 10, shop = 9, event = 12, rest = 9 },
	eliteFromStep = 3,                   -- no elites before this step
	scaling = { hpPerFloor = 0.14, damagePerFloor = 0.08, budgetBase = 3, budgetPerFloor = 1.6, eliteBudget = 1.6, eliteHp = 2.2, eliteDamage = 1.4 },
	rewards = { combatGold = { 6, 12 }, eliteGold = { 18, 28 }, bossGold = { 40, 60 }, goldPerFloor = 0.15 },
	rarity = { common = 60, uncommon = 30, rare = 10 },          -- relic choice rarity weights
	eliteRarity = { common = 30, uncommon = 50, rare = 20 },
	bossRarity = { uncommon = 40, rare = 60, boss = 40 },
	relicChoices = 3,
	shop = { relics = 3, actives = 1, prices = { common = 45, uncommon = 70, rare = 110, boss = 160, active = 60 }, heal = { price = 35, amount = 0.3 } },
	rest = { heal = 0.35, maxHp = 4 },  -- rest room: heal 35% of max HP, or +4 max HP
	heat = {},                           -- list of { name, description?, mods = { {stat, add?, pct?, mul?} } }; index = heat level
	meta = { perFloor = 6, perBoss = 20, perKill = 0.25, win = 40, heatBonus = 0.25 },  -- meta currency at run end
	baseStats = { hp = 30, damage = 3, fireRate = 1.5, speed = 80, crit = 0.05, critMult = 2, armor = 0, dodge = 0,
		lifesteal = 0, regen = 0, thorns = 0, luck = 0, goldMult = 1, healMult = 1, range = 1, projectiles = 1,
		enemyHp = 1, enemyDamage = 1, shopDiscount = 0, relicChoices = 0, activeCharge = 0 },
	roomTime = { combat = 8, elite = 10, treasure = 12, shop = 25, event = 20, rest = 10, boss = 15 }, -- s of non-fight time (sim run length)
	sim = { exposure = 0.32, approach = 2.5, enemyDps = 1 },
	saveRun = true,                      -- keep the live run in the save (mid-run resume)
}

S.config = table.clone(S.DEFAULTS)

function S.merge(dst, src)
	for k, v in src or {} do
		if type(v) == "table" and type(dst[k]) == "table" and #v == 0 and next(v) ~= nil then
			local t = table.clone(dst[k])
			S.merge(t, v)
			dst[k] = t
		else
			dst[k] = v
		end
	end
	return dst
end

-- content access (core content registry; kinds below)
S.KINDS = { "classes", "biomes", "relics", "synergies", "actives", "events", "enemies", "meta" }
function S.get(kind, id) return S.core.content.get(kind, id) end
function S.req(kind, id) return S.core.content.require(kind, id) end
function S.all(kind) return S.core.content.all(kind) end

function S.sortedBiomes()
	local list = S.all("biomes")
	local out = table.clone(list)
	table.sort(out, function(a, b)
		local oa, ob = a.order or 99, b.order or 99
		if oa ~= ob then return oa < ob end
		return a.id < b.id
	end)
	return out
end

return S
