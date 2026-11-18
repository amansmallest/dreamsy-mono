-- Steering on plain numbers (px/s). All return vx, vy.
local S = {}

local function len(x, y) return math.sqrt(x * x + y * y) end
S.len = len
function S.norm(x: number, y: number): (number, number)
	local l = len(x, y)
	if l < 1e-6 then return 0, 0 end
	return x / l, y / l
end

function S.seek(px: number, py: number, tx: number, ty: number, speed: number): (number, number)
	local nx, ny = S.norm(tx - px, ty - py)
	return nx * speed, ny * speed
end

function S.flee(px: number, py: number, tx: number, ty: number, speed: number): (number, number)
	local nx, ny = S.norm(px - tx, py - ty)
	if nx == 0 and ny == 0 then nx = 1 end
	return nx * speed, ny * speed
end

-- slows down inside `slow` radius, stops within `stop`
function S.arrive(px: number, py: number, tx: number, ty: number, speed: number, slow: number?, stop: number?): (number, number)
	local dx, dy = tx - px, ty - py
	local d = len(dx, dy)
	if d <= (stop or 2) then return 0, 0 end
	local s = speed
	if slow and d < slow then s = speed * d / slow end
	return dx / d * s, dy / d * s
end

-- pursue a moving target (lead by its velocity)
function S.pursue(px: number, py: number, tx: number, ty: number, tvx: number, tvy: number, speed: number): (number, number)
	local d = len(tx - px, ty - py)
	local t = math.min(1, d / math.max(speed, 1))
	return S.seek(px, py, tx + tvx * t, ty + tvy * t, speed)
end

-- push away from neighbours closer than `radius`; neighbours = { {x,y} }
function S.separation(px: number, py: number, neighbours: { any }, radius: number, strength: number?): (number, number)
	local fx, fy = 0, 0
	for _, n in neighbours do
		local dx, dy = px - n.x, py - n.y
		local d = len(dx, dy)
		if d > 0.01 and d < radius then
			local w = (radius - d) / radius
			fx += dx / d * w
			fy += dy / d * w
		end
	end
	return fx * (strength or 60), fy * (strength or 60)
end

-- wall avoidance on a PathGrid: if the look-ahead point is solid, slide along the free axis
function S.avoid(grid: any, px: number, py: number, vx: number, vy: number, look: number?): (number, number)
	if grid == nil then return vx, vy end
	local l = look or grid.tileSize * 0.6
	local nx, ny = S.norm(vx, vy)
	if not grid:solidAt(px + nx * l, py + ny * l) then return vx, vy end
	local sx = if vx ~= 0 and not grid:solidAt(px + (if vx > 0 then l else -l), py) then vx else 0
	local sy = if vy ~= 0 and not grid:solidAt(px, py + (if vy > 0 then l else -l)) then vy else 0
	local s = len(vx, vy)
	local ax, ay = S.norm(sx, sy)
	return ax * s, ay * s
end

return S
