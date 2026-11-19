--!nonstrict
-- Cups: N races, points per place, standings with tie-break (more wins, then better last result).
local M = {}
local C = {}
C.__index = C
M.POINTS = { 10, 7, 5, 3, 2, 1 }

-- new(def { id, name, tracks = {ids}, points? , laps?, difficulty?, reward? }, entrants = { ids }) -> cup
function M.new(def, entrants)
	local self = setmetatable({ def = def, id = def.id, tracks = def.tracks or def.races or {}, points = def.points or M.POINTS,
		race = 1, table = {}, wins = {}, last = {}, history = {} }, C)
	for _, id in entrants or {} do self.table[id] = 0 self.wins[id] = 0 end
	return self
end
function C:track(): string? return self.tracks[self.race] end
function C:isDone(): boolean return self.race > #self.tracks end
function C:pointsFor(place: number): number return self.points[place] or 0 end
-- record(order = { id1st, id2nd, ... } | race:results()) -> { [id] = points gained }
function C:record(order)
	local gained = {}
	for place, e in order do
		local id = if type(e) == "table" then e.id else e
		local pts = if type(e) == "table" and e.out then 0 else self:pointsFor(place)
		self.table[id] = (self.table[id] or 0) + pts
		self.last[id] = place
		if place == 1 then self.wins[id] = (self.wins[id] or 0) + 1 end
		gained[id] = pts
	end
	table.insert(self.history, gained)
	self.race += 1
	return gained
end
-- standings() -> { {id, points, wins, place} } best first
function C:standings()
	local out = {}
	for id, p in self.table do table.insert(out, { id = id, points = p, wins = self.wins[id] or 0, last = self.last[id] or 99 }) end
	table.sort(out, function(a, b)
		if a.points ~= b.points then return a.points > b.points end
		if a.wins ~= b.wins then return a.wins > b.wins end
		if a.last ~= b.last then return a.last < b.last end
		return a.id < b.id
	end)
	for i, e in out do e.place = i end
	return out
end
function C:placeOf(id: string): number
	for _, e in self:standings() do if e.id == id then return e.place end end
	return 0
end
function C:serialize() return { r = self.race, t = self.table, w = self.wins, l = self.last } end
function C:deserialize(t)
	if not t then return end
	self.race, self.table, self.wins, self.last = t.r or 1, t.t or {}, t.w or {}, t.l or {}
end
return M
