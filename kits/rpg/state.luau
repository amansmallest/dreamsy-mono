-- rpg kit: the game state (everything a save file holds) + flags, vars, money, bag, party, box.
local U = require("./util")
local Content = require("./content")
local Events = require("./events")
local Creatures = require("./creatures")

local S = {}
S.PARTY_MAX = 6
S.BOX_MAX = 300

-- the live state table; replaced wholesale by S.reset / S.restore
S.data = nil

function S.blank()
	return {
		version = 1,
		player = { name = "Player", map = nil, x = 0, y = 0, facing = "down", respawn = nil },
		money = 0,
		bag = {},
		party = {},
		box = {},
		flags = {},
		vars = {},
		quests = {},
		seen = {},
		caught = {},
		playtime = 0,
		nextUid = 1,
	}
end

-- New game from data/rpg.json: { start: { map, spawn }, money, items: {id: n}, party: [{creature, level}], player_name }
function S.reset()
	local cfg = Content.config
	S.data = S.blank()
	local d = S.data
	d.money = cfg.money or 0
	d.player.name = cfg.player_name or "Player"
	local st = cfg.start or {}
	d.player.map = st.map
	d.player.spawn = st.spawn or "default"
	for id, n in cfg.items or {} do d.bag[id] = n end
	for _, p in cfg.party or {} do S.giveCreature(p.creature, p.level or 5, { silent = true }) end
	for _, f in cfg.flags or {} do d.flags[f] = true end
	return d
end

function S.get()
	if not S.data then S.data = S.blank() end
	return S.data
end

function S.restore(d)
	local b = S.blank()
	for k, v in b do
		if d[k] == nil then d[k] = v end
	end
	S.data = d
	for _, m in d.party do Creatures.refresh(m) end
	for _, m in d.box do Creatures.refresh(m) end
	return d
end

-- ---------------------------------------------------------------- flags & vars
function S.flag(name: string): boolean
	return S.get().flags[name] == true
end
function S.setFlag(name: string, value: boolean?)
	local v = if value == nil then true else value
	local d = S.get()
	if (d.flags[name] == true) == v then return end
	d.flags[name] = if v then true else nil
	Events.flagSet:fire(name, v)
end
function S.var(name: string)
	return S.get().vars[name]
end
function S.setVar(name: string, value)
	S.get().vars[name] = value
	Events.varSet:fire(name, value)
end

-- ---------------------------------------------------------------- money
function S.money(): number
	return S.get().money
end
function S.addMoney(n: number)
	local d = S.get()
	local before = d.money
	d.money = math.max(0, math.min(9999999, before + math.floor(n)))
	if d.money ~= before then Events.moneyChanged:fire(d.money, d.money - before) end
end
function S.spend(n: number): boolean
	if S.money() < n then return false end
	S.addMoney(-n)
	return true
end

-- ---------------------------------------------------------------- bag
function S.count(itemId: string): number
	return S.get().bag[itemId] or 0
end
function S.give(itemId: string, n: number?)
	n = n or 1
	Content.item(itemId)
	local d = S.get()
	d.bag[itemId] = math.min(999, (d.bag[itemId] or 0) + n)
	Events.itemObtained:fire(itemId, n)
end
function S.take(itemId: string, n: number?): boolean
	n = n or 1
	local d = S.get()
	local have = d.bag[itemId] or 0
	if have < n then return false end
	d.bag[itemId] = if have - n > 0 then have - n else nil
	return true
end
-- bag entries sorted by kind then name: { {id, count, def} }
local KIND_ORDER = { heal = 1, revive = 2, cure = 3, capture = 4, battle = 5, held = 6, evolve = 7, misc = 8, key = 9 }
function S.bagList(filter: ((def: any) -> boolean)?)
	local out = {}
	for id, n in S.get().bag do
		local def = Content.items[id]
		if def and n > 0 and (not filter or filter(def)) then table.insert(out, { id = id, count = n, def = def }) end
	end
	table.sort(out, function(a, b)
		local ka, kb = KIND_ORDER[a.def.kind] or 8, KIND_ORDER[b.def.kind] or 8
		if ka ~= kb then return ka < kb end
		return a.def.name < b.def.name
	end)
	return out
end

-- ---------------------------------------------------------------- party & box
function S.party()
	return S.get().party
end
function S.box()
	return S.get().box
end
function S.newUid(): number
	local d = S.get()
	local u = d.nextUid
	d.nextUid += 1
	return u
end
-- add a creature instance; returns "party" | "box"
function S.addCreature(mon, opts)
	local d = S.get()
	mon.uid = mon.uid or S.newUid()
	d.seen[mon.id] = true
	d.caught[mon.id] = true
	local where = "party"
	if #d.party < S.PARTY_MAX then table.insert(d.party, mon)
	else
		where = "box"
		if #d.box >= S.BOX_MAX then return nil end
		table.insert(d.box, mon)
	end
	if not (opts and opts.silent) then Events.creatureObtained:fire(mon, where) end
	return where
end
function S.giveCreature(species: string, level: number, opts)
	local mon = Creatures.create(species, level, opts and opts.rng)
	mon.uid = S.newUid()
	if opts and opts.nickname then mon.name = opts.nickname end
	local where = S.addCreature(mon, opts)
	return mon, where
end
function S.markSeen(species: string)
	local d = S.get()
	if not d.seen[species] then
		d.seen[species] = true
		Events.creatureSeen:fire(species)
	end
end
function S.healAll()
	for _, m in S.party() do Creatures.heal(m) end
end
function S.firstAlive(): number?
	for i, m in S.party() do
		if m.hp > 0 then return i end
	end
	return nil
end
function S.swap(i: number, j: number)
	local p = S.party()
	if p[i] and p[j] then p[i], p[j] = p[j], p[i] end
end
-- party slot -> box (keeps at least one healthy creature in the party)
function S.deposit(i: number): boolean
	local p = S.party()
	if not p[i] or #p <= 1 then return false end
	local alive = 0
	for k, m in p do if k ~= i and m.hp > 0 then alive += 1 end end
	if alive == 0 then return false end
	if #S.box() >= S.BOX_MAX then return false end
	table.insert(S.box(), table.remove(p, i))
	return true
end
function S.withdraw(i: number): boolean
	local b = S.box()
	if not b[i] or #S.party() >= S.PARTY_MAX then return false end
	table.insert(S.party(), table.remove(b, i))
	return true
end

return S
