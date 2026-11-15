--!nonstrict
-- Short number + duration formatting for simulator UIs: 999, 1.2K, 34.5M, 1.00B, 2.5T, 1.0aa …
local M = {}
local SUFFIX = { "", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc" }

function M.num(n: number): string
	if n ~= n then return "0" end
	local neg = n < 0
	n = math.abs(n)
	local s
	if n < 1000 then
		s = tostring(math.floor(n))
	else
		local e = math.floor(math.log10(n) / 3)
		local v = n / 10 ^ (e * 3)
		if v >= 999.95 then e += 1 v /= 1000 end
		local suf = SUFFIX[e + 1] or ("e" .. (e * 3))
		s = (if v >= 100 then string.format("%.0f", v) elseif v >= 10 then string.format("%.1f", v) else string.format("%.2f", v)) .. suf
	end
	return if neg then "-" .. s else s
end

function M.time(sec: number): string
	sec = math.max(0, math.floor(sec + 0.5))
	if sec >= 3600 then return string.format("%dh %02dm", sec // 3600, (sec % 3600) // 60) end
	if sec >= 60 then return string.format("%dm %02ds", sec // 60, sec % 60) end
	return sec .. "s"
end

function M.pct(x: number): string
	local p = x * 100
	if math.abs(p - math.floor(p + 0.5)) < 0.05 then return string.format("+%d%%", math.floor(p + 0.5)) end
	return string.format("+%.1f%%", p)
end

return M
