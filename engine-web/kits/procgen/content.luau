-- Content loader: the game's data/<area>/* files through the engine data reader (data.list / data.read).
--   load("enemies") -> { [id] = table }   (.json: id = obj.id or file name)
--   load("rooms")   -> { [id] = "text" }  (.txt: \r removed, trailing newlines trimmed)
--   content({ "enemies", "loot", "rooms" }?) -> { enemies = {...}, loot = {...}, ... } (areas with no files are omitted)
local M = {}

M.AREAS = { "enemies", "loot", "rooms", "chunks", "statuses", "biomes", "words", "puzzles", "waves" }

local function stem(p: string): string
	return (string.match(p, "([^/]+)%.%w+$")) or p
end

function M.load(area: string): { [string]: any }
	local out = {}
	for _, p in data.list("data/" .. area) do
		if string.sub(p, -5) == ".json" then
			local v = data.read(p)
			if type(v) == "table" then out[if type(v.id) == "string" then v.id else stem(p)] = v end
		elseif string.sub(p, -4) == ".txt" then
			local t = string.gsub(data.read(p), "\r", "")
			t = string.gsub(t, "\n+$", "")
			out[stem(p)] = t
		end
	end
	return out
end

function M.content(areas: { string }?): { [string]: any }
	local out = {}
	for _, a in areas or M.AREAS do
		local m = M.load(a)
		if next(m) ~= nil then out[a] = m end
	end
	return out
end

return M
