--!nonstrict
-- Title / hub: Sprout Cup, Time Trial (track select with ghost + medals), Garage (buy, select, upgrade).
local G = require("../shared/game").init()
local Racing, core = G.Racing, G.core
local juice = require("@kit/juice")
local M = core.menus
juice.reveal("fade")
music.play("menu")

local BG, ACC, TXT, PRI = "#23402c", "#ffd23f", "#fffbea", "#e4572e"
spawn("UIPanel", { anchor = "center", size = vec2(2000, 2000), background = "#4f8a3c", z_index = -10, input_transparent = true })
-- road stripe + flag logo
spawn("UIPanel", { anchor = "top", offset = vec2(0, 0), size = vec2(260, 1280), background = "#c79a64", z_index = -9, input_transparent = true })
for i = 0, 9 do spawn("UIPanel", { anchor = "top", offset = vec2(0, 40 + i * 130), size = vec2(16, 70), background = "#fffbea88", z_index = -8, input_transparent = true }) end
spawn("UIPanel", { anchor = "top", offset = vec2(0, 60), size = vec2(160, 96), image = "asset:logo_flag", background = "#00000000", input_transparent = true })
local function txt(props)
	local p = { anchor = "top", size = vec2(680, 70), align = "center", font = "bold", color = TXT, outline = "#1d1d24", outline_size = 4 }
	for k, v in props do p[k] = v end
	return spawn("UIText", p)
end
txt({ offset = vec2(0, 170), text = "SPROUT", font_size = 88, size = vec2(680, 100), color = ACC })
txt({ offset = vec2(0, 262), text = "SPEEDWAY", font_size = 72, size = vec2(680, 90) })
local status = txt({ offset = vec2(0, 368), font_size = 30, text = "" })
local carImg = spawn("UIPanel", { anchor = "top", offset = vec2(0, 420), size = vec2(102, 162), background = "#00000000", input_transparent = true })
local carName = txt({ offset = vec2(0, 590), font_size = 30, text = "", color = ACC })

local function refresh()
	local id = G.garage.selected
	carImg.image = G.content.cars[id].sprite
	carName.text = G.content.cars[id].name
	local cup = G.cup
	local cupTxt = if cup and not cup:isDone() then "  |  Cup race " .. cup.race .. "/" .. #cup.tracks else ""
	status.text = core.wallet.get("coins") .. " coins  |  Driver Lv " .. G.driver.level .. cupTxt
end
refresh()
juice.float(carImg, { height = 6, seconds = 1.4 })

local function bigButton(y, label, color, fn)
	local b = spawn("UIButton", { anchor = "top", offset = vec2(0, y), size = vec2(560, 104), text = label, font_size = 38, font = "bold", background = color, color = TXT })
	b.pressed:connect(function() sfx.play("select") juice.bounce(b) fn() end)
	return b
end

bigButton(660, "SPROUT CUP", PRI, function()
	if not G.cup or G.cup:isDone() then G.newCup() end
	juice.transition("fade", { scene = "scenes/race.scene.json", params = { mode = "cup" } })
end)

bigButton(780, "TIME TRIAL", "#3fa7d6", function()
	local items = {}
	for _, id in G.trackIds() do
		local d = G.content.tracks[id]
		local best = core.flags.get("best_" .. id, nil)
		table.insert(items, { label = d.name, detail = (if best then Racing.time(best) else "--") .. " " .. G.MEDALS[core.flags.get("medal_" .. id, 0)],
			onSelect = function() juice.transition("fade", { scene = "scenes/race.scene.json", params = { mode = "time_trial", track = id } }) end })
	end
	M.list({ title = "Time Trial  (gold " .. G.MEDAL_COINS[3] .. "c)", items = items })
end)

local openGarage
local function openUpgrades(carId)
	local function items()
		local out = {}
		for _, up in G.garage.upgradeOrder do
			local u = G.cfg.upgrades[up]
			local L, cost = G.garage:level(carId, up), G.garage:upgradeCost(carId, up)
			table.insert(out, { label = u.name .. " " .. string.rep("|", L) .. string.rep(".", G.garage:maxLevel(carId, up) - L),
				detail = if cost then cost .. "c" else "MAX", disabled = cost == nil or not core.wallet.has("coins", cost),
				onSelect = function(_, h)
					if G.garage:upgrade(carId, up) then sfx.play("buy") G.save() refresh() h.refresh(items()) else sfx.play("deny") end
				end })
		end
		return out
	end
	M.list({ title = G.content.cars[carId].name .. " - " .. core.wallet.get("coins") .. "c", items = items(), keepOpen = true })
end
openGarage = function()
	local function items()
		local out = {}
		for _, row in G.garage:list() do
			local d = row.def
			local detail = if row.selected then "DRIVING" elseif row.owned then "owned" elseif not row.unlocked then (d.lockedText or "locked") else row.price .. "c"
			table.insert(out, { label = d.name, detail = detail, disabled = not row.unlocked and not row.owned, onSelect = function(_, h)
				if row.owned then
					G.garage:select(row.id) sfx.play("select") G.save() refresh()
					h.close() openUpgrades(row.id)
				elseif G.garage:buy(row.id) then
					G.garage:select(row.id) sfx.play("buy") juice.confetti() G.save() refresh() h.refresh(items())
				else sfx.play("deny") core.menus.toast("Not enough coins") end
			end })
		end
		return out
	end
	M.list({ title = "Garage", items = items(), keepOpen = true })
end
bigButton(900, "GARAGE", "#8a5a2e", openGarage)

-- daily-ish bonus: none; tips line
txt({ offset = vec2(0, 1030), font_size = 24, size = vec2(680, 80), color = "#fffbeacc", outline_size = 2,
	text = "Steer: stick  |  Brake: down  |  Nitro: A  |  Item: B" })
