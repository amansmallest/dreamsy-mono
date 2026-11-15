--!nonstrict
-- Race scene: a cup race or a time trial. The racing kit's view builds the whole scene; this script only
-- decides who races and what happens at the finish (points, coins, medals, next race).
local G = require("../shared/game").init()
local Racing, core = G.Racing, G.core
local juice = require("@kit/juice")
juice.reveal("fade")
local p = sceneParams()
local mode = p.mode or "cup"
local function toMenu() juice.transition("fade", { scene = "scenes/menu.scene.json" }) end
local function again(params) juice.transition("fade", { scene = "scenes/race.scene.json", params = params }) end

if mode == "time_trial" then
	local trackId = p.track or "pea_patch"
	local def = G.content.tracks[trackId]
	Racing.view.race({
		track = def, tileset = def.tileset, mode = "time_trial", player = G.playerSpec(), countdown = 3,
		ghost = Racing.ghost.best(trackId), recordGhost = trackId, autopilot = p.autopilot, music = "race", oilSprite = "asset:oil_blob",
		onFinish = function(results, h)
			local me = h.player
			local medal = G.medalFor(trackId, me.time)
			local key = "medal_" .. trackId
			local old = core.flags.get(key, 0)
			local coins = 0
			if medal > old then
				for m = old + 1, medal do coins += G.MEDAL_COINS[m] end
				core.flags.set(key, medal)
				core.wallet.add("coins", coins)
			end
			local best = core.flags.get("best_" .. trackId, nil)
			if not best or me.time < best then core.flags.set("best_" .. trackId, me.time) end
			G.save()
			h.hud:results(results, {
				title = def.name, names = G.names(),
				value = function(row) return Racing.time(row.time) end,
				extra = function(row) return G.MEDALS[medal] end,
				note = "Best lap " .. Racing.time(me.best) .. (if h.newRecord then "  - new ghost!" else "") .. (if coins > 0 then "   +" .. coins .. " coins" else ""),
				buttons = { { "RETRY", function() again({ mode = "time_trial", track = trackId }) end }, { "MENU", toMenu } },
			})
		end,
	})
else
	local cup = G.cup
	if not cup or cup:isDone() then cup = G.newCup() end
	local raceIndex = cup.race
	local trackId = cup:track()
	local def = G.content.tracks[trackId]
	Racing.view.race({
		track = def, tileset = def.tileset, mode = "race", laps = def.laps, player = G.playerSpec(), rivals = G.rivalSpecs(raceIndex),
		difficulty = G.cupDef.difficulty, music = "race", autopilot = p.autopilot, oilSprite = "asset:oil_blob", names = G.names(),
		onFinish = function(results, h)
			local gained = cup:record(results)
			local place = 0
			for i, r in results do if r.player then place = i end end
			local coins = G.reward(place)
			core.emit("race_finished", { track = trackId, place = place })
			local done = cup:isDone()
			local title = def.name .. "  (" .. raceIndex .. "/" .. #cup.tracks .. ")"
			local buttons
			if done then
				local champ = cup:placeOf("you") == 1
				local note = "Cup place: " .. Racing.ordinal(cup:placeOf("you"))
				if champ then
					core.wallet.add("coins", G.cupDef.reward.coins)
					core.flags.set(G.cupDef.reward.flag, true)
					note ..= "  - CHAMPION! +" .. G.cupDef.reward.coins
				end
				buttons = { { "STANDINGS", function()
					local rows = {}
					for _, s in cup:standings() do table.insert(rows, { id = s.id, name = G.names()[s.id], player = s.id == "you", points = s.points }) end
					h.hud:results(rows, { title = G.cupDef.name, names = G.names(), note = note,
						value = function(row) return row.points .. " pts" end, extra = function() return "" end,
						buttons = { { "NEW CUP", function() G.newCup() again({ mode = "cup" }) end }, { "MENU", toMenu } } })
				end } }
			else
				buttons = { { "NEXT RACE", function() again({ mode = "cup" }) end }, { "MENU", toMenu } }
			end
			G.save()
			h.hud:results(results, { title = title, names = G.names(),
				extra = function(row) return "+" .. (gained[row.id] or 0) end,
				note = "+" .. coins .. " coins", buttons = buttons })
		end,
	})
end
