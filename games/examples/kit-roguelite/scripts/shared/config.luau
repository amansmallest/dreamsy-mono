-- Lanternfall tuning. `bot = true`: the hero plays itself and menus auto-pick (headless tests, screenshots).
return {
	bot = false,
	seed = nil,        -- fixed run seed (nil = random)
	class = nil,       -- bot: class to play (nil = first unlocked)
	tileSize = 16,
	arena = { w = 15, h = 20 },
	heroIframes = 0.7,
}
