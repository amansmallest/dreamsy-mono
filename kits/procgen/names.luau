-- Name / text generators from word lists.
local RNG = require("./rng")
local N = {}

-- Markov name model (order 2) trained on example names. model:make(rng, {min=4, max=9}) -> "Kalvorin"
function N.markov(words: { string }, order: number?): any
	local k = order or 2
	local trans: { [string]: { string } } = {}
	local known = {}
	for _, w in words do
		w = string.lower(w)
		known[w] = true
		local s = string.rep("^", k) .. w .. "$"
		for i = 1, #s - k do
			local ctx = string.sub(s, i, i + k - 1)
			trans[ctx] = trans[ctx] or {}
			table.insert(trans[ctx], string.sub(s, i + k, i + k))
		end
	end
	local model = {}
	function model.make(rngOrSeed: any?, opts: any?): string
		opts = opts or {}
		local rng = RNG.from(rngOrSeed)
		local minL, maxL = opts.min or 4, opts.max or 9
		for _ = 1, 50 do
			local ctx = string.rep("^", k)
			local out = ""
			while #out <= maxL do
				local nx = trans[ctx]
				if not nx then break end
				local c = rng:pick(nx)
				if c == "$" then break end
				out ..= c
				ctx = string.sub(ctx .. c, -k)
			end
			if #out >= minL and #out <= maxL and (opts.allowKnown or not known[out]) then
				return string.upper(string.sub(out, 1, 1)) .. string.sub(out, 2)
			end
		end
		return string.upper(string.sub(words[1], 1, 1)) .. string.sub(words[1], 2)
	end
	return model
end

--[[ template text: "The {adj} {noun} of {place}" with lists = { adj = {...}, noun = {...} };
     "{a|b|c}" inline choices. Unknown keys stay as-is. ]]
function N.fill(template: string, lists: any, rngOrSeed: any?): string
	local rng = RNG.from(rngOrSeed)
	local out = string.gsub(template, "{([^}]+)}", function(key)
		if string.find(key, "|", 1, true) then return rng:pick(string.split(key, "|")) end
		local l = lists[key]
		if l == nil then return "{" .. key .. "}" end
		local v = rng:pick(l)
		if type(v) == "string" and string.find(v, "{", 1, true) then return N.fill(v, lists, rng) end
		return v
	end)
	return out
end

-- syllable names: N.syllables({"ka","ro","vin"}, rng, 2, 3)
function N.syllables(parts: { string }, rngOrSeed: any?, minN: number?, maxN: number?): string
	local rng = RNG.from(rngOrSeed)
	local s = ""
	for _ = 1, rng:int(minN or 2, maxN or 3) do s ..= rng:pick(parts) end
	return string.upper(string.sub(s, 1, 1)) .. string.sub(s, 2)
end

return N
