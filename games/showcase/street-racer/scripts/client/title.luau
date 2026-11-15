-- title.luau: scrolling key-art road, start button.
local State = require("../shared/state")

local layer = entity("title_layer")
local H = 1536
local scrollers = {}

local function sp(tex, x, y, w, h, rot, z, mod)
	local props: any = { position = vec2(x, y), size = vec2(w, h), rotation = rot, z_index = z }
	if tex then props.texture = tex end
	if mod then props.modulate = mod end
	return spawn("Sprite2D", props, layer)
end

sp(nil, 0, 0, 1800, 1000, 0, -30, "#c6955b")
for k = 0, 5 do
	local y = -768 + 128 + k * 256
	table.insert(scrollers, { e = sp("asset:road_straight", 0, y, 256, 256, 0, -10), x = 0, y = y })
end
local BLD = { "asset:bld_warehouse", "asset:bld_containers", "asset:bld_brown", "asset:bld_white", "asset:bld_containers" }
for side = -1, 1, 2 do
	for col = 0, 4 do
		for row = 0, 11 do
			local x = side * (204 + col * 128) + random(-6, 6)
			local y = -768 + 64 + row * 128 + random(-6, 6)
			local e
			if col == 0 and math.random() < 0.3 then
				e = sp("asset:bld_small", x, y, 64, 64, math.random(0, 3) * 90, -20)
			else
				e = sp(BLD[math.random(1, #BLD)], x, y, 96, 96, math.random(0, 1) * 180, -20)
			end
			table.insert(scrollers, { e = e, x = x, y = y })
		end
	end
end

local CARS = {
	{ "asset:car_red", -40, 150, 0.0, 1.0 },
	{ "asset:car_blue", 50, 40, 1.3, 0.8 },
	{ "asset:car_green", 70, 250, 2.1, 1.2 },
	{ "asset:car_orange", -75, 320, 0.7, 0.9 },
}
local cars = {}
for _, c in CARS do
	local sh = sp(c[1], c[2] + 3, c[3] + 5, 32, 48, 0, 4, "#3b333877")
	local e = sp(c[1], c[2], c[3], 32, 48, 0, 6)
	table.insert(cars, { e = e, sh = sh, x = c[2], y = c[3], ph = c[4], sp = c[5], fx = 0 })
end

local smokes = {}

if State.bestTime then
	entity("title_best").text = string.format("BEST RACE %02d:%05.2f", math.floor(State.bestTime / 60), State.bestTime % 60)
end

music.play("title", { fade = 0.5 })

local started = false
local function start()
	if started then return end
	started = true
	sfx.play("select")
	loadScene("scenes/race.scene.json")
end
entity("btn_start").pressed:connect(start)

local t = 0
onTick(function(dt)
	t += dt
	for _, s in scrollers do
		s.y += 520 * dt
		if s.y > H / 2 then s.y -= H end
		s.e.position = vec2(s.x, s.y)
	end
	for _, c in cars do
		local y = c.y + math.sin(t * c.sp + c.ph) * 40
		local x = c.x + math.sin(t * c.sp * 0.7 + c.ph * 2) * 18
		local rot = math.cos(t * c.sp * 0.7 + c.ph * 2) * 8
		c.e.position = vec2(x, y)
		c.e.rotation = rot
		c.sh.position = vec2(x + 3, y + 5)
		c.sh.rotation = rot
		c.fx -= dt
		if c.fx <= 0 then
			c.fx = 0.08
			if #smokes < 40 then
				table.insert(smokes, { e = sp("asset:smoke", x + random(-6, 6), y + 26, 12, 12, 0, 3), x = x, y = y + 26, life = 0.4 })
			end
		end
	end
	for i = #smokes, 1, -1 do
		local s = smokes[i]
		s.life -= dt
		if s.life <= 0 then
			s.e:destroy()
			table.remove(smokes, i)
		else
			s.y += 380 * dt
			s.e.position = vec2(s.x, s.y)
			s.e.modulate = string.format("#ffffff%02x", math.floor(200 * s.life / 0.4))
		end
	end
	if input.pressed("action") or input.pressed("jump") then start() end
end)
