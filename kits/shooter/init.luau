--!nonstrict
-- shooter kit: twin-stick arenas, vertical shmups and bullet-hell bosses on top of combat / ai / procgen / juice / core.
-- See KIT.md. Pure modules (emitter, motion, weapons, score, stage, boss, balance) are testable headless;
-- run.play() drives one stage in the current scene.
local S = {}
S.VERSION = "0.1.0"
S.content = require("./content")
S.emitter = require("./emitter")
S.motion = require("./motion")
S.weapons = require("./weapons")
S.score = require("./score")
S.stage = require("./stage")
S.boss = require("./boss")
S.balance = require("./balance")
local Run = require("./run")
S.run = Run
S.ui = require("./ui")
S.hud = require("./hud")
S.events = Run.events

S.newRun = Run.newRun
S.play = Run.play
S.current = Run.current
S.buy = Run.buy
S.canBuy = Run.canBuy
S.shopItems = Run.shopItems
S.shipState = Run.shipState
S.unlockShip = Run.unlockShip
function S.meta() return Run.meta end

--[[ setup(opts?) -> C : load content (data/…), set up core (save key, theme) and register the save section.
   opts: { core = core.setup options (save = { key, version }, theme, …), autoload = true } ]]
local didSetup = false
function S.setup(opts)
	opts = opts or {}
	local core = require("@kit/core")
	local C = S.content.load(opts.content)
	if not didSetup then
		didSetup = true
		local co = opts.core or {}
		co.save = co.save or { key = "shooter", version = 1 }
		co.currencies = co.currencies or { [C.config.currency] = { name = C.config.currencyName or "Credits", start = 0, max = 9999999 } }
		core.setup(co)
		Run.ensureSection()
		if opts.autoload ~= false then pcall(core.save.load) end
	end
	return C
end

return S
