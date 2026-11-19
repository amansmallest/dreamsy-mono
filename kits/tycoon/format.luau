--!strict
-- tycoon kit: number formatting for idle games.
--   1234 → "1.23K", 5.6e6 → "5.60M", 1e15 → "1.00aa", 1e18 → "1.00ab", … (letters after T: aa..zz)
-- Doubles top out at ~1.8e308 (= "≈ 1.80dk"); keep content below 1e300 (see KIT.md).
local F = {}

local SHORT = { "", "K", "M", "B", "T" }
local A = string.byte("a")

-- suffix for 1000^tier (tier 0 = no suffix)
function F.suffix(tier: number): string
	if tier < #SHORT then
		return SHORT[tier + 1]
	end
	local i = tier - #SHORT -- 0 → "aa"
	local first = i // 26
	local second = i % 26
	if first >= 26 then
		return "e" .. tostring(tier * 3)
	end
	return string.char(A + first, A + second)
end

local function trimZeros(s: string): string
	if string.find(s, "%.") then
		s = string.gsub(s, "0+$", "")
		s = string.gsub(s, "%.$", "")
	end
	return s
end

export type FormatOpts = { digits: number?, notation: string?, trim: boolean? }

-- F.format(n, { digits = 3 (significant digits), notation = "letters" | "scientific", trim = false })
function F.format(n: number, opts: FormatOpts?): string
	local o = opts or {}
	local digits = o.digits or 3
	if n ~= n then
		return "0"
	end
	if n == math.huge then
		return "∞"
	end
	local sign = ""
	if n < 0 then
		sign = "-"
		n = -n
	end
	if n < 1000 then
		local s
		if n >= 100 or n == math.floor(n) then
			s = tostring(math.floor(n))
		elseif n >= 10 then
			s = string.format("%.1f", math.floor(n * 10) / 10)
		else
			s = string.format("%.2f", math.floor(n * 100) / 100)
		end
		return sign .. trimZeros(s)
	end
	if o.notation == "scientific" then
		local e = math.floor(math.log10(n))
		local m = n / 10 ^ e
		return sign .. string.format("%." .. (digits - 1) .. "f", math.floor(m * 10 ^ (digits - 1)) / 10 ^ (digits - 1)) .. "e" .. e
	end
	local tier = math.floor(math.log10(n) / 3 + 1e-9)
	local m = n / 1000 ^ tier
	if m >= 1000 then -- float edge
		tier += 1
		m /= 1000
	end
	local whole = #tostring(math.floor(m))
	local dec = math.max(0, digits - whole)
	local scale = 10 ^ dec
	local s = string.format("%." .. dec .. "f", math.floor(m * scale + 1e-9) / scale)
	if o.trim then
		s = trimZeros(s)
	end
	return sign .. s .. F.suffix(tier)
end

-- "1h 02m", "3m 05s", "42s"
function F.duration(seconds: number): string
	local s = math.max(0, math.floor(seconds))
	local d, h, m = s // 86400, (s % 86400) // 3600, (s % 3600) // 60
	s = s % 60
	if d > 0 then
		return string.format("%dd %02dh", d, h)
	elseif h > 0 then
		return string.format("%dh %02dm", h, m)
	elseif m > 0 then
		return string.format("%dm %02ds", m, s)
	end
	return string.format("%ds", s)
end

return F
