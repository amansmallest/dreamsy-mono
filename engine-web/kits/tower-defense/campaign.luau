-- tower-defense kit: campaign progress (level order, stars, unlocks, endless best) + save.
-- Progress is a plain table, so it round-trips through save.set/save.get unchanged. Campaign.load also registers
-- the campaign as core.save section "td_campaign", so core.save.save()/load() carry it in the game's one save.
local core = require("@kit/core")
local U = require("@kit/tower-defense/util")
local Content = require("@kit/tower-defense/content")

local Campaign = {}
local CampM = {}
CampM.__index = CampM

Campaign.SAVE_KEY = "td_progress"

local function emptyProgress()
	return { version = 1, levels = {}, endless = {}, extra = {} }
end

-- progress: from :serialize() / save.get (nil = fresh campaign).
function Campaign.new(content, progress)
	local C = Content.load(content)
	if not C.campaign then
		error("tower-defense: content has no campaign (data/campaign.json)", 2)
	end
	local self = setmetatable({ C = C, camp = C.campaign, events = U.events() }, CampM)
	self:deserialize(progress)
	return self
end

function CampM:on(name, fn)
	return self.events.on(name, fn)
end

function CampM:levelIndex(levelId)
	for i, cl in self.camp.levels do
		if cl.level == levelId then
			return i
		end
	end
	return nil
end

function CampM:stars(levelId)
	local p = self.progress.levels[levelId]
	return if p then p.stars or 0 else 0
end

function CampM:totalStars()
	local n = 0
	for _, p in self.progress.levels do
		n += p.stars or 0
	end
	return n
end

function CampM:isCleared(levelId)
	return self:stars(levelId) > 0
end

-- A level is playable when the previous one is cleared and the star requirement is met.
function CampM:isUnlocked(levelId)
	local i = self:levelIndex(levelId)
	if not i then
		return false
	end
	local cl = self.camp.levels[i]
	if i > 1 and not self:isCleared(self.camp.levels[i - 1].level) then
		return false
	end
	return self:totalStars() >= (cl.requires_stars or 0)
end

-- Level list for a level-select screen.
function CampM:levels()
	local out = {}
	for i, cl in self.camp.levels do
		local l = self.C.levels[cl.level]
		table.insert(out, {
			index = i, id = cl.level, name = l.name or cl.level, unlocked = self:isUnlocked(cl.level),
			stars = self:stars(cl.level), requiresStars = cl.requires_stars or 0, waves = #self.C.waves[l.waves].waves,
		})
	end
	return out
end

-- Towers + unlocked branches available now: start set + rewards of every cleared level.
function CampM:unlocks()
	local towers = U.set(self.camp.start_towers)
	local locked = U.set(self.camp.locked_branches)
	for _, cl in self.camp.levels do
		if self:isCleared(cl.level) and cl.unlock then
			for _, t in cl.unlock.towers or {} do
				towers[t] = true
			end
			for _, b in cl.unlock.branches or {} do
				locked[b] = nil
			end
		end
	end
	return towers, locked
end

function CampM:unlockedTowers()
	local towers = self:unlocks()
	return U.keys(towers)
end

-- Sim.new options for a level under this progress.
function CampM:simOptions(levelId, extra)
	local towers, locked = self:unlocks()
	local o = { towers = towers, lockedBranches = U.keys(locked) }
	for k, v in extra or {} do
		o[k] = v
	end
	return o
end

-- Sim.new options for endless mode (campaign.endless = { level, waves?, requires? }).
function CampM:endlessOptions(extra)
	local e = self.camp.endless
	local o = self:simOptions(e.level, extra)
	o.endless = true
	o.waves = e.waves
	return o, e.level
end

function CampM:endlessBest()
	local e = self.camp.endless
	return if e then self.progress.endless[e.level] or 0 else 0
end

function CampM:endlessUnlocked()
	local e = self.camp.endless
	if not e then
		return false
	end
	if e.requires then
		return self:isCleared(e.requires)
	end
	return self:isCleared(self.camp.levels[#self.camp.levels].level)
end

-- Record a finished level (Sim:result()). Returns { stars, newBest, unlocked = { towers = {}, branches = {} } }.
function CampM:complete(result)
	local out = { stars = result.stars or 0, newBest = false, unlocked = { towers = {}, branches = {} } }
	if result.endless then
		local key = result.level
		local best = self.progress.endless[key] or 0
		local reached = math.max(0, (result.wave or 0) - (if result.lost then 1 else 0))
		if reached > best then
			self.progress.endless[key] = reached
			out.newBest = true
		end
		out.wavesSurvived = reached
		self.events.emit("endlessFinished", key, reached, out.newBest)
		return out
	end
	if not result.won then
		return out
	end
	local before = U.set(self:unlockedTowers())
	local _, lockedBefore = self:unlocks()
	local id = result.level
	local p = self.progress.levels[id] or { stars = 0 }
	if result.stars > (p.stars or 0) then
		p.stars = result.stars
		out.newBest = true
	end
	p.bestLives = math.max(p.bestLives or 0, result.lives or 0)
	p.plays = (p.plays or 0) + 1
	self.progress.levels[id] = p
	local after = self:unlockedTowers()
	for _, t in after do
		if not before[t] then
			table.insert(out.unlocked.towers, t)
		end
	end
	local _, lockedAfter = self:unlocks()
	for b in lockedBefore do
		if not lockedAfter[b] then
			table.insert(out.unlocked.branches, b)
		end
	end
	table.sort(out.unlocked.branches)
	self.events.emit("levelCompleted", id, out)
	return out
end

function CampM:serialize()
	return U.deepCopy(self.progress)
end

-- core.save section protocol (deserialize(nil) / reset() = fresh progress)
function CampM:deserialize(t)
	self.progress = if type(t) == "table" then U.deepCopy(t) else emptyProgress()
	self.progress.levels = self.progress.levels or {}
	self.progress.endless = self.progress.endless or {}
	self.progress.extra = self.progress.extra or {}
end
function CampM:reset()
	self:deserialize(nil)
end

-- Persistence through the engine's save global (no-ops headless if `save` is missing).
function CampM:save(key)
	if save then
		save.set(key or Campaign.SAVE_KEY, self:serialize())
	end
end

function Campaign.load(content, key)
	local p = if save then save.get(key or Campaign.SAVE_KEY) else nil
	local camp = Campaign.new(content, p)
	core.save.section("td_campaign", camp)
	return camp
end

return Campaign
