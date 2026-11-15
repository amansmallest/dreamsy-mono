-- Pebble Dash tuning. `bot = true`: runs play themselves and menus auto-pick (headless tests, screenshots).
return {
	bot = false,
	seed = nil,        -- fixed run seed (nil = random)
	botMode = "endless", -- bot: "endless" | "obby"
	stage = nil,       -- bot obby stage id (nil = first)
}
