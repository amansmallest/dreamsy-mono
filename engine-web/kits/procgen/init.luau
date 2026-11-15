-- procgen kit: deterministic, seeded generators -> TileMap2D data strings + spawn lists. See KIT.md.
local RNG = require("./rng")
local Grid = require("./grid")

local P = {}
P.VERSION = "0.1.0"

P.rng = RNG.new
P.RNG = RNG
P.Grid = Grid
P.grid = Grid.new
P.fromString = Grid.fromString
P.noise = require("./noise")
P.validate = require("./validate")
P.dungeon = require("./dungeon").generate
P.rooms = require("./rooms").generate
P.roomTemplates = require("./rooms").templates
P.caves = require("./caves")
P.chunks = require("./chunks")
P.terrain = require("./terrain").generate
P.BIOMES = require("./terrain").DEFAULT_BIOMES
P.loot = require("./loot")
P.waves = require("./waves")
P.names = require("./names")
P.puzzle = require("./puzzle")
local Content = require("./content")
P.load = Content.load       -- load("rooms") -> { [id] = text|table } from data/rooms/*
P.content = Content.content -- content({ "enemies", "loot", "rooms" }?) -> { enemies = {...}, loot = {...}, ... }

-- level|grid -> TileMap2D `data` string. map = { [genChar] = tilesetChar } (e.g. { ["#"] = "W", ["."] = "f" })
function P.toTileMap(levelOrGrid: any, map: any?): string
	local g = if Grid.is(levelOrGrid) then levelOrGrid else levelOrGrid.grid
	return g:toString(map)
end

-- cell (0-based) -> world centre, for a TileMap2D at `origin` (default 0,0) with `tileSize` (default 16)
function P.cellToWorld(x: number, y: number, tileSize: number?, origin: any?): (number, number)
	local ts = tileSize or 16
	local ox, oy = 0, 0
	if origin then ox, oy = origin.x or origin[1] or 0, origin.y or origin[2] or 0 end
	return ox + (x + 0.5) * ts, oy + (y + 0.5) * ts
end

--[[ spawn list in world coordinates: { {kind, x, y, cell = {x,y}, ...extra} } from level.spawns / markers
     opts: { tileSize = 16, origin = {x,y}, markers = { [char] = kind } (turn room-template markers into spawns),
             assign = { enemy = fn(rng, spawn) -> id }? (choose an id per spawn), rng|seed } ]]
function P.spawnList(level: any, opts: any?): { any }
	opts = opts or {}
	local rng = RNG.from(opts.rng or opts.seed or level.seed or 1)
	local out = {}
	local function push(kind, cx, cy, extra)
		local wx, wy = P.cellToWorld(cx, cy, opts.tileSize, opts.origin)
		local s = { kind = kind, x = wx, y = wy, cell = { x = cx, y = cy } }
		for k, v in extra or {} do if s[k] == nil then s[k] = v end end
		if opts.assign and opts.assign[kind] then s.id = opts.assign[kind](rng, s) end
		table.insert(out, s)
	end
	for _, s in level.spawns or {} do push(s.kind, s.x, s.y, s) end
	if opts.markers then
		for _, m in level.markers or {} do
			local kind = opts.markers[m.char]
			if kind then push(kind, m.x, m.y, { room = m.room }) end
		end
	end
	return out
end

-- random open cells at least `minDist` BFS steps from `from` (spread out), deterministic
function P.scatter(levelOrGrid: any, n: number, opts: any?): { any }
	opts = opts or {}
	local g = if Grid.is(levelOrGrid) then levelOrGrid else levelOrGrid.grid
	local rng = RNG.from(opts.rng or opts.seed or 1)
	local pass = Grid.passFn(opts.pass)
	local from = opts.from or (if not Grid.is(levelOrGrid) then levelOrGrid.start else nil)
	local dist = nil
	if from then dist = g:flood(from.x, from.y, pass) end
	local cand = {}
	for y = 0, g.h - 1 do
		for x = 0, g.w - 1 do
			if pass(g:get(x, y)) then
				local d = if dist then dist[y * g.w + x] else 999
				if d and d >= (opts.minDist or 0) then table.insert(cand, { x = x, y = y }) end
			end
		end
	end
	rng:shuffle(cand)
	local out = {}
	local gap = opts.gap or 0
	for _, c in cand do
		if #out >= n then break end
		local ok = true
		for _, o in out do if math.abs(o.x - c.x) + math.abs(o.y - c.y) < gap then ok = false break end end
		if ok then table.insert(out, c) end
	end
	return out
end

return P
