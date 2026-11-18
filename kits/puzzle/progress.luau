--!nonstrict
-- Progress: best stars/moves per level, pack unlocks by stars (core condition {"puzzleStars": n, "pack"?: id}),
-- saved as the core save section "puzzle" (core.save.save() after every record).
local core = require("@kit/core")
local Packs = require("./packs")
local M = {}
local rec = {}      -- rec[pack][tostring(i)] = { s = stars, m = best moves }
local daily = {}    -- daily[tostring(day)] = stars
M.autosave = true

local function persist() if M.autosave then pcall(core.save.save) end end

function M.record(pack: string, i: number, stars: number, moves: number?): boolean
	rec[pack] = rec[pack] or {}
	local k = tostring(i)
	local r = rec[pack][k]
	local better = r == nil or stars > r.s or (moves ~= nil and r.m ~= nil and stars == r.s and moves < r.m)
	if better then rec[pack][k] = { s = math.max(stars, r and r.s or 0), m = math.min(moves or math.huge, r and r.m or math.huge) } end
	if rec[pack][k].m == math.huge then rec[pack][k].m = nil end
	core.emit("puzzle_stars", { pack = pack, level = i, stars = stars, total = M.totalStars() })
	persist()
	return better
end

function M.stars(pack: string, i: number): number local r = rec[pack] and rec[pack][tostring(i)] return r and r.s or 0 end
function M.best(pack: string, i: number): number? local r = rec[pack] and rec[pack][tostring(i)] return r and r.m end
function M.completed(pack: string, i: number): boolean return M.stars(pack, i) > 0 end
function M.packStars(pack: string): number
	local n = 0
	for _, r in rec[pack] or {} do n += r.s end
	return n
end
function M.packCompleted(pack: string): number
	local n = 0
	for _ in rec[pack] or {} do n += 1 end
	return n
end
function M.totalStars(): number
	local n = 0
	for p in rec do n += M.packStars(p) end
	for _, s in daily do n += s end
	return n
end

-- pack unlock: def.unlock = { stars = n } (total) | { pack = id, stars = n } | { completed = id } | any core condition
function M.isUnlocked(packOrId): boolean
	local p = if type(packOrId) == "string" then Packs.get(packOrId) else packOrId
	if not p or not p.unlock then return true end
	local u = p.unlock
	if u.stars and not u.puzzleStars then
		if u.pack then return M.packStars(u.pack) >= u.stars end
		return M.totalStars() >= u.stars
	end
	if u.completed then
		local q = Packs.get(u.completed)
		return q ~= nil and M.packCompleted(u.completed) >= q:count()
	end
	return core.check(u)
end
-- stars still needed (nil if not a star gate)
function M.starsNeeded(packOrId): number?
	local p = if type(packOrId) == "string" then Packs.get(packOrId) else packOrId
	local u = p and p.unlock
	if not u or not u.stars then return nil end
	local have = if u.pack then M.packStars(u.pack) else M.totalStars()
	return math.max(0, u.stars - have)
end

function M.levelUnlocked(packOrId, i: number): boolean
	local p = if type(packOrId) == "string" then Packs.get(packOrId) else packOrId
	if not M.isUnlocked(p) then return false end
	if p.gate == "open" or i <= 1 then return true end
	return M.completed(p.id, i - 1)
end
-- first unsolved level (or the last one)
function M.nextLevel(packOrId): number
	local p = if type(packOrId) == "string" then Packs.get(packOrId) else packOrId
	for i = 1, p:count() do if not M.completed(p.id, i) then return i end end
	return p:count()
end

function M.recordDaily(day: number, stars: number)
	local k = tostring(day)
	daily[k] = math.max(daily[k] or 0, stars)
	persist()
end
function M.dailyStars(day: number): number return daily[tostring(day)] or 0 end

function M.reset() rec, daily = {}, {} end
function M.serialize() return { rec = rec, daily = daily } end
function M.deserialize(t)
	rec = (t and t.rec) or {}
	daily = (t and t.daily) or {}
end

core.save.section("puzzle", { serialize = function() return M.serialize() end, deserialize = function(_, t) M.deserialize(t) end, reset = function() M.reset() end })
core.conditions.registerCondition("puzzleStars", function(c)
	local have = if c.pack then M.packStars(c.pack) else M.totalStars()
	return have >= c.puzzleStars
end)

return M
