--!nonstrict
-- Content registry: item/quest/dialog/achievement/skill defs by kind.
-- Sources: the game's data/<kind>/*.json files (engine data reader: data.list + data.read), content.register(kind, defs)
-- (tables), or content.registerFiles({ ["data/items/apple.json"] = {...} }) (path-keyed, tests/tools);
-- content.setLoader(fn(kind) -> defs) overrides the reader.
local M = {}
local store: { [string]: { [string]: any } } = {}
local order: { [string]: { string } } = {}
local loader = nil

local function put(kind, id, def)
	if type(def) ~= "table" then error("content " .. kind .. ": \"" .. tostring(id) .. "\" must be a table", 4) end
	if def.id == nil then def.id = id end
	if type(def.id) ~= "string" then error("content " .. kind .. ": every def needs a string id", 4) end
	local s = store[kind]
	if not s then s = {} store[kind] = s order[kind] = {} end
	if s[def.id] == nil then table.insert(order[kind], def.id) end
	s[def.id] = def
end

-- register(kind, defs): defs = one def with .id, a list of defs, or a map id -> def
function M.register(kind: string, defs)
	if type(kind) ~= "string" or type(defs) ~= "table" then error("content.register(kind, defs) expects a kind string and a table", 2) end
	if type(defs.id) == "string" then put(kind, defs.id, defs) return end
	if #defs > 0 then
		for _, d in defs do put(kind, d.id, d) end
	else
		local keys = {}
		for k in defs do table.insert(keys, k) end
		table.sort(keys)
		for _, k in keys do put(kind, k, defs[k]) end
	end
end

function M.setLoader(fn) loader = fn end

-- registerFiles(map): path-keyed parsed files; "data/<kind>/<id>.json" → register(kind, def) (id defaults to the file name).
-- Returns the number of defs registered. Other paths are ignored.
function M.registerFiles(map)
	local paths = {}
	for p in map do table.insert(paths, p) end
	table.sort(paths)
	local n = 0
	for _, p in paths do
		local kind, id = string.match(p, "^data/([%w_%-]+)/([%w_%-]+)%.json$")
		if kind and type(map[p]) == "table" then
			local def = map[p]
			if def.id == nil then def.id = id end
			put(kind, def.id, def)
			n += 1
		end
	end
	return n
end

-- the game's data/<kind>/*.json through the engine data reader (id defaults to the file name)
local function engineLoad(kind)
	local out = {}
	for _, p in data.list("data/" .. kind) do
		if string.sub(p, -5) == ".json" then
			local def = data.read(p)
			if type(def) == "table" then
				if def.id == nil then def.id = string.match(p, "([^/]+)%.json$") end
				table.insert(out, def)
			end
		end
	end
	return out
end

-- load(kind): pull data/<kind>/*.json through the loader. Returns count loaded.
function M.load(kind: string): number
	local defs = if loader then loader(kind) else engineLoad(kind)
	if type(defs) ~= "table" then return 0 end
	local n = 0
	for _, d in defs do put(kind, d.id, d) n += 1 end
	return n
end

function M.get(kind: string, id: string) return store[kind] and store[kind][id] end
function M.require(kind: string, id: string)
	local d = store[kind] and store[kind][id]
	if d == nil then error("unknown " .. kind .. " \"" .. tostring(id) .. "\" (add data/" .. kind .. "/" .. tostring(id) .. ".json or content.register)", 3) end
	return d
end
function M.all(kind: string)
	local out = {}
	for _, id in order[kind] or {} do table.insert(out, store[kind][id]) end
	return out
end
function M.ids(kind: string) return table.clone(order[kind] or {}) end
function M.clear(kind: string?)
	if kind then store[kind] = nil order[kind] = nil else store = {} order = {} end
end
return M
