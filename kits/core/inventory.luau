--!nonstrict
-- Inventories: slot-based stacks over item defs (content kind "items", data/items/*.json).
-- Item def: { id, name, description?, icon?, category?, stack? (max per stack, default 99; 1 = unstackable),
--             max? (total owned cap), value?, consumable? (default true when `use` is set), use? (effects), data? }
-- inventory.new({ id?, slots? (stack slots, nil = unlimited), categorySlots? { [cat] = n }, strict? (default true) })
-- Emits "item_gained"/"item_lost" {item, count, inventory}.
local S = require("./shared")
local Content = require("./content")

local Inv = {}
Inv.__index = Inv
local M = { byId = {} }

local function def(self, id)
	local d = Content.get("items", id)
	if d == nil then
		if self.strict then error("unknown item \"" .. tostring(id) .. "\" (add data/items/" .. tostring(id) .. ".json or content.register(\"items\", ...))", 3) end
		d = { id = id, name = id }
	end
	return d
end
local function stackOf(d) return math.max(1, d.stack or 99) end

function M.new(opts)
	opts = opts or {}
	local self = setmetatable({
		id = opts.id or "bag", slotCount = opts.slots, categorySlots = opts.categorySlots or {},
		strict = opts.strict ~= false, slots = {}, onChange = nil,
	}, Inv)
	M.byId[self.id] = self
	return self
end
function M.get(id: string) return M.byId[id] end

local function emit(self, name, id, n)
	if n > 0 and S.events then S.events.emit(name, { item = id, count = n, inventory = self.id }) end
	if n > 0 and self.onChange then self.onChange(self) end
end

function Inv:count(id: string): number
	local n = 0
	for _, s in self.slots do if s and s.id == id then n += s.n end end
	return n
end
function Inv:has(id: string, n: number?): boolean return self:count(id) >= (n or 1) end
function Inv:usedSlots(): number
	local n = 0
	for i, s in self.slots do if s then n += 1 end end
	return n
end
function Inv:freeSlots(): number?
	if not self.slotCount then return nil end
	return self.slotCount - self:usedSlots()
end
local function catUsed(self, cat)
	local n = 0
	for _, s in self.slots do
		if s and (Content.get("items", s.id) or {}).category == cat then n += 1 end
	end
	return n
end

-- how many of `id` would fit (≤ n)
function Inv:canAdd(id: string, n: number?): number
	n = n or 1
	local d = def(self, id)
	local per = stackOf(d)
	local room = 0
	for _, s in self.slots do if s and s.id == id then room += per - s.n end end
	local newStacks = math.huge
	if self.slotCount then newStacks = self.slotCount - self:usedSlots() end
	local cap = d.category and self.categorySlots[d.category]
	if cap then newStacks = math.min(newStacks, cap - catUsed(self, d.category)) end
	room += math.max(0, newStacks) * per
	if d.max then room = math.min(room, d.max - self:count(id)) end
	return math.clamp(math.min(room, n), 0, n)
end

-- add(id, n, all?): returns how many were added (all = true: all or nothing → 0 if they don't fit)
function Inv:add(id: string, n: number?, all: boolean?): number
	n = n or 1
	if n <= 0 then return 0 end
	local fit = self:canAdd(id, n)
	if all and fit < n then return 0 end
	local d = def(self, id)
	local per = stackOf(d)
	local left = fit
	for _, s in self.slots do
		if left <= 0 then break end
		if s and s.id == id and s.n < per then
			local k = math.min(per - s.n, left)
			s.n += k
			left -= k
		end
	end
	local i = 1
	while left > 0 do
		if self.slots[i] == nil or self.slots[i] == false then
			local k = math.min(per, left)
			self.slots[i] = { id = id, n = k }
			left -= k
		end
		i += 1
	end
	emit(self, "item_gained", id, fit)
	return fit
end

-- remove(id, n): all or nothing; true when removed. Takes from the last stacks first.
function Inv:remove(id: string, n: number?): boolean
	n = n or 1
	if self:count(id) < n then return false end
	local left = n
	for i = #self.slots, 1, -1 do
		local s = self.slots[i]
		if left <= 0 then break end
		if s and s.id == id then
			local k = math.min(s.n, left)
			s.n -= k
			left -= k
			if s.n <= 0 then self.slots[i] = false end
		end
	end
	self:_trim()
	emit(self, "item_lost", id, n)
	return true
end
function Inv:_trim()
	while #self.slots > 0 and not self.slots[#self.slots] do table.remove(self.slots) end
end
function Inv:removeAt(slot: number, n: number?): boolean
	local s = self.slots[slot]
	if not s then return false end
	n = math.min(n or s.n, s.n)
	s.n -= n
	if s.n <= 0 then self.slots[slot] = false end
	self:_trim()
	emit(self, "item_lost", s.id, n)
	return true
end

-- slot(i) -> {id, count, def} | nil ; list(category?) -> merged totals in first-seen order
function Inv:slot(i: number)
	local s = self.slots[i]
	if not s then return nil end
	return { id = s.id, count = s.n, def = Content.get("items", s.id) }
end
function Inv:list(category: string?)
	local out, at = {}, {}
	for _, s in self.slots do
		if s then
			local d = Content.get("items", s.id)
			if category == nil or (d and d.category == category) then
				if at[s.id] then out[at[s.id]].count += s.n
				else table.insert(out, { id = s.id, count = s.n, def = d }) at[s.id] = #out end
			end
		end
	end
	return out
end
function Inv:stacks()
	local out = {}
	for i, s in self.slots do if s then table.insert(out, { slot = i, id = s.id, count = s.n }) end end
	return out
end
-- move(a, b): merge into b if same item (up to stack size), else swap
function Inv:move(a: number, b: number)
	local sa, sb = self.slots[a], self.slots[b]
	if not sa or a == b then return end
	if sb and sb.id == sa.id then
		local per = stackOf(def(self, sa.id))
		local k = math.min(per - sb.n, sa.n)
		sb.n += k
		sa.n -= k
		if sa.n <= 0 then self.slots[a] = false end
	else
		for i = #self.slots + 1, math.max(a, b) do self.slots[i] = false end
		self.slots[a], self.slots[b] = sb or false, sa
	end
	self:_trim()
	if self.onChange then self.onChange(self) end
end
-- sort(by?): compact and order by category then name (or a comparator over {id, n})
function Inv:sort(by)
	local list = {}
	for _, s in self.slots do if s then table.insert(list, s) end end
	table.sort(list, by or function(x, y)
		local dx, dy = Content.get("items", x.id) or {}, Content.get("items", y.id) or {}
		local cx, cy = dx.category or "", dy.category or ""
		if cx ~= cy then return cx < cy end
		if x.id ~= y.id then return (dx.name or x.id) < (dy.name or y.id) end
		return x.n > y.n
	end)
	self.slots = list
	if self.onChange then self.onChange(self) end
end
-- use(id, ctx?): applies the def's `use` effects; consumes one when consumable. false if not owned/usable.
function Inv:use(id: string, ctx: any?): boolean
	if not self:has(id) then return false end
	local d = def(self, id)
	if d.use == nil then return false end
	if d.useCondition and S.conditions and not S.conditions.check(d.useCondition, ctx) then return false end
	if d.consumable ~= false then self:remove(id, 1) end
	if S.conditions then S.conditions.apply(d.use, ctx) end
	if S.events then S.events.emit("item_used", { item = id, inventory = self.id }) end
	return true
end
function Inv:clear()
	self.slots = {}
	if self.onChange then self.onChange(self) end
end
function Inv:serialize()
	local out = {}
	for i, s in self.slots do out[i] = if s then { s.id, s.n } else 0 end
	return out
end
function Inv:deserialize(t)
	self.slots = {}
	for i, s in t or {} do
		self.slots[i] = if type(s) == "table" then { id = s[1], n = s[2] } else false
	end
	self:_trim()
	if self.onChange then self.onChange(self) end
end

function M.item(id: string) return Content.get("items", id) end
return M
