--!nonstrict
-- Content loader: data/racing.json (config) + data/tracks|cars|cups/*.json via the engine data reader. Id = file name.
local M = {}
local cache = nil
local function base(p) return (string.match(p, "([^/]+)%.json$")) end
local function readDir(dir)
	local out = {}
	if type(data) ~= "table" or type(data.list) ~= "function" then return out end
	for _, p in data.list(dir) do
		if string.sub(p, -5) == ".json" then
			local d = data.read(p)
			local id = base(p)
			if d.id ~= nil and d.id ~= id then error("racing: " .. p .. " id \"" .. tostring(d.id) .. "\" must match the file name", 3) end
			d.id = id
			out[id] = d
		end
	end
	return out
end
-- load(force?) -> { config, tracks = {id = def}, cars = {id = def}, cups = {id = def} }
function M.load(force: boolean?)
	if cache and not force then return cache end
	local cfg = {}
	if type(data) == "table" and data.exists and data.exists("data/racing.json") then cfg = data.read("data/racing.json") end
	cache = { config = cfg, tracks = readDir("data/tracks"), cars = readDir("data/cars"), cups = readDir("data/cups") }
	return cache
end
function M.set(c) cache = c end
return M
