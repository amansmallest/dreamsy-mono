--!nonstrict
-- internal: shared refs + config (defaults merged with data/runner.json / setup({ config })).
local S = {}
S.core = require("@kit/core")
S.prog = require("@kit/progression")
S.procgen = require("@kit/procgen")

S.DEFAULTS = {
	currency = "coins", currencyName = "Coins",
	lanes = 3,
	rowLength = 4,          -- metres per segment row
	gapRows = 2,            -- empty rows between segments
	viewAhead = 60,         -- metres of track kept generated ahead
	hitWindow = 0.5,        -- metres: obstacle overlap length
	-- speed / difficulty by distance (progression difficulty tiers: numbers lerp)
	speed = {
		{ at = 0, params = { speed = 10, tier = 0 } },
		{ at = 300, params = { speed = 12.5, tier = 1 } },
		{ at = 800, params = { speed = 15, tier = 2 } },
		{ at = 1600, params = { speed = 17.5, tier = 3 } },
		{ at = 2800, params = { speed = 20, tier = 4 } },
		{ at = 4500, params = { speed = 23, tier = 5 } },
	},
	tierSpread = 2,         -- segments of tier (t - spread .. t) are eligible
	biomes = { { id = "default", name = "Track", length = 600 } },  -- cycled by distance; segments filter by `biomes`
	-- player params (characters' mods apply to these via progression stats)
	player = { jumpTime = 0.62, slideTime = 0.6, laneTime = 0.12, magnetTime = 8, shieldTime = 12, doubleTime = 10,
		magnetRange = 10, lives = 1, coinValue = 1, scorePerMetre = 1, scorePerCoin = 5 },
	powerups = { M = "magnet", H = "shield", X = "double" },
	dailyModifiers = {
		{ id = "rush", name = "Rush hour", params = { speedMult = 1.25 } },
		{ id = "gold", name = "Gold rush", params = { coinMult = 2 } },
		{ id = "bare", name = "No power-ups", params = { noPowerups = true } },
	},
	daily = { base = 600, perDay = 0, spread = 400, reward = { { earn = "coins", amount = 150 } } },
	missionSlots = 3,
	-- obby physics (px, px/s)
	obby = { gravity = 2600, jump = 1000, run = 330, accel = 3000, airAccel = 2000, maxFall = 1400, coyote = 0.1, buffer = 0.12,
		w = 36, h = 52, ghostEvery = 6, respawnDelay = 0.5, killBelow = 260 },
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

S.KINDS = { "segments", "missions", "characters", "stages" }
function S.all(kind) return S.core.content.all(kind) end
function S.get(kind, id) return S.core.content.get(kind, id) end
function S.req(kind, id) return S.core.content.require(kind, id) end

return S
