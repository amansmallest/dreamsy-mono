-- topdown kit: require("@kit/topdown"). See KIT.md.
-- Zelda-like action-adventure: 8-dir hero, sword + items, hearts, enemy/boss library from data,
-- items that gate areas, keys/locked doors, puzzles, rooms with a room-locked camera, warps,
-- NPC dialog/shops/chests, minimap, save. Built on @kit/core (content, bag, wallet, flags, save, dialog),
-- @kit/ai ("ai" enemies) and @kit/juice (effects).
local Kit = {}

Kit.VERSION = "0.1.0"

Kit.util = require("./util")
Kit.content = require("./content")
Kit.grid = require("./grid")
Kit.player = require("./player")
Kit.enemies = require("./enemies")
Kit.boss = require("./boss")
Kit.progress = require("./progress")
Kit.hud = require("./hud")
Kit.area = require("./area")

-- kit.setup(content?) -> kit: content = { items?, enemies?, bosses?, npcs?, warps? } tables (tests, generated
-- content); every kind not given is read from the game's data/ files.
function Kit.setup(cfg)
	cfg = cfg or {}
	for _, kind in Kit.content.KINDS do
		if cfg[kind] then Kit.content.register(kind, cfg[kind]) else Kit.content.load(kind) end
	end
	return Kit
end

function Kit.startArea(opts) return Kit.area.start(opts) end

return Kit
