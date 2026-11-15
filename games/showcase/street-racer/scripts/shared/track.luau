-- Track geometry: a loop of straight cells and 90 degree corners built by a turtle.
local Track = {}

local CELL = 256
local R = CELL * 1.5
Track.CELL = CELL
Track.HALF = 128

local PROGRAM = {
	{ "S", 8 }, { "R" }, { "S", 5 }, { "R" }, { "S", 2 }, { "L" },
	{ "S", 4 }, { "R" }, { "S", 3 }, { "R" }, { "S", 12 }, { "R" },
}

local pieces = {}
local px = {}
local py = {}
local cornerIdx = {}

local x, y = 0, 0
local hx, hy = 0, -1
table.insert(px, x)
table.insert(py, y)
for _, cmd in PROGRAM do
	if cmd[1] == "S" then
		for _ = 1, cmd[2] do
			table.insert(pieces, { kind = "straight", x = x + hx * CELL * 0.5, y = y + hy * CELL * 0.5, rot = if hx ~= 0 then 90 else 0 })
			x += hx * CELL
			y += hy * CELL
			table.insert(px, x)
			table.insert(py, y)
		end
	else
		local right = cmd[1] == "R"
		local nx, ny
		if right then nx, ny = -hy, hx else nx, ny = hy, -hx end
		local cx, cy = x + nx * R, y + ny * R
		local sx, sy = cx - nx * CELL + hx * CELL, cy - ny * CELL + hy * CELL
		local rot = math.deg(math.atan2(cy - sy, cx - sx)) - 45
		rot = math.floor(rot / 90 + 0.5) * 90
		table.insert(pieces, { kind = "corner", x = sx, y = sy, rot = rot })
		table.insert(cornerIdx, #px)
		local a0 = math.atan2(y - cy, x - cx)
		local sign = if right then 1 else -1
		for k = 1, 12 do
			local a = a0 + sign * (math.pi / 2) * (k / 12)
			table.insert(px, cx + math.cos(a) * R)
			table.insert(py, cy + math.sin(a) * R)
		end
		x, y = cx + hx * R, cy + hy * R
		px[#px] = x
		py[#py] = y
		hx, hy = nx, ny
	end
end
-- last point duplicates the first
table.remove(px)
table.remove(py)

local N = #px
local segLen, cum, tx, ty = {}, {}, {}, {}
local total = 0
for i = 1, N do
	local j = i % N + 1
	local dx, dy = px[j] - px[i], py[j] - py[i]
	local len = math.sqrt(dx * dx + dy * dy)
	segLen[i] = len
	cum[i] = total
	tx[i] = dx / len
	ty[i] = dy / len
	total += len
end

Track.pieces = pieces
Track.N = N
Track.length = total
Track.startS = 3 * CELL
Track.cornerStarts = {}
for _, i in cornerIdx do
	table.insert(Track.cornerStarts, cum[i])
end

local function segDist2(i, x0, y0)
	local ax, ay = px[i], py[i]
	local t = (x0 - ax) * tx[i] + (y0 - ay) * ty[i]
	if t < 0 then t = 0 elseif t > segLen[i] then t = segLen[i] end
	local ex, ey = x0 - (ax + tx[i] * t), y0 - (ay + ty[i] * t)
	return ex * ex + ey * ey, t
end

-- returns idx, s, lateral (+ = right side), right normal nx, ny, tangent tx, ty
function Track.closest(x0, y0, hint)
	local best, bi, bt = math.huge, 1, 0
	if hint and hint > 0 then
		for k = -5, 5 do
			local i = (hint - 1 + k) % N + 1
			local d2, t = segDist2(i, x0, y0)
			if d2 < best then best, bi, bt = d2, i, t end
		end
	end
	if best > 300 * 300 then
		for i = 1, N do
			local d2, t = segDist2(i, x0, y0)
			if d2 < best then best, bi, bt = d2, i, t end
		end
	end
	local nx, ny = -ty[bi], tx[bi]
	local lat = (x0 - px[bi]) * nx + (y0 - py[bi]) * ny
	return bi, cum[bi] + bt, lat, nx, ny, tx[bi], ty[bi]
end

function Track.distance(x0, y0)
	local best = math.huge
	for i = 1, N do
		local d2 = segDist2(i, x0, y0)
		if d2 < best then best = d2 end
	end
	return math.sqrt(best)
end

-- position and tangent at distance s along the loop
function Track.pointAt(s)
	s = s % total
	local lo, hi = 1, N
	while lo < hi do
		local mid = math.floor((lo + hi + 1) / 2)
		if cum[mid] <= s then lo = mid else hi = mid - 1 end
	end
	local t = s - cum[lo]
	return px[lo] + tx[lo] * t, py[lo] + ty[lo] * t, tx[lo], ty[lo]
end

function Track.bounds()
	local a, b, c, d = math.huge, math.huge, -math.huge, -math.huge
	for i = 1, N do
		a = math.min(a, px[i]); b = math.min(b, py[i])
		c = math.max(c, px[i]); d = math.max(d, py[i])
	end
	return a, b, c, d
end

return Track
