--!nonstrict
-- Track: segment validation + seeded sequencing by difficulty tier and biome.
-- Segment (data/segments/<id>.json): { tier = 0..5, weight? (1), biomes? = {"city"} (any if absent), tags?,
--   rows = { "B.C", "..J", ... } } — one char per lane, first row is nearest. Chars:
--   "." empty · "B" block (switch lanes) · "J" low bar (jump) · "S" high bar (slide) · "C" coin ·
--   "M" magnet · "H" shield · "X" 2x coins · "G" gem (10 coins). Unknown chars are errors.
local S = require("./state")
local M = {}

M.KIND = { B = "block", J = "low", S = "high", C = "coin", M = "magnet", H = "shield", X = "double", G = "gem" }
M.OBSTACLE = { block = true, low = true, high = true }

-- validate(seg, lanes?) -> ok, problems
-- every row has a passable lane, and from EVERY start lane a path exists changing ≤ 1 lane per row
-- (gapRows changes allowed before the first row).
function M.validate(seg, lanes)
	lanes = lanes or S.config.lanes
	local probs = {}
	for i, row in seg.rows or {} do
		if #row ~= lanes then table.insert(probs, "row " .. i .. " has " .. #row .. " chars (lanes = " .. lanes .. ")") end
		for c in string.gmatch(row, ".") do
			if c ~= "." and M.KIND[c] == nil then table.insert(probs, "row " .. i .. ": unknown char '" .. c .. "'") end
		end
	end
	if #probs > 0 then return false, probs end
	local function safe(row, l) return string.sub(row, l, l) ~= "B" end
	for start = 1, lanes do
		local reach = {}
		for l = 1, lanes do reach[l] = math.abs(l - start) <= S.config.gapRows end
		for i, row in seg.rows do
			local nr, any = {}, false
			for l = 1, lanes do
				local ok = safe(row, l) and (reach[l] or (l > 1 and reach[l - 1]) or (l < lanes and reach[l + 1]))
				nr[l] = ok == true
				if ok then any = true end
			end
			if not any then table.insert(probs, "unpassable at row " .. i .. " from lane " .. start) break end
			reach = nr
		end
	end
	return #probs == 0, probs
end

-- biomeAt(dist) -> biome def (config.biomes cycled by length)
function M.biomeAt(dist)
	local list = S.config.biomes
	local total = 0
	for _, b in list do total += b.length or 600 end
	local d = dist % math.max(1, total)
	for _, b in list do
		d -= b.length or 600
		if d < 0 then return b end
	end
	return list[1]
end

function M.difficulty()
	return S.prog.difficulty.new({ tiers = S.config.speed })
end

-- sequencer({ seed, segments? (default content "segments"), tier? (fixed tier: balance/tests) }) -> seq
-- seq:next(dist) -> segment def (eligible: tier-spread..tier, matching biome; never the last 2 again if avoidable)
function M.sequencer(opts)
	opts = opts or {}
	local segs = opts.segments or S.all("segments")
	local sorted = table.clone(segs)
	table.sort(sorted, function(a, b) return a.id < b.id end)
	local rng = S.procgen.rng(opts.seed or 1):fork("track")
	local diff = M.difficulty()
	local seq = { rng = rng, recent = {}, tierFixed = opts.tier, log = {} }
	function seq:tierAt(dist)
		if self.tierFixed then return self.tierFixed end
		return math.floor(diff:at(dist).tier + 1e-6)
	end
	function seq:next(dist)
		local tier = self:tierAt(dist)
		local biome = M.biomeAt(dist)
		local last = self.recent[#self.recent]
		local function eligible(strictRecent, spread)
			local out = {}
			for _, s in sorted do
				if strictRecent == "last" and s.id == last then continue end
				local t = s.tier or 0
				local okB = s.biomes == nil or table.find(s.biomes, biome.id) ~= nil
				if okB and t <= tier and t >= tier - spread and not (strictRecent == true and table.find(self.recent, s.id)) and not (s.tags and table.find(s.tags, "start") and dist > 0) then
					table.insert(out, s)
				end
			end
			return out
		end
		local pool = eligible(true, S.config.tierSpread)
		if #pool == 0 then pool = eligible("last", S.config.tierSpread) end
		if #pool == 0 then pool = eligible(false, S.config.tierSpread) end
		if #pool == 0 then pool = eligible(false, 99) end
		assert(#pool > 0, "runner: no segments for tier " .. tier .. " biome " .. biome.id)
		local s = self.rng:weighted(pool, function(x) return (x.weight or 1) * (if (x.tier or 0) == tier then 3 else 1) end)
		table.insert(self.recent, s.id)
		if #self.recent > 2 then table.remove(self.recent, 1) end
		table.insert(self.log, { id = s.id, tier = s.tier or 0, at = dist, biome = biome.id })
		return s, tier, biome
	end
	return seq
end

return M
