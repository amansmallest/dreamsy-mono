-- Tuning for the kit roguelike demo. `bot = true` makes the hero play itself (headless tests, screenshots).
return {
	bot = false,
	seed = nil, -- fixed run seed (nil = random per run)
	heroHp = 12,
	heroSpeed = 72,
	swing = { range = 20, arc = 140, amount = 2, knockback = 170, cooldown = 0.35 },
	bolt = { speed = 210, amount = 1, cooldown = 0.7, status = "burn", lifetime = 0.9 },
	budget = function(floor) return 3 + floor * 2 end,
}
