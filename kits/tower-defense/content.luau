-- tower-defense kit: content (enemies, towers, waves, levels, campaign) → normalized tables with defaults,
-- tower stat derivation through upgrade trees, level layouts, wave schedules.
local U = require("@kit/tower-defense/util")
local Path = require("@kit/tower-defense/path")

local Content = {}

local ENEMY_DEFAULTS = {
	hp = 20, speed = 1, armor = 0, bounty = 1, lives = 1, flying = false, boss = false, regen = 0, size = 0.6,
}
local TOWER_DEFAULTS = {
	cost = 50, range = 2.5, rate = 1, damage = 5, damage_type = "physical", ground = true, air = false,
	targeting = "first", income = 0,
}
Content.TARGETING = { "first", "last", "strong", "close" }
Content.ARMORLESS_TYPES = { magic = true, ["true"] = true }

local function withDefaults(t, defaults)
	local out = U.deepCopy(t)
	for k, v in defaults do
		if out[k] == nil then
			out[k] = v
		end
	end
	return out
end

local function fail(msg)
	error("tower-defense content: " .. msg, 0)
end

Content.AREAS = { "enemies", "towers", "waves", "levels" }

-- Read the raw content table from the game's package with the engine data reader:
-- <root>/{enemies,towers,waves,levels}/*.json (id = file name) + <root>/campaign.json. root defaults to "data".
function Content.read(root)
	root = root or "data"
	if type(data) ~= "table" or type(data.list) ~= "function" then
		fail("no engine data reader (data.list/data.read): pass a content table instead")
	end
	local raw = {}
	for _, area in Content.AREAS do
		local m = {}
		for _, p in data.list(root .. "/" .. area) do
			local id = string.match(p, "([^/]+)%.json$")
			if id then
				local def = data.read(p)
				m[def.id or id] = def
			end
		end
		raw[area] = m
	end
	if data.exists(root .. "/campaign.json") then
		raw.campaign = data.read(root .. "/campaign.json")
	end
	return raw
end

-- Normalize + cross-check a content table { enemies, towers, waves, levels, campaign }.
-- Accepts maps keyed by id or arrays of objects with `id`. Level `map.grid = "file:<path>"` is read with data.read.
function Content.load(raw)
	if raw.__normalized then
		return raw
	end
	local function byId(t, what)
		local m = {}
		for k, v in t or {} do
			local id = v.id or (if type(k) == "string" then k else nil)
			if not id then
				fail(what .. " entry without id")
			end
			v = table.clone(v)
			v.id = id
			m[id] = v
		end
		return m
	end
	local C = { __normalized = true, enemies = {}, towers = {}, waves = {}, levels = {}, campaign = nil }
	for id, e in byId(raw.enemies, "enemy") do
		C.enemies[id] = withDefaults(e, ENEMY_DEFAULTS)
		C.enemies[id].resist = e.resist or {}
		C.enemies[id].immune = U.set(e.immune)
	end
	for id, e in C.enemies do
		if e.split and not C.enemies[e.split.into] then
			fail("enemy " .. id .. " splits into unknown enemy '" .. tostring(e.split.into) .. "'")
		end
	end
	for id, t in byId(raw.towers, "tower") do
		local tw = withDefaults(t, TOWER_DEFAULTS)
		tw.upgrades = t.upgrades or {}
		tw.branches = t.branches or {}
		if #tw.branches > 2 then
			fail("tower " .. id .. " has more than 2 branches")
		end
		for i, b in tw.branches do
			b.id = b.id or (if i == 1 then "a" else "b")
			b.tiers = b.tiers or {}
		end
		C.towers[id] = tw
	end
	for id, w in byId(raw.waves, "wave set") do
		w.waves = w.waves or {}
		w.scaling = w.scaling or {}
		for wi, wave in w.waves do
			for _, g in wave.groups or {} do
				if not C.enemies[g.enemy] then
					fail("waves " .. id .. " wave " .. wi .. ": unknown enemy '" .. tostring(g.enemy) .. "'")
				end
			end
		end
		if w.endless then
			for _, e in w.endless.pool or {} do
				if not C.enemies[e] then
					fail("waves " .. id .. " endless pool: unknown enemy '" .. e .. "'")
				end
			end
		end
		C.waves[id] = w
	end
	for id, l in byId(raw.levels, "level") do
		l.money = l.money or 100
		l.lives = l.lives or 20
		l.sell_ratio = l.sell_ratio or 0.7
		l.between = l.between or 8
		l.early_bonus = l.early_bonus or 1
		l.interest = l.interest or { rate = 0, cap = 0 }
		if l.map and type(l.map.grid) == "string" and string.sub(l.map.grid, 1, 5) == "file:" then
			l.map = table.clone(l.map)
			l.map.grid = data.read(string.sub(l.map.grid, 6))
		end
		local wid = l.waves or id
		if not C.waves[wid] then
			fail("level " .. id .. ": unknown wave set '" .. tostring(wid) .. "'")
		end
		l.waves = wid
		C.levels[id] = l
	end
	if raw.campaign then
		local camp = U.deepCopy(raw.campaign)
		camp.levels = camp.levels or {}
		camp.start_towers = camp.start_towers or U.keys(C.towers)
		camp.locked_branches = camp.locked_branches or {}
		camp.stars = camp.stars or { two = 0.5, three = 0.9 }
		for i, cl in camp.levels do
			if not C.levels[cl.level] then
				fail("campaign level " .. i .. ": unknown level '" .. tostring(cl.level) .. "'")
			end
			for _, t in (cl.unlock and cl.unlock.towers) or {} do
				if not C.towers[t] then
					fail("campaign level " .. i .. " unlocks unknown tower '" .. t .. "'")
				end
			end
		end
		C.campaign = camp
	end
	return C
end

-- ---------- towers ----------

-- Apply one upgrade step { set = {}, add = {}, mul = {} } (dotted keys allowed: "splash.radius") to stats.
function Content.applyUpgrade(stats, up)
	for k, v in up.set or {} do
		U.setPath(stats, k, U.deepCopy(v))
	end
	for k, v in up.add or {} do
		U.setPath(stats, k, (U.getPath(stats, k) or 0) + v)
	end
	for k, v in up.mul or {} do
		U.setPath(stats, k, (U.getPath(stats, k) or 0) * v)
	end
	return stats
end

local STAT_KEYS = {
	"range", "rate", "damage", "damage_type", "ground", "air", "splash", "slow", "chain", "dot", "aura", "income",
	"armor_pierce", "bonus",
}
Content.STAT_KEYS = STAT_KEYS

-- Effective stats of a tower definition at upgrade state { common = n, branch = "a"|nil, tier = n }.
function Content.towerStats(def, up)
	local s = {}
	for _, k in STAT_KEYS do
		s[k] = U.deepCopy(def[k])
	end
	up = up or {}
	for i = 1, math.min(up.common or 0, #def.upgrades) do
		Content.applyUpgrade(s, def.upgrades[i])
	end
	if up.branch then
		for _, b in def.branches do
			if b.id == up.branch then
				for i = 1, math.min(up.tier or 0, #b.tiers) do
					Content.applyUpgrade(s, b.tiers[i])
				end
			end
		end
	end
	return s
end

-- Next upgrade choices for a tower at state `up`: list of { kind = "common"|"branch", branch, tier, cost, name, desc }.
-- Common tiers come first (all must be bought); then the player picks ONE branch and climbs it.
function Content.upgradeChoices(def, up)
	up = up or {}
	local out = {}
	if (up.common or 0) < #def.upgrades then
		local u = def.upgrades[(up.common or 0) + 1]
		table.insert(out, { kind = "common", tier = (up.common or 0) + 1, cost = u.cost, name = u.name, desc = u.desc })
		return out
	end
	for _, b in def.branches do
		if up.branch == nil or up.branch == b.id then
			local t = if up.branch == b.id then (up.tier or 0) + 1 else 1
			local u = b.tiers[t]
			if u then
				table.insert(out, {
					kind = "branch", branch = b.id, branchName = b.name, tier = t, cost = u.cost, name = u.name, desc = u.desc,
				})
			end
		end
	end
	return out
end

-- Damage per second estimate (single target, no armor), used by balance + UI.
function Content.dps(stats)
	local d = (stats.damage or 0) * (stats.rate or 0)
	if stats.splash then
		d *= 1 + 0.6 * (stats.splash.radius or 0)
	end
	if stats.chain then
		d *= 1 + 0.5 * (stats.chain.count or 0)
	end
	if stats.dot then
		d += (stats.dot.dps or 0) * math.min(1, (stats.dot.duration or 0) * (stats.rate or 0))
	end
	return d
end

-- ---------- levels ----------

-- Layout of a level: { cols, rows, build = {{c,r}}, paths = {id → Path}, pathIds, tile_size }.
function Content.layout(C, levelId)
	local l = C.levels[levelId]
	if not l then
		fail("unknown level '" .. tostring(levelId) .. "'")
	end
	if l._layout then
		return l._layout
	end
	local lay
	if l.map and l.map.grid then
		lay = Path.fromGrid(l.map.grid, l.map.legend)
	else
		lay = { cols = l.cols or 0, rows = l.rows or 0, build = U.deepCopy(l.build_spots or {}), paths = {}, pathIds = {} }
	end
	for _, p in l.paths or {} do
		lay.paths[p.id] = Path.new(p.id, p.points)
		table.insert(lay.pathIds, p.id)
	end
	if #lay.pathIds == 0 then
		fail("level " .. levelId .. " has no paths (map.grid with spawn/exit tiles, or paths = [{id, points}])")
	end
	lay.tile_size = (l.map and l.map.tile_size) or l.tile_size or 64
	l._layout = lay
	return lay
end

-- ---------- waves ----------

-- Spawn schedule for wave `n` (1-based) of wave set `ws`: sorted list of { t, enemy, path, hpMult }.
-- Scripted waves first; past them (or for sets with only `endless`), endless waves are generated.
function Content.waveSchedule(C, ws, n, pathIds, endless)
	local sc = ws.scaling or {}
	local hpMult = 1 + (sc.hp or 0) * (n - 1)
	local groups
	local wave = ws.waves[n]
	if wave then
		groups = wave.groups
	elseif endless and ws.endless then
		groups = Content.endlessGroups(ws, n - #ws.waves, n)
		hpMult *= (ws.endless.hp_growth or 1.1) ^ (n - #ws.waves - 1)
	else
		return nil
	end
	local out = {}
	local rr = 0
	for _, g in groups do
		local count = g.count or 1
		for i = 0, count - 1 do
			local path = g.path
			if path == nil or path == "*" or path == "all" then
				rr += 1
				path = pathIds[(rr - 1) % #pathIds + 1]
			end
			table.insert(out, {
				t = (g.delay or 0) + i * (g.interval or 1),
				enemy = g.enemy,
				path = path,
				hpMult = hpMult * (g.hp_mult or 1),
				order = #out,
			})
		end
	end
	table.sort(out, function(a, b)
		if a.t == b.t then
			return a.order < b.order
		end
		return a.t < b.t
	end)
	return out, (wave and wave.bonus) or (ws.endless and ws.endless.bonus) or 0
end

-- Endless wave k (1-based past the scripted waves): rotating pool, growing counts, a boss every `boss_every`.
function Content.endlessGroups(ws, k, n)
	local e = ws.endless
	local pool = e.pool
	local count = math.floor((e.count_base or 8) + (e.count_growth or 1.5) * (k - 1))
	local a = pool[(k - 1) % #pool + 1]
	local b = pool[(k + #pool // 2 - 1) % #pool + 1]
	local groups = {
		{ enemy = a, count = math.ceil(count * 0.6), interval = e.interval or 0.7 },
		{ enemy = b, count = math.floor(count * 0.4), interval = e.interval or 0.7, delay = 2 },
	}
	if e.boss and k % (e.boss_every or 10) == 0 then
		table.insert(groups, { enemy = e.boss, count = 1, delay = 4 })
	end
	return groups
end

function Content.waveCount(C, levelId)
	return #C.waves[C.levels[levelId].waves].waves
end

return Content
