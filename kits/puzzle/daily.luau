--!nonstrict
-- Daily puzzle: one generated level per calendar day (UTC), seeded by clock.now() → same puzzle for everyone that day.
-- Difficulty can follow the weekday (Mon easy → Sun hard). Streak via the progression kit (saved, "puzzle_daily").
local procgen = require("@kit/procgen")
local prog = require("@kit/progression")
local Mech = require("./mechanics")
local Progress = require("./progress")
local M = {}
local streak = nil

function M.now(): number
	if type(clock) == "table" and type(clock.now) == "function" then return clock.now() end
	return if type(time) == "function" then time() else 0
end
function M.day(now: number?): number return math.floor((now or M.now()) / 86400) end
-- 0 = Monday … 6 = Sunday (unix day 0 was a Thursday)
function M.weekday(day: number?): number return ((day or M.day()) + 3) % 7 end
function M.seed(day: number?, salt: string?): number return procgen.RNG.hash and procgen.RNG.hash("daily:" .. (salt or "") .. ":" .. (day or M.day())) or ((day or M.day()) * 7919) end

-- level(mechanic, { params? (fixed), curve? (tiers over weekday 0..6), salt?, day? }) -> level (+ day, daily = true)
function M.level(mechanic: string, opts)
	opts = opts or {}
	local day = opts.day or M.day()
	local mech = Mech.get(mechanic)
	local params = table.clone(opts.params or {})
	if opts.curve then
		for k, v in prog.difficulty.new({ tiers = opts.curve }):at(M.weekday(day)) do params[k] = v end
	end
	params.seed = M.seed(day, opts.salt or mechanic)
	local lv = mech.generate(params)
	if lv then lv.mechanic, lv.day, lv.daily, lv.pack, lv.index = mechanic, day, true, "daily", day end
	return lv
end

local function getStreak()
	if not streak then
		streak = prog.streak({ name = "puzzle_daily", rewards = { true }, now = M.now })
	end
	return streak
end

function M.solved(day: number?): boolean return Progress.dailyStars(day or M.day()) > 0 end
-- record a daily win: stars saved, streak claimed once per day -> streak length
function M.complete(stars: number, day: number?): number
	day = day or M.day()
	Progress.recordDaily(day, stars)
	local s = getStreak()
	if s:status().canClaim then s:claim() end
	return s.streak
end
function M.streak(): number return getStreak().streak end
-- seconds until the next daily
function M.nextIn(now: number?): number now = now or M.now() return (M.day(now) + 1) * 86400 - now end

getStreak()
return M
