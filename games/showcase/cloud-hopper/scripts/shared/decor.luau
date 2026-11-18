local decor = {}

function decor.sky(parent)
	return spawn("Sprite2D", { texture = "asset:sky_grad", size = vec2(600, 1000), z_index = -20 }, parent)
end

function decor.clouds(parent, x0, x1, y0, y1, n)
	for i = 1, n do
		local w = random(150, 270)
		local s = spawn("Sprite2D", {
			texture = (i % 2 == 0) and "asset:cloud_a" or "asset:cloud_b",
			size = vec2(w, w * 0.5),
			position = vec2(random(x0, x1), random(y0, y1)),
			z_index = -10,
			flip_h = random() < 0.5,
		}, parent)
		tween(s, { position = s.position + vec2(random(-30, 30), 0) }, random(4, 8), { easing = "sine_in_out", loop = true, yoyo = true })
	end
end

function decor.block(parent, pos, h, tex, w)
	local sz = vec2(w or 64, w or 64)
	local body = spawn("Body2D", { position = pos, body = "static", size = sz, height = h, layer = "block", mask = "hero" }, parent)
	spawn("Sprite2D", { texture = tex, size = sz, height = h }, body)
	return body
end

return decor
