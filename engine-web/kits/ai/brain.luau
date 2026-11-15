-- Brains: one behaviour, an FSM of behaviours, a utility selector, or a boss with hp phases + pattern sequences.
local B = require("./behaviors")

local Brain = {}

local function params(spec)
	local out = {}
	for k, v in spec do if k ~= "params" then out[k] = v end end
	for k, v in spec.params or {} do out[k] = v end
	return out
end

local function dist(ax, ay, bx, by) return math.sqrt((ax - bx) ^ 2 + (ay - by) ^ 2) end

-- condition: "see" | "lost" | "near:<px>" | "far:<px>" | "hp<0.5" | "hp>0.5" | "after:<s>" | "always" | fn(ctx, brain) -> bool
local function cond(c, ctx, br, st): boolean
	if type(c) == "function" then return c(ctx, br) end
	if c == "always" then return true end
	local t = ctx.target
	if c == "see" then return B.sees(ctx, st.aggro or br.aggro or 140) end
	if c == "lost" then
		if t and B.sees(ctx, (st.aggro or br.aggro or 140) * 1.5) then br.unseen = 0 return false end
		return (br.unseen or 0) > (st.forget or 2)
	end
	local kind, num = string.match(c, "^(%a+)[:<>]?(.*)$")
	local n = tonumber(num) or tonumber(string.match(c, "[%d%.]+$") or "")
	if kind == "near" then return t ~= nil and dist(ctx.x, ctx.y, t.x, t.y) <= n end
	if kind == "far" then return t == nil or dist(ctx.x, ctx.y, t.x, t.y) > n end
	if kind == "hp" and ctx.maxHp then
		local f = (ctx.hp or ctx.maxHp) / ctx.maxHp
		if string.find(c, "<", 1, true) then return f < n else return f > n end
	end
	if kind == "after" then return (br.stateTime or 0) >= n end
	error(`ai: unknown condition "{c}"`)
end

-- spec -> brain with :update(ctx) -> vx, vy ; brain.state (fsm/boss), brain.name
function Brain.new(spec: any): any
	if type(spec) == "string" then spec = { behavior = spec } end
	local br = { spec = spec, aggro = spec.aggro }
	if spec.fsm or spec.states then
		local f = spec.fsm or spec
		local states = {}
		for name, st in f.states do states[name] = { b = Brain.new(st), spec = st } end
		br.state = f.start or f.initial
		assert(states[br.state], "ai fsm: start state missing")
		br.stateTime = 0
		function br.update(self, ctx)
			self.stateTime += ctx.dt
			if ctx.target and B.sees(ctx, self.aggro or 140) then self.unseen = 0 else self.unseen = (self.unseen or 0) + ctx.dt end
			for _, tr in f.transitions or {} do
				if (tr.from == self.state or tr.from == "*") and tr.to ~= self.state and cond(tr.when, ctx, self, states[self.state].spec) then
					ctx.emit("state", { from = self.state, to = tr.to })
					self.state = tr.to
					self.stateTime = 0
					break
				end
			end
			local s = states[self.state]
			return s.b:update(ctx)
		end
		return br
	end
	if spec.utility then
		local opts = {}
		for i, o in spec.utility do opts[i] = { b = Brain.new(o), spec = o } end
		local PRESETS = {
			hp_low = function(ctx) return if ctx.maxHp then 1 - (ctx.hp or ctx.maxHp) / ctx.maxHp else 0 end,
			target_near = function(ctx) local t = ctx.target if not t then return 0 end return math.max(0, 1 - dist(ctx.x, ctx.y, t.x, t.y) / 300) end,
			target_far = function(ctx) local t = ctx.target if not t then return 1 end return math.min(1, dist(ctx.x, ctx.y, t.x, t.y) / 300) end,
			sees = function(ctx) return if B.sees(ctx, spec.aggro or 160) then 1 else 0 end,
			always = function() return 0.1 end,
		}
		br.pick = 1
		function br.update(self, ctx)
			self.eval = (self.eval or 0) - ctx.dt
			if self.eval <= 0 then
				self.eval = spec.every or 0.25
				local best, bs = self.pick, -math.huge
				for i, o in opts do
					local sc = o.spec.score
					local v = if type(sc) == "function" then sc(ctx) elseif type(sc) == "number" then sc else (PRESETS[sc or "always"] or PRESETS.always)(ctx)
					v *= o.spec.weight or 1
					if i == self.pick then v += spec.stickiness or 0.05 end
					if v > bs then best, bs = i, v end
				end
				if best ~= self.pick then ctx.emit("state", { from = self.pick, to = best }) end
				self.pick = best
			end
			return opts[self.pick].b:update(ctx)
		end
		return br
	end
	if spec.behavior == "boss" or spec.phases then
		-- phases: { {hp = 1.0, pattern = { step... }, loop = true}, {hp = 0.5, ...} } ; active = lowest threshold >= hp fraction
		-- step: { behavior = "...", time = s, ...params } | { action = "name", wait = s, ...data } | { wait = s }
		local phases = table.clone(spec.phases)
		table.sort(phases, function(a, b) return (a.hp or 1) > (b.hp or 1) end)
		br.phase = 0
		function br.update(self, ctx)
			local frac = if ctx.maxHp then (ctx.hp or ctx.maxHp) / ctx.maxHp else 1
			local want = 1
			for i, ph in phases do if frac <= (ph.hp or 1) then want = i end end
			if want ~= self.phase then
				self.phase = want
				self.step = 0
				self.stepT = 0
				self.cur = nil
				ctx.emit("phase", { index = want, phase = phases[want] })
			end
			local ph = phases[self.phase]
			self.stepT -= ctx.dt
			if self.stepT <= 0 then
				self.step += 1
				if self.step > #ph.pattern then
					if ph.loop == false then self.step = #ph.pattern else self.step = 1 end
				end
				local st = ph.pattern[self.step]
				if st.behavior then
					self.cur = Brain.new(st)
					self.stepT = st.time or 2
				else
					self.cur = nil
					if st.action then
						local data = {}
						for k, v in st do data[k] = v end
						data.x, data.y, data.target = ctx.x, ctx.y, ctx.target
						ctx.emit(st.action, data)
					end
					self.stepT = st.wait or 0.5
				end
			end
			if self.cur then return self.cur:update(ctx) end
			return 0, if ctx.mode == "platformer" then nil else 0
		end
		return br
	end
	local name = spec.behavior or "idle"
	local factory = B[name]
	if factory == nil then error(`ai: unknown behavior "{name}" (idle, wander, patrol, chase, flee, keep_distance, charge, jump_at, swoop, turret, spawner, boss)`) end
	local inst = factory(params(spec))
	br.name = name
	function br.update(self, ctx) return inst.update(inst, ctx) end
	br.inst = inst
	return br
end

return Brain
