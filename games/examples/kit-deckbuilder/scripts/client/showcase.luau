-- Attract mode / screenshot tour: the kit's bot plays a seeded run and the UI shows one screen of each kind
-- (battle, reward, shop, rest, event, map) for 2 seconds each.
local DB = require("@kit/deckbuilder")
if DB.C == nil then DB.setup({ save = false }) end
local run = DB.newRun({ character = "wick", seed = 4 })
local want = { "battle", "reward", "shop", "rest", "event", "map" }
local o = { background = "asset:bg_undertow", restArt = "asset:rest_fire", shopTitle = "Gill Market", restTitle = "A quiet lamp-lit alcove" }
local function show(kind)
	if kind == "battle" then
		local b = run.battle
		DB.bot.playTurn(b, 1)
		DB.ui.battle(run, b, { background = o.background, heroSprite = "asset:hero_wick" })
	elseif kind == "reward" then DB.ui.rewards(run, o)
	elseif kind == "shop" then DB.ui.shop(run, o)
	elseif kind == "rest" then DB.ui.rest(run, o)
	elseif kind == "event" then DB.ui.event(run, o)
	else DB.ui.map(run, o) end
end
local i = 0
local function nextScreen()
	i += 1
	local kind = want[((i - 1) % #want) + 1]
	for _ = 1, 400 do
		if run.state == kind and (kind ~= "battle" or run.floor >= 4) then break end
		if run.state == "won" or run.state == "lost" then run = DB.newRun({ character = "wick", seed = 4 + i }) end
		DB.bot.step(run)
	end
	show(kind)
end
DB.ui.play({ noStart = true, nodeIcons = (function() local t = {} for _, k in { "fight", "elite", "rest", "shop", "event", "treasure", "boss" } do t[k] = "asset:nd_" .. k end return t end)(),
	intentIcons = (function() local t = {} for _, k in { "attack", "defend", "buff", "debuff", "attack_defend", "attack_debuff", "attack_buff", "unknown" } do t[k] = "asset:in_" .. k end return t end)() })
nextScreen()
every(2, nextScreen)
