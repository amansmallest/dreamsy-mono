--!nonstrict
-- Milestone rewards: thresholds on any number (score, coins earned, levels cleared).
-- milestones.new({ { id?, at, reward? (core effects | value), label? }, ... }, { name?, onReach?(m) })
local P = require("./shared")
local M = {}
local MS = {}
MS.__index = MS
function M.new(list, opts)
	opts = opts or {}
	local items = {}
	for i, m in list do
		local c = table.clone(m)
		c.id = c.id or ("m" .. i)
		table.insert(items, c)
	end
	table.sort(items, function(a, b) return a.at < b.at end)
	return setmetatable({ items = items, reachedSet = {}, name = opts.name or "milestones", onReach = opts.onReach }, MS)
end
-- check(value) -> list of milestones newly reached (rewards applied through core when bound)
function MS:check(value: number)
	local out = {}
	for _, m in self.items do
		if value >= m.at and not self.reachedSet[m.id] then
			self.reachedSet[m.id] = true
			table.insert(out, m)
			if P.core and type(m.reward) == "table" then P.core.apply(m.reward, { milestone = m.id }) end
			if self.onReach then self.onReach(m) end
			if P.core then P.core.events.emit("milestone_reached", { milestone = m.id, set = self.name }) end
		end
	end
	return out
end
function MS:reached(id: string) return self.reachedSet[id] == true end
-- next(value) -> milestone, fraction (0..1 from the previous threshold), or nil when all reached
function MS:next(value: number)
	local prev = 0
	for _, m in self.items do
		if not self.reachedSet[m.id] then
			local span = m.at - prev
			return m, if span <= 0 then 1 else math.clamp((value - prev) / span, 0, 1)
		end
		prev = m.at
	end
	return nil, 1
end
function MS:serialize()
	local out = {}
	for id in self.reachedSet do table.insert(out, id) end
	table.sort(out)
	return out
end
function MS:deserialize(t)
	self.reachedSet = {}
	for _, id in t or {} do self.reachedSet[id] = true end
end
function MS:reset() self.reachedSet = {} end
return M
