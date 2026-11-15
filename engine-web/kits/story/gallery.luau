--!nonstrict
-- Persistent gallery (survives new games and every save slot): endings reached, CGs seen, chapters reached.
-- Stored in the engine save under one key (default "story_gallery").
local G = {}
G.__index = G

local function store() return if type(save) == "table" then save else nil end

function G.new(key: string?)
	local self = setmetatable({ key = key or "story_gallery", data = { endings = {}, cgs = {}, chapters = {} } }, G)
	self:load()
	return self
end

function G:load()
	local s = store()
	local d = s and s.get(self.key)
	if type(d) == "table" then
		self.data = { endings = d.endings or {}, cgs = d.cgs or {}, chapters = d.chapters or {} }
	end
end

function G:write()
	local s = store()
	if s then s.set(self.key, self.data) end
end

local function mark(self, kind, id)
	if id == nil or self.data[kind][id] then return false end
	self.data[kind][id] = true
	self:write()
	return true
end
function G:seeEnding(id) return mark(self, "endings", id) end
function G:seeCg(id) return mark(self, "cgs", id) end
function G:seeChapter(id) return mark(self, "chapters", id) end
function G:hasEnding(id) return self.data.endings[id] == true end
function G:hasCg(id) return self.data.cgs[id] == true end
function G:hasChapter(id) return self.data.chapters[id] == true end

-- list(defs, kind) -> { {id, def, seen} } in defs order (defs: map id -> def, or list with .id)
function G:list(defs, kind: string)
	local out = {}
	local ids = {}
	if defs then
		if #defs > 0 then for _, d in defs do table.insert(ids, d.id) end
		else for id in defs do table.insert(ids, id) end table.sort(ids, function(a, b)
			local da, db = defs[a], defs[b]
			local oa, ob = (type(da) == "table" and da.order) or 0, (type(db) == "table" and db.order) or 0
			if oa ~= ob then return oa < ob end
			return a < b
		end) end
	end
	for _, id in ids do
		local d = if #defs > 0 then nil else defs[id]
		if d == nil then for _, x in defs do if type(x) == "table" and x.id == id then d = x end end end
		table.insert(out, { id = id, def = d, seen = self.data[kind][id] == true })
	end
	return out
end

function G:reset()
	self.data = { endings = {}, cgs = {}, chapters = {} }
	self:write()
end

return G
