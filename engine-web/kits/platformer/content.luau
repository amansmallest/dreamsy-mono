-- platformer kit: content (enemies, bosses, world) on the core content registry.
-- Default source: the game's data/<kind>/*.json and data/world.json via the engine data reader.
-- Tables registered from Luau (kit.setup / kit.content.register) take precedence over data files.
local CC = require("@kit/core").content

local C = {}

local registered: { [string]: boolean } = {} -- kinds registered from Luau or already read from data/
local files: { [string]: any } = {}

-- register(kind, id, def) or register(kind, { [id] = def, ... })
function C.register(kind: string, idOrMap, def)
	if type(idOrMap) == "string" then
		if type(def) ~= "table" then error("content.register(\"" .. kind .. "\", \"" .. idOrMap .. "\", def): def must be a table", 2) end
		if def.id == nil then def.id = idOrMap end
		CC.register(kind, def)
	elseif type(idOrMap) == "table" then
		for id, d in idOrMap do
			if type(d) == "table" and d.id == nil then d.id = id end
		end
		CC.register(kind, idOrMap)
	else
		error("content.register expects (kind, id, def) or (kind, { [id] = def })", 2)
	end
	registered[kind] = true
end

-- Read data/<kind>/*.json (once per kind unless forced). Returns the number of files read.
function C.load(kind: string): number
	registered[kind] = true
	return CC.load(kind)
end

local function ensure(kind: string)
	if not registered[kind] then C.load(kind) end
end

-- A whole JSON file (setFile override, else data.read).
function C.setFile(path: string, value) files[path] = value end
function C.file(path: string)
	if files[path] == nil and data.exists(path) then files[path] = data.read(path) end
	return files[path]
end

function C.get(kind: string, id: string)
	ensure(kind)
	local d = CC.get(kind, id)
	if d == nil then
		local known = CC.ids(kind)
		table.sort(known)
		error("platformer: no " .. kind .. " definition \"" .. tostring(id) .. "\" (known: " .. (if #known > 0 then table.concat(known, ", ") else "none — add data/" .. kind .. "/" .. tostring(id) .. ".json or kit.content.register") .. ")", 2)
	end
	return d
end

function C.has(kind: string, id: string): boolean
	ensure(kind)
	return CC.get(kind, id) ~= nil
end

-- { [id] = def }
function C.all(kind: string)
	ensure(kind)
	local out = {}
	for _, d in CC.all(kind) do out[d.id] = d end
	return out
end

function C.reset()
	for kind in registered do CC.clear(kind) end
	registered = {}
	files = {}
end

return C
