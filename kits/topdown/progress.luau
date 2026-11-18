-- topdown kit: persistent progress on @kit/core — owned items in core.bag, rupees in core.wallet ("rupees"),
-- story flags in core.flags, the rest in core.save section "topdown":
-- { ammo = {[id]=n}, hearts (max), keys = {[dungeon]=n}, boss_keys = {[dungeon]=true}, done = {["area:c:r"]=true}
--   (opened doors/chests, broken walls, taken pickups), visited = {[area]={["rx,ry"]=true}}, bosses = {[id]=true},
--   equipped, deaths, last = { scene, entry } }. The core save is loaded on first access.
local core = require("@kit/core")
local U = require("./util")
local Content = require("./content")

local P = {}
P.SECTION = "topdown"
P.CURRENCY = "rupees"
P.events = U.bus()

local data = nil
local loaded = false

local function blank()
	return { ammo = {}, hearts = nil, keys = {}, boss_keys = {}, done = {}, visited = {}, bosses = {}, equipped = nil, deaths = 0, last = nil }
end

core.wallet.define(P.CURRENCY, { name = "Rupees", max = 999 })
core.save.section(P.SECTION, {
	serialize = function() return data or blank() end,
	deserialize = function(_, t)
		local d = if type(t) == "table" then t else blank()
		for k, x in blank() do if d[k] == nil then d[k] = x end end
		data = d
		loaded = true
	end,
	reset = function() data = blank() end,
})

function P.load()
	if not loaded then
		loaded = true
		local ok, err = pcall(core.save.load)
		if not ok then print("[topdown] load failed: " .. tostring(err)) end
	end
	if not data then data = blank() end
	return data
end
P.get = P.load

function P.save()
	P.load()
	local ok, err = pcall(core.save.save)
	if not ok then print("[topdown] save failed: " .. tostring(err)) end
	P.events:emit("saved", data)
end

-- new game: resets every core save section (bag, wallet, flags, topdown, …) and saves
function P.reset()
	loaded = true
	core.newGame()
	P.save()
end

function P.reload()
	data, loaded = nil, false
	return P.load()
end

-- items (core.bag; ids without a data/items def get a stub def)
function P.has(id: string): boolean P.load() return core.bag:has(id) end
function P.items(): { string }
	P.load()
	local out = {}
	for _, s in core.bag:list() do table.insert(out, s.id) end
	table.sort(out)
	return out
end
function P.giveItem(id: string)
	P.load()
	local first = not core.bag:has(id)
	if first then
		if not Content.has("items", id) then Content.register("items", id, { name = id, kind = id }) end
		core.bag:add(id, 1)
	end
	P.events:emit("item", id, first)
	return first
end
function P.takeItem(id: string) P.load() core.bag:remove(id, core.bag:count(id)) end

function P.ammo(id: string): number return P.load().ammo[id] or 0 end
function P.addAmmo(id: string, n: number, max: number?)
	local d = P.load()
	d.ammo[id] = math.max(0, (d.ammo[id] or 0) + n)
	if max then d.ammo[id] = math.min(max, d.ammo[id]) end
end

-- currency (core.wallet "rupees", 0..999)
function P.rupees(): number P.load() return core.wallet.get(P.CURRENCY) end
function P.addRupees(n: number) P.load() core.wallet.add(P.CURRENCY, n) end

-- keys (scoped per dungeon)
function P.keys(dungeon: string): number return P.load().keys[dungeon] or 0 end
function P.addKey(dungeon: string, n: number?) local d = P.load() d.keys[dungeon] = (d.keys[dungeon] or 0) + (n or 1) end
function P.useKey(dungeon: string): boolean
	local d = P.load()
	if (d.keys[dungeon] or 0) <= 0 then return false end
	d.keys[dungeon] -= 1
	return true
end
function P.hasBossKey(dungeon: string): boolean return P.load().boss_keys[dungeon] == true end
function P.giveBossKey(dungeon: string) P.load().boss_keys[dungeon] = true end

-- flags (core.flags: story, NPC state; usable in core conditions {"flag": name})
function P.flag(name: string): boolean P.load() return core.flags.get(name) == true end
function P.setFlag(name: string, on: boolean?)
	P.load()
	core.flags.set(name, if on == false then nil else true)
	P.events:emit("flag", name, on ~= false)
end

-- one-shot world changes ("area:c:r")
function P.isDone(key: string): boolean return P.load().done[key] == true end
function P.markDone(key: string) P.load().done[key] = true end

function P.visit(area: string, rx: number, ry: number)
	local d = P.load()
	d.visited[area] = d.visited[area] or {}
	local k = rx .. "," .. ry
	if d.visited[area][k] then return false end
	d.visited[area][k] = true
	return true
end
function P.visited(area: string) return P.load().visited[area] or {} end

function P.bossDefeated(id: string): boolean return P.load().bosses[id] == true end
function P.defeatBoss(id: string) P.load().bosses[id] = true end

return P
