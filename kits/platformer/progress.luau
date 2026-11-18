-- platformer kit: persistent progress, stored as the "platformer" section of the core save (core.save).
-- { completed = {[level]=true}, best = {[level]=seconds}, coins = {[level]=best count},
--   gems = {[level]={[gemIndex]=true}}, secrets = {[level]={[areaIndex]=true}},
--   abilities = {[name]=true}, deaths = n, last = levelId }
local U = require("./util")
local core = require("@kit/core")

local P = {}
P.KEY = "platformer" -- core save section (also the pre-core save key, imported once)

local data = nil
local listeners = U.bus()
P.events = listeners

local function blank()
	return { completed = {}, best = {}, coins = {}, gems = {}, secrets = {}, abilities = {}, deaths = 0, last = nil, plays = 0 }
end

-- fill missing fields (string keys only: save data round-trips through JSON)
local function normalize(d)
	local b = blank()
	if type(d) ~= "table" then return b end
	for k, v in b do
		if d[k] == nil then d[k] = v end
	end
	return d
end

-- our section of the stored core save without restoring the other sections; else a legacy "platformer" key
local function stored()
	local snap = save.get(core.save.key)
	local d = type(snap) == "table" and type(snap.d) == "table" and snap.d[P.KEY]
	if d then return d end
	return save.get(P.KEY)
end

core.save.section(P.KEY, {
	serialize = function() return P.load() end,
	deserialize = function(_, t) data = normalize(t or stored()) end,
	reset = function() data = blank() end,
})

function P.load()
	if not data then data = normalize(stored()) end
	return data
end

function P.get()
	return P.load()
end

-- saves the whole core save (flags, wallet, … and this section)
function P.save()
	P.load()
	core.save.save()
	listeners:emit("saved", data)
end

function P.reset()
	data = blank()
	P.save()
end

-- forget the in-memory copy (tests; the next call re-reads save data)
function P.reload()
	data = nil
	return P.load()
end

function P.isComplete(id: string): boolean
	return P.load().completed[id] == true
end

function P.best(id: string): number?
	return P.load().best[id]
end

function P.gemsFound(id: string): number
	return U.count(P.load().gems[id] or {})
end

function P.totalGems(): number
	local n = 0
	for _, g in P.load().gems do n += U.count(g) end
	return n
end

function P.totalCoins(): number
	local n = 0
	for _, c in P.load().coins do n += c end
	return n
end

function P.completedCount(): number
	return U.count(P.load().completed)
end

function P.hasAbility(name: string): boolean
	return P.load().abilities[name] == true
end

function P.unlockAbility(name: string)
	local d = P.load()
	if d.abilities[name] then return end
	d.abilities[name] = true
	P.save()
	listeners:emit("ability", name)
	core.emit("ability_unlocked", { ability = name })
end

-- stats = { time, coins, gems = { [index] = true }, secrets = { [index] = true }, deaths }
-- Returns { first = bool, newBest = bool }.
function P.completeLevel(id: string, stats)
	local d = P.load()
	local first = not d.completed[id]
	d.completed[id] = true
	local newBest = false
	if stats.time and (d.best[id] == nil or stats.time < d.best[id]) then
		d.best[id] = math.floor(stats.time * 100 + 0.5) / 100
		newBest = true
	end
	if stats.coins and stats.coins > (d.coins[id] or 0) then d.coins[id] = stats.coins end
	d.gems[id] = d.gems[id] or {}
	for k in stats.gems or {} do d.gems[id][tostring(k)] = true end
	d.secrets[id] = d.secrets[id] or {}
	for k in stats.secrets or {} do d.secrets[id][tostring(k)] = true end
	d.deaths += stats.deaths or 0
	d.last = id
	P.save()
	listeners:emit("levelComplete", id, stats, first, newBest)
	core.emit("level_completed", { level = id, time = stats.time, coins = stats.coins, first = first, newBest = newBest })
	return { first = first, newBest = newBest }
end

-- record found gems mid-level (so they count even if the player quits)
function P.markGem(id: string, index: number)
	local d = P.load()
	d.gems[id] = d.gems[id] or {}
	d.gems[id][tostring(index)] = true
end

function P.hasGem(id: string, index: number): boolean
	local g = P.load().gems[id]
	return g ~= nil and g[tostring(index)] == true
end

function P.setLast(id: string)
	P.load().last = id
end

return P
