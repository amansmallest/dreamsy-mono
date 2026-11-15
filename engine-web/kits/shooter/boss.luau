--!nonstrict
-- Bosses (pure): an ai-kit boss brain (hp phases + looping pattern steps) driving emitters. No entities.
--[[ boss def (data/enemies/<id>.json with "boss": true):
   { name, sprite, size, hp, score, radius, enter = { y = 240, speed = 160 },
     bounds = { 90, 140, 630, 520 } (x0, y0, x1, y1 the boss stays inside),
     phases = { { hp = 1.0, name?, pattern = {
         { action = "fire", emitter = "boss_ring" | emitters = {...}, ["for"] = 2.0 (s the emitters run), wait = 2.4 },
         { behavior = "patrol", points = {{-160,0},{160,0}}, relative = true, speed = 120, time = 3 },  -- any ai behaviour
         { action = "summon", enemy = "drone", count = 2, wait = 1 },
         { wait = 0.8 } } }, { hp = 0.5, … } } }
   Phase = lowest hp threshold ≥ current fraction (ai kit). Changing phase stops running emitters. ]]
local Emitter = require("./emitter")
local M = {}

-- new(def, emitterDefs, ai, opts?) -> boss { agent{x,y,hp,maxHp}, phase, entering, active = { {em, until} } }
function M.new(def, emitterDefs, ai, opts)
	opts = opts or {}
	assert(ai, "shooter: bosses need the ai kit")
	local hp = def.hp or 100
	local b = {
		def = def, phase = 0, t = 0, active = {}, entering = true,
		agent = { x = opts.x or 360, y = opts.y or -120, vx = 0, vy = 0, hp = hp, maxHp = hp, radius = def.radius or 60 },
	}
	b.brain = ai.brain({ behavior = "boss", phases = def.phases or { { hp = 1, pattern = { { wait = 1 } } } } })
	local enter = if def.enter == nil then {} else def.enter
	local bounds = def.bounds or opts.bounds or { 90, 140, 630, 520 }
	if enter == false or opts.enter == false then b.entering = false enter = {} end

	local function emitterDef(e)
		if type(e) == "table" then return e end
		local d = emitterDefs[e]
		if d == nil then error(`shooter: boss "{def.id or "?"}" uses unknown emitter "{e}"`) end
		return d
	end

	-- update(dt, target {x, y}?, hp?) -> { shots = {...}, summons = { {id, x, y} }, phase = index? (changed) }
	function b.update(self, dt, target, hpNow)
		self.t += dt
		local out = { shots = {}, summons = {} }
		local a = self.agent
		if hpNow then a.hp = hpNow end
		if self.entering then
			local y = enter.y or 240
			a.y = math.min(y, a.y + (enter.speed or 160) * dt)
			if a.y >= y then self.entering = false end
			return out
		end
		local acts = ai.step(self.brain, a, { target = target, sight = false, mode = "flyer" }, dt)
		a.x = math.clamp(a.x, bounds[1], bounds[3])
		a.y = math.clamp(a.y, bounds[2], bounds[4])
		for _, act in acts do
			local d = act.data or {}
			if act.name == "phase" then
				self.phase = d.index
				self.active = {}
				out.phase = d.index
			elseif act.name == "fire" then
				local list = d.emitters or { d.emitter }
				for _, e in list do
					local ed = table.clone(emitterDef(e))
					local em = Emitter.new(ed)
					table.insert(self.active, { em = em, left = d["for"] or d.wait or 2 })
				end
			elseif act.name == "summon" then
				for k = 1, d.count or 1 do
					table.insert(out.summons, { id = d.enemy, x = a.x + ((k - 1) - ((d.count or 1) - 1) / 2) * 120, y = a.y + 40 })
				end
			end
		end
		for i = #self.active, 1, -1 do
			local r = self.active[i]
			local tx, ty = a.x, a.y + 100
			if target then tx, ty = target.x, target.y end
			for _, s in r.em:update(dt, { x = a.x, y = a.y, tx = tx, ty = ty }) do table.insert(out.shots, s) end
			r.left -= dt
			if r.left <= 0 or r.em.done then table.remove(self.active, i) end
		end
		return out
	end
	function b.fraction(self) return self.agent.hp / self.agent.maxHp end
	return b
end

return M
