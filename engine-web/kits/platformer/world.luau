-- platformer kit: world structure from data/world.json (schemas/world.json): worlds -> levels, unlock rules.
local Content = require("./content")
local Progress = require("./progress")

local W = {}
local cached = nil

-- Use a world table directly (otherwise data/world.json is read through the engine data reader).
function W.setData(t)
	if type(t) ~= "table" or type(t.worlds) ~= "table" then error("world data needs a worlds list: { worlds = { { id, name, levels = { { id, name, scene } } } } }", 2) end
	cached = t
	Content.setFile("data/world.json", t)
	W._index = nil
end

function W.data()
	if cached then return cached end
	local t = Content.file("data/world.json")
	if t == nil then error("platformer: no world data (add data/world.json, or call kit.world.setData({...}))", 2) end
	cached = t
	return t
end

-- is there world data (setData or data/world.json)?
function W.has(): boolean
	return cached ~= nil or Content.file("data/world.json") ~= nil
end

local function index()
	if W._index then return W._index end
	local list, byId = {}, {}
	for wi, w in W.data().worlds do
		for li, l in w.levels or {} do
			l.world = w.id
			l.worldIndex = wi
			l.levelIndex = li
			table.insert(list, l)
			l.order = #list
			byId[l.id] = l
		end
	end
	W._index = { list = list, byId = byId }
	return W._index
end

-- all levels in play order
function W.levels()
	return index().list
end

function W.level(id: string)
	return index().byId[id]
end

function W.worlds()
	return W.data().worlds
end

function W.levelForScene(scene: string)
	for _, l in W.levels() do
		if l.scene == scene then return l end
	end
	return nil
end

function W.mapScene(): string
	return W.data().map_scene or "scenes/world.scene.json"
end

-- Unlock rules (all must hold). Default: the previous level (play order) is complete.
--   { "after": ["1-3"] }          those levels complete
--   { "gems": 6 }                 total gems found
--   { "coins": 200 }              total best coins
--   { "levels": 5 }               levels complete
--   { "ability": "dash" }         ability unlocked
--   { "world": "w1" }             every non-secret level of world w1 complete
--   "open"                        always unlocked
function W.isUnlocked(id: string): boolean
	local l = W.level(id)
	if not l then return false end
	local rule = l.unlock
	if rule == "open" then return true end
	if rule == nil then
		if l.order == 1 then return true end
		local prev = W.levels()[l.order - 1]
		return Progress.isComplete(prev.id)
	end
	if type(rule) ~= "table" then return false end
	for _, dep in rule.after or {} do
		if not Progress.isComplete(dep) then return false end
	end
	if rule.gems and Progress.totalGems() < rule.gems then return false end
	if rule.coins and Progress.totalCoins() < rule.coins then return false end
	if rule.levels and Progress.completedCount() < rule.levels then return false end
	if rule.ability and not Progress.hasAbility(rule.ability) then return false end
	if rule.world then
		for _, w in W.worlds() do
			if w.id == rule.world then
				for _, x in w.levels do
					if not x.secret and not Progress.isComplete(x.id) then return false end
				end
			end
		end
	end
	return true
end

-- why a level is locked, for UI ("Find 6 gems")
function W.lockReason(id: string): string?
	if W.isUnlocked(id) then return nil end
	local l = W.level(id)
	local rule = l and l.unlock
	if type(rule) == "table" then
		if rule.gems and Progress.totalGems() < rule.gems then return "Find " .. rule.gems .. " gems (" .. Progress.totalGems() .. ")" end
		if rule.coins and Progress.totalCoins() < rule.coins then return "Collect " .. rule.coins .. " coins" end
		if rule.ability then return "Needs " .. string.gsub(rule.ability, "_", " ") end
		if rule.after and #rule.after > 0 then
			local dep = W.level(rule.after[1])
			return "Clear " .. ((dep and dep.name) or rule.after[1])
		end
		if rule.levels then return "Clear " .. rule.levels .. " levels" end
	end
	return "Locked"
end

function W.nextLevel(id: string)
	local l = W.level(id)
	if not l then return nil end
	return W.levels()[l.order + 1]
end

-- totals for a progress screen
function W.summary()
	local s = { levels = #W.levels(), complete = 0, gems = Progress.totalGems(), gemsTotal = 0 }
	for _, l in W.levels() do
		if Progress.isComplete(l.id) then s.complete += 1 end
		s.gemsTotal += l.gems or 0
	end
	return s
end

function W.reset()
	cached = nil
	W._index = nil
end

return W
