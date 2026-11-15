--!strict
-- Spawns parallax backdrop tiles (virtual px, camera zoom 3) under `parent` and returns an updater.
-- f = how much the layer follows the camera (1 = fixed to screen, 0 = world, <0 = foreground faster).
local B = {}

local HALF = 300 -- covers views up to 600 virtual px wide (wide phones)

local LAYERS = {
	{ tex = "asset:sky_day", w = 480, h = 150, y = 75, f = 0.95, z = -100 },
	{ tex = "asset:hills", w = 480, h = 56, y = 78, f = 0.85, z = -90 },
	{ tex = "asset:fields", w = 480, h = 76, y = 138, f = 0.55, z = -80 },
	{ tex = "asset:poles", w = 200, h = 150, y = 101, f = 0.0, z = -70 },
	{ tex = "asset:road", w = 480, h = 40, y = 186, f = 0.0, z = -60 },
	{ tex = "asset:front", w = 480, h = 60, y = 220, f = -0.3, z = 50 },
}

function B.build(parent: any, evening: boolean?)
	local layers = {}
	for _, d in LAYERS do
		local tex = d.tex
		if evening and tex == "asset:sky_day" then
			tex = "asset:sky_evening"
		end
		local n = math.ceil(2 * HALF / d.w) + 1
		local tiles = {}
		for _ = 1, n do
			local props: { [string]: any } = {
				texture = tex,
				size = vec2(d.w, d.h),
				position = vec2(0, d.y),
				z_index = d.z,
			}
			if evening and d.tex ~= "asset:sky_day" then
				props.modulate = "#f6dccb"
			end
			table.insert(tiles, spawn("Sprite2D", props, parent))
		end
		table.insert(layers, { tiles = tiles, f = d.f, w = d.w, y = d.y })
	end

	local self = {}
	-- realX: actual camera center x. virtX: pretend camera x (for title/ending auto-scroll).
	function self.update(realX: number, virtX: number?)
		local vx = virtX or realX
		local shift = realX - vx
		for _, L in layers do
			local base = vx * L.f
			local k = math.floor((vx - HALF - base) / L.w)
			for i, t in L.tiles do
				t.position = vec2(math.floor(base + (k + i - 1) * L.w + L.w / 2 + shift), L.y)
			end
		end
	end
	return self
end

return B
