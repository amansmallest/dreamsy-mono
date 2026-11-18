--!nonstrict
-- Daily / streak rewards. Day = floor(now / dayLength). Time source (first available):
-- opts.now() → prog.setClock(fn) → engine wall clock `clock.now()` (unix s; fixed + game time in playtests;
-- tests inject one via Game.load(pkg, { clock })).
-- daily.new({ rewards = { reward1, reward2, ... } (any values; core effects lists are applied when core is bound),
--             cycle? (true: wrap after the last), grace? (0 extra missed days before the streak resets), dayLength? (86400) })
local P = require("./shared")
local M = {}
local D = {}
D.__index = D

local function wallClock()
	if P.clock then return P.clock() end
	return clock.now()
end

function M.new(opts)
	opts = opts or {}
	return setmetatable({
		rewards = opts.rewards or {}, cycle = opts.cycle ~= false, grace = opts.grace or 0, dayLength = opts.dayLength or 86400,
		nowFn = opts.now, lastDay = nil, streak = 0, claims = 0, name = opts.name or "daily",
	}, D)
end
function D:now(): number
	if self.nowFn then return self.nowFn() end
	return wallClock()
end
function D:day(now: number?) return math.floor((now or self:now()) / self.dayLength) end

-- status(now?) -> { canClaim, streak (if claimed now), index (1-based reward index), reward, nextIn (seconds until next claim) }
function D:status(now: number?)
	now = now or self:now()
	local day = self:day(now)
	local can = self.lastDay == nil or day > self.lastDay
	local streak = self.streak
	if can then
		if self.lastDay ~= nil and day - self.lastDay <= 1 + self.grace then streak += 1 else streak = 1 end
	end
	local n = #self.rewards
	local idx = if n == 0 then 0 elseif self.cycle then ((streak - 1) % n) + 1 else math.min(streak, n)
	local nextIn = if can then 0 else (self.lastDay + 1) * self.dayLength - now
	return { canClaim = can, streak = streak, index = idx, reward = self.rewards[idx], nextIn = nextIn }
end
-- claim(now?) -> reward, index (nil when already claimed today)
function D:claim(now: number?)
	local s = self:status(now)
	if not s.canClaim then return nil end
	self.lastDay = self:day(now)
	self.streak = s.streak
	self.claims += 1
	if P.core and type(s.reward) == "table" then
		local ok = pcall(function() P.core.apply(s.reward, { daily = self.name, streak = s.streak }) end)
		if not ok then print("[progression] daily reward is not a core effects list; apply it yourself") end
	end
	if P.core then P.core.events.emit("daily_claimed", { daily = self.name, streak = s.streak, index = s.index }) end
	return s.reward, s.index
end
function D:serialize() return { l = self.lastDay, s = self.streak, c = self.claims } end
function D:deserialize(t)
	t = t or {}
	self.lastDay, self.streak, self.claims = t.l, t.s or 0, t.c or 0
end
function D:reset() self:deserialize(nil) end
return M
