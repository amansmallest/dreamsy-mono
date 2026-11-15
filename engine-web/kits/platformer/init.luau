-- platformer kit: require("@kit/platformer"). See KIT.md.
-- Tight controller, tile-tag level features, enemy + boss libraries from data, checkpoints,
-- collectibles, world map with unlocks, camera rules, parallax, HUD, save.
local Kit = {}

Kit.VERSION = "0.1.0"

Kit.util = require("./util")
Kit.content = require("./content")
Kit.tiles = require("./tiles")
Kit.controller = require("./controller")
Kit.enemies = require("./enemies")
Kit.boss = require("./boss")
Kit.progress = require("./progress")
Kit.world = require("./world")
Kit.camera = require("./camera")
Kit.hud = require("./hud")
Kit.level = require("./level")
Kit.worldmap = require("./worldmap")

-- Optional: kit.setup({ enemies = {...}, bosses = {...}, world = {...} }) registers Luau tables (tests,
-- generated content); they take precedence. Anything not given is read lazily from data/enemies/*.json,
-- data/bosses/*.json and data/world.json through the engine data reader.
function Kit.setup(cfg)
	cfg = cfg or {}
	if cfg.enemies then Kit.content.register("enemies", cfg.enemies) end
	if cfg.bosses then Kit.content.register("bosses", cfg.bosses) end
	if cfg.world then Kit.world.setData(cfg.world) end
	return Kit
end

-- Shortcuts
function Kit.startLevel(opts) return Kit.level.start(opts) end
function Kit.startWorldMap(opts) return Kit.worldmap.start(opts) end

return Kit
