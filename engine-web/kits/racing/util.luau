--!nonstrict
-- small shared helpers (angles: 0 = up/north, clockwise positive; forward = (sin a, -cos a))
local U = {}
local PI, TAU = math.pi, 2 * math.pi
function U.wrap(a: number): number
	a = (a + PI) % TAU
	return a - PI
end
function U.fwd(a: number): (number, number) return math.sin(a), -math.cos(a) end
function U.right(a: number): (number, number) return math.cos(a), math.sin(a) end
function U.heading(dx: number, dy: number): number return math.atan2(dx, -dy) end
function U.len(x: number, y: number): number return math.sqrt(x * x + y * y) end
function U.lerp(a: number, b: number, t: number): number return a + (b - a) * t end
function U.lerpAngle(a: number, b: number, t: number): number return a + U.wrap(b - a) * t end
-- 1:02.34 / --:--.--
function U.time(t: number?): string
	if t == nil or t ~= t or t == math.huge then return "--:--.--" end
	local m = math.floor(t / 60)
	local s = t - m * 60
	return string.format("%d:%05.2f", m, s)
end
-- signed split vs a reference: "+0.42" / "-1.10"
function U.split(t: number, ref: number?): string
	if not ref then return "" end
	local d = t - ref
	return (if d >= 0 then "+" else "-") .. string.format("%.2f", math.abs(d))
end
function U.ordinal(n: number): string
	local suf = "th"
	if n % 100 < 11 or n % 100 > 13 then
		local r = n % 10
		suf = if r == 1 then "st" elseif r == 2 then "nd" elseif r == 3 then "rd" else "th"
	end
	return n .. suf
end
-- segment intersection: p→q crosses a→b ? returns t along p→q
function U.segX(px, py, qx, qy, ax, ay, bx, by): number?
	local rx, ry = qx - px, qy - py
	local sx, sy = bx - ax, by - ay
	local den = rx * sy - ry * sx
	if math.abs(den) < 1e-9 then return nil end
	local t = ((ax - px) * sy - (ay - py) * sx) / den
	local u = ((ax - px) * ry - (ay - py) * rx) / den
	if t >= 0 and t <= 1 and u >= 0 and u <= 1 then return t end
	return nil
end
function U.copy(t)
	local o = {}
	for k, v in t or {} do o[k] = if type(v) == "table" then U.copy(v) else v end
	return o
end
return U
