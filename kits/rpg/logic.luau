-- rpg kit: conditions and effects — the small language shared by dialog trees, quests, map
-- objects (NPC/sign/item "if"), triggers and game scripts (rpg.check / rpg.apply).
--
-- Condition: an object (all keys must hold), a list (all), or nil (true). Keys:
--   flag, not_flag, flags = [..], item (+count), no_item, money, var (+eq|ne|gte|lte),
--   quest (+state: "not_started"|"active"|"done"|"started", +step), party_has, party_size,
--   level (highest party level ≥), caught (species caught ≥), seen, map, all = [..], any = [..], not = cond
--   unknown key -> rpg.hooks.condition[key](value, cond)
-- Effect: an object with one action key (+ its params). Effects run in order; some wait (battles,
--   shops, nested dialogs). Keys: set_flag, clear_flag, set_var (+value), add_var (+value), give_item (+count),
--   take_item (+count), give_money, take_money, give_creature (+level, nickname), heal, start_battle,
--   wild_battle {creature, level, can_run}, warp {map, spawn}, start_quest, advance_quest, complete_quest,
--   open_shop, open_storage, dialog, emit (+args), sfx, music, toast, wait, save
--   unknown key -> rpg.hooks.effect[key](value, effect, done)  (call done() when finished)
local U = require("./util")
local Content = require("./content")
local State = require("./state")
local Events = require("./events")
local R = require("./runtime")

local L = {}

-- set by quests.luau (avoids a require cycle)
L.questState = function(_id: string) return "not_started" end
L.questStep = function(_id: string) return nil end
L.quests = nil

local PARAMS = { count = true, state = true, step = true, eq = true, ne = true, gte = true, lte = true }

local check

local function checkKey(k: string, v, c): boolean
	local d = State.get()
	if k == "flag" then return d.flags[v] == true
	elseif k == "not_flag" then return d.flags[v] ~= true
	elseif k == "flags" then
		for _, f in v do if d.flags[f] ~= true then return false end end
		return true
	elseif k == "item" then return State.count(v) >= (c.count or 1)
	elseif k == "no_item" then return State.count(v) == 0
	elseif k == "money" then return d.money >= v
	elseif k == "var" then
		local x = d.vars[v]
		if c.eq ~= nil then return x == c.eq end
		if c.ne ~= nil then return x ~= c.ne end
		if c.gte ~= nil then return type(x) == "number" and x >= c.gte end
		if c.lte ~= nil then return type(x) == "number" and x <= c.lte end
		return x ~= nil and x ~= false
	elseif k == "quest" then
		local st = L.questState(v)
		local want = c.state or "active"
		if c.step ~= nil then return st == "active" and L.questStep(v) == c.step end
		if want == "started" then return st ~= "not_started" end
		return st == want
	elseif k == "party_has" then
		for _, m in d.party do if m.id == v then return true end end
		return false
	elseif k == "party_size" then return #d.party >= v
	elseif k == "level" then
		local best = 0
		for _, m in d.party do best = math.max(best, m.level) end
		return best >= v
	elseif k == "caught" then return U.count(d.caught) >= v
	elseif k == "seen" then return U.count(d.seen) >= v
	elseif k == "map" then return d.player.map == v
	elseif k == "all" then
		for _, x in v do if not check(x) then return false end end
		return true
	elseif k == "any" then
		for _, x in v do if check(x) then return true end end
		return false
	elseif k == "not" then return not check(v)
	end
	local hook = Events.hooks.condition[k]
	if hook then return hook(v, c) == true end
	print("[rpg] unknown condition \"" .. k .. "\" (define rpg.hooks.condition." .. k .. ")")
	return false
end

check = function(c): boolean
	if c == nil then return true end
	if type(c) == "boolean" then return c end
	if type(c) ~= "table" then return false end
	if #c > 0 then
		for _, x in c do if not check(x) then return false end end
		return true
	end
	for k, v in c do
		if not PARAMS[k] and not checkKey(k, v, c) then return false end
	end
	return true
end
L.check = check

-- ---------------------------------------------------------------- effects

local function plural(n: number, name: string): string
	if n == 1 then return name end
	return tostring(n) .. "× " .. name
end

-- run one effect; call done(ok) when finished (ok=false aborts the rest of the list)
local function runOne(e, done: (boolean) -> ())
	local d = State.get()
	if e.set_flag then State.setFlag(e.set_flag, true) return done(true) end
	if e.clear_flag then State.setFlag(e.clear_flag, false) return done(true) end
	if e.set_var then State.setVar(e.set_var, e.value) return done(true) end
	if e.add_var then State.setVar(e.add_var, (tonumber(d.vars[e.add_var]) or 0) + (e.value or 1)) return done(true) end
	if e.give_item then
		local n = e.count or 1
		State.give(e.give_item, n)
		if not e.silent then
			R.notify(U.format(Content.config.text and Content.config.text.got_item or "Got {item}!", { item = plural(n, Content.item(e.give_item).name) }))
			U.sfx(Content.config.sfx and Content.config.sfx.item)
		end
		return done(true)
	end
	if e.take_item then State.take(e.take_item, e.count or 1) return done(true) end
	if e.give_money then
		State.addMoney(e.give_money)
		if not e.silent then R.notify("Got $" .. tostring(e.give_money) .. "!") end
		return done(true)
	end
	if e.take_money then State.addMoney(-e.take_money) return done(true) end
	if e.give_creature then
		local mon, where = State.giveCreature(e.give_creature, e.level or 5, { nickname = e.nickname })
		if not e.silent then
			local msg = U.format("{mon} joined your team!", { mon = Content.creature(e.give_creature).name })
			if where == "box" then msg = U.format("{mon} was sent to storage.", { mon = Content.creature(e.give_creature).name }) end
			R.notify(msg)
			U.sfx(Content.config.sfx and Content.config.sfx.item)
		end
		return done(true)
	end
	if e.heal then
		State.healAll()
		if not e.silent then
			R.notify(Content.config.text and Content.config.text.healed_all or "Your team is fully healed!")
			U.sfx(Content.config.sfx and Content.config.sfx.heal)
		end
		if e.heal ~= "silent" and d.player.map then
			d.player.respawn = { map = d.player.map, x = d.player.x, y = d.player.y, facing = d.player.facing }
		end
		return done(true)
	end
	if e.start_battle then
		assert(R.startTrainerBattle, "rpg: battles are not available (call rpg.setup first)")
		R.startTrainerBattle(e.start_battle, function(result)
			done(result == "win")
		end)
		return
	end
	if e.wild_battle then
		assert(R.startWildBattle, "rpg: battles are not available (call rpg.setup first)")
		R.startWildBattle(e.wild_battle, function(result)
			done(result ~= "lose")
		end)
		return
	end
	if e.warp then
		assert(R.warp, "rpg: warps are not available (call rpg.setup first)")
		local w = e.warp
		if type(w) == "string" then w = { map = w } end
		R.warp(w.map, w.spawn or e.spawn)
		return done(false)
	end
	if e.start_quest then L.quests.start(e.start_quest) return done(true) end
	if e.advance_quest then L.quests.advance(e.advance_quest) return done(true) end
	if e.complete_quest then L.quests.complete(e.complete_quest) return done(true) end
	if e.open_shop then
		assert(R.openShop, "rpg: shops are not available")
		R.openShop(e.open_shop, function() done(true) end)
		return
	end
	if e.open_storage then
		assert(R.openStorage, "rpg: storage is not available")
		R.openStorage(function() done(true) end)
		return
	end
	if e.dialog then
		R.dialog(e.dialog, nil, function(ok) done(ok ~= false) end)
		return
	end
	if e.emit then Events.custom:fire(e.emit, e.args) return done(true) end
	if e.sfx then U.sfx(e.sfx) return done(true) end
	if e.music then U.music(e.music, { fade = 0.5 }) return done(true) end
	if e.toast then R.toast(U.format(e.toast, L.vars), e.seconds) return done(true) end
	if e.wait then U.after(e.wait, function() done(true) end) return end
	if e.save then
		if R.save then R.save() end
		return done(true)
	end
	for k, v in e do
		local hook = Events.hooks.effect[k]
		if hook then
			local called = false
			local r = hook(v, e, function(ok)
				if called then return end
				called = true
				done(ok ~= false)
			end)
			-- hooks that return without taking `done` finish immediately
			if r ~= "wait" and not called then
				called = true
				done(r ~= false)
			end
			return
		end
	end
	print("[rpg] unknown effect " .. table.concat(U.keys(e), ",") .. " (define rpg.hooks.effect.<name>)")
	done(true)
end

-- run a list of effects in order; done(completed: boolean) — false when one aborted (lost battle, warp)
function L.run(list, done: ((boolean) -> ())?)
	list = U.list(list)
	local i = 0
	local function nxt(ok: boolean)
		if not ok then
			if done then done(false) end
			return
		end
		i += 1
		local e = list[i]
		if not e then
			if done then done(true) end
			return
		end
		if e["if"] ~= nil and not check(e["if"]) then return nxt(true) end
		runOne(e, nxt)
	end
	nxt(true)
end

-- text variables: {player}, {money}, {var.<name>}, {flag.<name>}
function L.vars(k: string)
	local d = State.get()
	if k == "player" then return d.player.name end
	if k == "money" then return d.money end
	local v = string.match(k, "^var%.(.+)$")
	if v then return d.vars[v] end
	local c = Content.config.vars
	if c and c[k] ~= nil then return c[k] end
	return nil
end
function L.text(s: string): string
	return U.format(s, L.vars)
end

return L
