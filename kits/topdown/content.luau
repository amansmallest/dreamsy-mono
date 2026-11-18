-- topdown kit: content (items, enemies, bosses, npcs, warps) on the core content registry.
-- Default source: the game's data/<kind>/*.json + data/warps.json (engine data reader); tables passed to
-- kit.setup / content.register override (tests, generated content).
local core = require("@kit/core")

local C = {}
C.KINDS = { "items", "enemies", "bosses", "npcs", "warps" }
local loaded: { [string]: boolean } = {}

-- register(kind, id, def) or register(kind, { [id] = def, ... })
function C.register(kind: string, idOrMap, def)
	loaded[kind] = true
	if type(idOrMap) == "string" then
		if type(def) ~= "table" then error("content.register(\"" .. kind .. "\", \"" .. idOrMap .. "\", def): def must be a table", 2) end
		if def.id == nil then def.id = idOrMap end
		core.content.register(kind, def)
	elseif type(idOrMap) == "table" then
		for id, d in idOrMap do
			if type(d) == "table" then
				if d.id == nil then d.id = id end
				core.content.register(kind, d)
			end
		end
	else
		error("content.register expects (kind, id, def) or (kind, { [id] = def })", 2)
	end
end

-- data/<kind>/*.json (warps: data/warps.json, one id map). Returns the number of defs read.
function C.load(kind: string): number
	loaded[kind] = true
	if kind ~= "warps" then return core.content.load(kind) end
	if not data.exists("data/warps.json") then return 0 end
	local map = data.read("data/warps.json")
	C.register("warps", map)
	local n = 0
	for _ in map do n += 1 end
	return n
end

local function ensure(kind: string) if not loaded[kind] then C.load(kind) end end

function C.get(kind: string, id: string)
	ensure(kind)
	local d = core.content.get(kind, id)
	if d == nil then
		local known = core.content.ids(kind)
		table.sort(known)
		error("topdown: no " .. kind .. " definition \"" .. tostring(id) .. "\" (known: " .. (if #known > 0 then table.concat(known, ", ") else "none — add data/" .. kind .. "/" .. tostring(id) .. ".json or kit.content.register") .. ")", 2)
	end
	return d
end

function C.has(kind: string, id: string): boolean
	ensure(kind)
	return core.content.get(kind, id) ~= nil
end

function C.all(kind: string)
	ensure(kind)
	local out = {}
	for _, d in core.content.all(kind) do out[d.id] = d end
	return out
end

function C.reset()
	for _, k in C.KINDS do core.content.clear(k) end
	loaded = {}
end

return C
