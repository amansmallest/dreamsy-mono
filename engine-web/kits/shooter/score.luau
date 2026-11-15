--!nonstrict
-- Score, combo chain, multiplier, graze, extends (pure).
--[[ new(opts) -> score
   opts: { comboWindow = 2.0 (s a chain survives without a kill), multEvery = 10 (chain kills per +1 multiplier),
           maxMult = 8, grazePoints = 10, extends = { 50000, 150000 } (score thresholds that give +1 life), onExtend?(n),
           hitResets = true (taking a hit drops the chain) }
   s:kill(points) -> gained (points × mult)     s:add(points) (no chain)     s:graze(n?) -> gained     s:hit()
   s:update(dt)     s.score s.combo s.mult s.bestCombo s.kills s.grazes s.timer (chain time left)     s:fraction() (chain timer 0..1)
   s:snapshot() / s:restore(t) ]]
local M = {}

function M.new(opts)
	opts = opts or {}
	local s = {
		score = 0, combo = 0, mult = 1, bestCombo = 0, kills = 0, grazes = 0, timer = 0, extendIndex = 1,
		window = opts.comboWindow or 2, multEvery = opts.multEvery or 10, maxMult = opts.maxMult or 8,
		grazePoints = opts.grazePoints or 10, extends = opts.extends or {}, onExtend = opts.onExtend,
		hitResets = opts.hitResets ~= false,
	}
	local function checkExtends(self)
		while self.extends[self.extendIndex] and self.score >= self.extends[self.extendIndex] do
			self.extendIndex += 1
			if self.onExtend then self.onExtend(self.extendIndex - 1) end
		end
	end
	function s.add(self, points)
		self.score += math.floor(points)
		checkExtends(self)
		return math.floor(points)
	end
	function s.kill(self, points)
		self.combo += 1
		self.kills += 1
		self.bestCombo = math.max(self.bestCombo, self.combo)
		self.mult = math.min(self.maxMult, 1 + self.combo // self.multEvery)
		self.timer = self.window
		return self:add((points or 0) * self.mult)
	end
	function s.graze(self, n)
		n = n or 1
		self.grazes += n
		if self.combo > 0 then self.timer = math.max(self.timer, self.window * 0.5) end
		return self:add(self.grazePoints * n * self.mult)
	end
	function s.breakChain(self)
		self.combo = 0
		self.mult = 1
		self.timer = 0
	end
	function s.hit(self) if self.hitResets then self:breakChain() end end
	function s.update(self, dt)
		if self.combo > 0 then
			self.timer -= dt
			if self.timer <= 0 then self:breakChain() end
		end
	end
	function s.fraction(self) return if self.window > 0 then math.clamp(self.timer / self.window, 0, 1) else 0 end
	function s.snapshot(self) return { score = self.score, kills = self.kills, bestCombo = self.bestCombo, grazes = self.grazes, extendIndex = self.extendIndex } end
	function s.restore(self, t)
		for k, v in t or {} do self[k] = v end
	end
	return s
end

return M
