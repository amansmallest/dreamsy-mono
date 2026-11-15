-- Shared tunables for Village Raiders
local C = {}

C.TILE = 48            -- pixels per grid cell
C.GRID = 12            -- grid is GRID x GRID cells
C.SIM_DT = 0.05        -- fixed raid simulation step (deterministic)
C.RAID_TIME = 120      -- seconds per raid
C.START_GOLD = 500
C.START_ELIXIR = 500
C.TOWNHALL_CAP = 1000
C.STORAGE_CAP = 1000
C.ARMY_PER_BARRACKS = 20
C.CAMERA_POS = { 620, 300 }

C.buildings = {
	townhall = { name = "Town Hall", label = "HALL", color = "#ffb703", labelColor = "#3d1f00", hp = 1600, size = 42, cost = 0, res = "gold", max = 1,
		info = "The heart of your village. Holds 1000 gold and elixir." },
	mine = { name = "Gold Mine", label = "MINE", color = "#ffd23f", labelColor = "#3d2b00", hp = 400, size = 36, cost = 60, res = "elixir", max = 6,
		rate = 4, produces = "gold", info = "Digs up 4 gold every second." },
	pump = { name = "Elixir Pump", label = "PUMP", color = "#d36bff", labelColor = "#2a0040", hp = 400, size = 36, cost = 60, res = "gold", max = 6,
		rate = 4, produces = "elixir", info = "Pumps 4 elixir every second." },
	storage = { name = "Storage", label = "STORE", color = "#a1887f", labelColor = "#ffffff", hp = 700, size = 38, cost = 120, res = "gold", max = 4,
		info = "+1000 gold and elixir capacity." },
	wall = { name = "Wall", label = "", color = "#b0bec5", labelColor = "#ffffff", hp = 350, size = 40, cost = 10, res = "gold", max = 60,
		info = "Blocks enemy troops. They must smash through!" },
	cannon = { name = "Cannon", label = "CANNON", color = "#455a64", labelColor = "#ffffff", hp = 550, size = 36, cost = 150, res = "gold", max = 5,
		range = 4.0, dmg = 45, rate = 1.2, info = "Big booms at close range." },
	tower = { name = "Archer Tower", label = "TOWER", color = "#ff6f91", labelColor = "#ffffff", hp = 450, size = 36, cost = 200, res = "gold", max = 4,
		range = 5.5, dmg = 16, rate = 0.6, info = "Rapid arrows from far away." },
	barracks = { name = "Barracks", label = "TRAIN", color = "#e63946", labelColor = "#ffffff", hp = 500, size = 38, cost = 120, res = "elixir", max = 3,
		info = "Trains troops. Each one adds 20 army space." },
}

C.troops = {
	brawler = { name = "Brawler", label = "B", color = "#ff8c42", labelColor = "#3d1f00", hp = 130, dmg = 14, rate = 1.0, speed = 1.8,
		range = 0.6, space = 1, cost = 25, size = 16 },
	archer = { name = "Archer", label = "A", color = "#7bd389", labelColor = "#0d3b16", hp = 55, dmg = 11, rate = 1.0, speed = 2.0,
		range = 3.0, space = 1, cost = 40, size = 14 },
	giant = { name = "Giant", label = "G", color = "#8ecae6", labelColor = "#023047", hp = 700, dmg = 32, rate = 2.0, speed = 1.1,
		range = 0.7, space = 5, cost = 150, size = 26, prefers = "defense" },
}

return C
