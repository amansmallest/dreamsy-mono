--!nonstrict
-- Views: draw an endless sim (portrait pseudo-3D lanes, sprite pooling) and an obby sim (world-space parts + camera).
-- Screen-space: no camera needed for endless (world px = UI px, origin top-left).
local S = require("./state")
local Obby = require("./obby")
local M = {}

local function alive(e) return e ~= nil and pcall(function() return e.visible end) end

------------------------------------------------------------------ endless
-- endless(sim, { root (Node2D parent), sprites = { block, low, high, coin, gem, magnet, shield, double, player } ("asset:x"),
--   sizes? = { block = {150,150}, ... }, horizon = 300, playerY = 980, laneWidth = 200, depth = 9 (perspective k),
--   decor? = { "asset:tree", ... } (side props), decorEvery = 7 (m), colors? }) -> view { update(), destroy(), player }
function M.endless(sim, opts)
	local root = opts.root
	local sp = opts.sprites or {}
	local sizes = opts.sizes or {}
	local horizon, py, lw, k = opts.horizon or 300, opts.playerY or 980, opts.laneWidth or 200, opts.depth or 9
	local mid = (sim.lanes + 1) / 2
	local pool = {}
	local decor = {}
	local nextDecor = 0
	local v = { sim = sim }
	local DEF = { block = { 160, 170 }, low = { 170, 70 }, high = { 170, 120 }, coin = { 56, 56 }, gem = { 64, 64 }, magnet = { 80, 80 }, shield = { 80, 80 }, double = { 80, 80 } }
	local function proj(lane, z)
		local s = k / (k + math.max(-k * 0.6, z))
		local y = horizon + (py - horizon) * s
		local x = 360 + (lane - mid) * lw * s
		return x, y, s
	end
	v.proj = proj
	v.player = spawn("Sprite2D", { texture = sp.player, size = vec2(130, 150), position = vec2(360, py - 60), z_index = 500 }, root)
	v.shadow = spawn("Sprite2D", { texture = sp.shadow or sp.player, size = vec2(110, 30), position = vec2(360, py + 10), modulate = color("#00000055"), z_index = 499 }, root)
	v.shieldFx = spawn("Sprite2D", { texture = sp.bubble or sp.shield, size = vec2(190, 190), position = vec2(360, py - 60), modulate = color("#7fd6ffaa"), visible = false, z_index = 501 }, root)
	function v.update()
		local seen = {}
		for _, o in sim.objects do
			local z = o.d - sim.dist
			if not o.taken and z < 70 and z > -3 then
				seen[o.id] = true
				local e = pool[o.id]
				if not e then
					local sz = sizes[o.kind] or DEF[o.kind] or { 80, 80 }
					e = spawn("Sprite2D", { texture = sp[o.kind] or sp.block, size = vec2(sz[1], sz[2]) }, root)
					pool[o.id] = e
				end
				local x, y, s = proj(o.lane, z)
				local sz = sizes[o.kind] or DEF[o.kind] or { 80, 80 }
				local bob = if o.kind == "coin" or o.kind == "gem" then math.sin(sim.time * 6 + o.id) * 8 * s else 0
				e.position = vec2(x, y - sz[2] * s * 0.5 + bob - (if o.kind == "high" then 70 * s else 0))
				e.scale = vec2(s, s)
				e.z_index = math.floor(400 - z * 4)
			end
		end
		for id, e in pool do
			if not seen[id] then
				if alive(e) then e:destroy() end
				pool[id] = nil
			end
		end
		-- side decor (trees/lamps) for speed feel
		if opts.decor and #opts.decor > 0 then
			local every = opts.decorEvery or 7
			while nextDecor < sim.dist + 70 do
				local i = math.floor(nextDecor / every)
				for side = -1, 1, 2 do
					local tex = opts.decor[(i + (if side < 0 then 0 else 1)) % #opts.decor + 1]
					local e = spawn("Sprite2D", { texture = tex, size = vec2(150, 190) }, root)
					table.insert(decor, { e = e, d = nextDecor, side = side })
				end
				nextDecor += every
			end
			for i = #decor, 1, -1 do
				local dd = decor[i]
				local z = dd.d - sim.dist
				if z < -4 then
					if alive(dd.e) then dd.e:destroy() end
					table.remove(decor, i)
				else
					local x, y, s = proj(mid + dd.side * (sim.lanes / 2 + 0.9), z)
					dd.e.position = vec2(x, y - 95 * s)
					dd.e.scale = vec2(s, s)
					dd.e.z_index = math.floor(400 - z * 4)
				end
			end
		end
		-- player
		local x = 360 + (sim.x - mid) * lw
		local h = sim:height()
		local sl = sim.slide > 0
		v.player.position = vec2(x, py - 60 - h * 150 + (if sl then 30 else 0))
		v.player.scale = if sl then vec2(1.15, 0.6) elseif h > 0 then vec2(0.95, 1.08) else vec2(1, 1)
		v.shadow.position = vec2(x, py + 10)
		v.shadow.scale = vec2(1 - h * 0.4, 1 - h * 0.4)
		v.shieldFx.visible = sim.power.shield > 0
		v.shieldFx.position = v.player.position
		if not sim.alive then v.player.modulate = color("#ff8080") end
	end
	function v.destroy()
		for _, e in pool do if alive(e) then e:destroy() end end
		for _, d in decor do if alive(d.e) then d.e:destroy() end end
		for _, e in { v.player, v.shadow, v.shieldFx } do if alive(e) then e:destroy() end end
		pool, decor = {}, {}
	end
	return v
end

------------------------------------------------------------------ obby
-- obby(o, { root, sprites = { solid, move, vanish, conveyor, bounce, spike, checkpoint, goal, spinner, player, ghost }, colors? })
-- -> view { update(), destroy(), player, ghost } — parts are Sprite2Ds in stage coords; put a Camera2D following view.player.
function M.obby(o, opts)
	local root = opts.root
	local sp = opts.sprites or {}
	local col = opts.colors or {}
	local COL = { solid = "#7bd389", move = "#6fb7ff", vanish = "#ffd166", conveyor = "#c08bff", bounce = "#ff7eb6", spike = "#ff5d5d",
		checkpoint = "#59e3ff", goal = "#ffe066", spinner = "#ff5d5d" }
	local v = { parts = {} }
	for _, p in o.parts do
		local e
		if p.kind == "spinner" then
			e = spawn("Node2D", { position = vec2(p.x, p.y), z_index = 30 }, root)
			for i = 0, (p.arms or 1) - 1 do
				local arm = spawn("Node2D", { rotation = i * 360 / (p.arms or 1) }, e)
				spawn("Sprite2D", { texture = sp.spinner or sp.solid, size = vec2(p.r or 100, 16), position = vec2((p.r or 100) / 2, 0), modulate = color(col.spinner or COL.spinner) }, arm)
			end
			spawn("Sprite2D", { texture = sp.hub or sp.solid, size = vec2(26, 26), modulate = color("#ffffff") }, e)
		else
			local tex = sp[p.kind] or sp.solid
			e = spawn("Sprite2D", { texture = tex, size = vec2(p.w, p.h), position = vec2(p.x + p.w / 2, p.y + p.h / 2), z_index = if p.kind == "checkpoint" or p.kind == "goal" then 5 else 10 }, root)
			if not sp[p.kind] or opts.tintAll then e.modulate = color(col[p.kind] or COL[p.kind] or "#ffffff") end
		end
		v.parts[p.index] = e
	end
	v.ghost = spawn("Sprite2D", { texture = sp.ghost or sp.player, size = vec2(o.c.w + 8, o.c.h + 8), modulate = color("#ffffff66"), visible = false, z_index = 40 }, root)
	v.player = spawn("Sprite2D", { texture = sp.player, size = vec2(o.c.w + 10, o.c.h + 10), position = vec2(o.x, o.y - o.c.h / 2), z_index = 50 }, root)
	function v.update()
		for _, p in o.parts do
			local e = v.parts[p.index]
			if e then
				if p.kind == "spinner" then
					e.rotation = (p.angle or 0) + (p.speed or 90) * o.time
				else
					e.position = vec2(p.px + p.w / 2, p.py + p.h / 2)
					if p.kind == "vanish" then
						e.visible = p.visible
						if p.state == "fading" then e.modulate = color(if math.floor(o.time * 12) % 2 == 0 then "#ffd166" else "#ffd16655") elseif p.visible then e.modulate = color(col.vanish or COL.vanish) end
					elseif p.kind == "checkpoint" then
						e.modulate = color(if p.cp <= o.checkpoint then "#7bd389" else (col.checkpoint or COL.checkpoint))
					end
				end
			end
		end
		v.player.position = vec2(o.x, o.y - o.c.h / 2 - 5)
		v.player.visible = o.dead <= 0
		if o.vx ~= 0 then v.player.flip_h = o.vx < 0 end
		local gx, gy = o:ghostAt(o.time)
		v.ghost.visible = gx ~= nil
		if gx then v.ghost.position = vec2(gx, gy - o.c.h / 2 - 4) end
	end
	function v.destroy()
		for _, e in v.parts do if alive(e) then e:destroy() end end
		for _, e in { v.player, v.ghost } do if alive(e) then e:destroy() end end
	end
	return v
end

return M
