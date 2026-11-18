--!nonstrict
-- Portrait screens on core.menus (modal, themed, ≥96 px targets): class select, doors, relic pick, shop, rest,
-- event, run summary, meta tree, relic list. Each takes callbacks and returns the menu handle.
local S = require("./state")
local M = {}

M.LABELS = { combat = "Fight", elite = "Elite", treasure = "Treasure", shop = "Shop", event = "Mystery", rest = "Campfire", boss = "BOSS" }
M.ICONS = {} -- optional { combat = "asset:door_fight", ... } (game sets)
M.RARITY = { common = "#c8d0dc", uncommon = "#6fd08c", rare = "#5fb4ff", boss = "#ffb347", starter = "#c8d0dc" }

local function menus() return S.core.menus end
local function th() return menus().theme() end

local function card(parent, x, y, w, h, icon, title, body, accent, onTap)
	local m = menus()
	local p = m.panel(parent, { anchor = "top", offset = vec2(x, y), size = vec2(w, h), background = th().primary, z_index = 905 })
	if accent then m.panel(p, { anchor = "left", offset = vec2(0, 0), size = vec2(10, h), background = accent, z_index = 906 }) end
	if icon then spawn("UIPanel", { anchor = "left", offset = vec2(26, 0), size = vec2(88, 88), image = icon, background = "#00000000", z_index = 907, input_transparent = true }, p) end
	local tx = if icon then 130 else 30
	m.text(p, title, { anchor = "top_left", offset = vec2(tx, 12), size = vec2(w - tx - 20, 44), align = "left", font_size = 30, color = accent or th().accent, z_index = 907, input_transparent = true })
	if body then m.text(p, body, { anchor = "top_left", offset = vec2(tx, 56), size = vec2(w - tx - 20, h - 64), align = "left", font_size = 22, z_index = 907, input_transparent = true }) end
	if onTap then p.tapped:connect(onTap) end
	return p
end
M.card = card

-- relicText(id) -> name, description, color
function M.relicText(id)
	local d = S.req("relics", id)
	return d.name or id, d.description or "", M.RARITY[d.rarity or "common"]
end

-- classSelect({ classes = roguelite.classes(), onPick(classId, heat), title? })
function M.classSelect(opts)
	local m = menus()
	local list = opts.classes
	local h = m.modal(660, 240 + #list * 196, opts.title or "Choose your hero", { pause = false })
	for i, c in list do
		local d = c.def
		local body = d.description or ""
		if not c.unlocked then body = "LOCKED  " .. (d.unlockText or "") end
		if c.unlocked and c.maxHeat > 0 then body ..= "\nHeat up to " .. c.maxHeat .. "  ·  wins " .. c.wins end
		card(h.box, 0, 100 + (i - 1) * 196, 600, 180, d.icon, d.name or c.id, body, if c.unlocked then nil else "#888888", function()
			if not c.unlocked then m.toast(d.unlockText or "Locked", 1.5) return end
			if c.maxHeat > 0 and not opts.noHeat then
				h.close()
				M.heat(c.id, c.maxHeat, function(heat) opts.onPick(c.id, heat) end)
			else
				h.close()
				opts.onPick(c.id, 0)
			end
		end)
	end
	m.button(h.box, "Back", function() h.close() if opts.onBack then opts.onBack() end end, { anchor = "bottom", offset = vec2(0, -16), size = vec2(580, 96), background = th().disabled })
	return h
end

-- heat(classId, maxHeat, onPick(heat))
function M.heat(classId, maxHeat, onPick)
	local items = { { label = "Heat 0 (normal)", onSelect = function() onPick(0) end } }
	for i = 1, maxHeat do
		local hd = S.config.heat[i] or {}
		table.insert(items, { label = "Heat " .. i .. ": " .. (hd.name or ""), onSelect = function() onPick(i) end })
	end
	return menus().list({ title = "Heat", items = items, closeLabel = false, pause = false })
end

-- doors(run, onPick(i))
function M.doors(run, onPick)
	local m = menus()
	local ch = run:choices()
	local biome = S.get("biomes", run.plan.biome)
	local h = m.modal(660, 150 + #ch * 160, (biome and biome.name or "") .. "  " .. run.floor .. "-" .. (run.step + 1), { pause = false })
	m.text(h.box, "Choose a door", { offset = vec2(0, 74), size = vec2(600, 40), font_size = 26 })
	for i, room in ch do
		local label = M.LABELS[room.type] or room.type
		local body = ({ combat = "Monsters + gold", elite = "Tough foes, relic reward", treasure = "Pick a relic", shop = "Spend gold",
			event = "Something strange...", rest = "Heal or grow", boss = "Guardian of the depths" })[room.type]
		card(h.box, 0, 124 + (i - 1) * 160, 600, 144, M.ICONS[room.type], label, body, if room.type == "boss" or room.type == "elite" then "#ff6b6b" else nil, function()
			h.close()
			onPick(i)
		end)
	end
	return h
end

-- relicChoice(run, onDone(id|nil)): pick 1 of run.pending (or skip for gold)
function M.relicChoice(run, onDone)
	local m = menus()
	local ids = run.pending or {}
	local h = m.modal(660, 360 + #ids * 176, "Choose a relic", { pause = false })
	for i, id in ids do
		local d = S.req("relics", id)
		local name, desc, col = M.relicText(id)
		local n = run:relicCount(id)
		if n > 0 then name ..= "  (x" .. (n + 1) .. ")" end
		card(h.box, 0, 100 + (i - 1) * 176, 600, 160, d.icon, name, desc, col, function()
			h.close()
			run:takeRelic(i)
			onDone(id)
		end)
	end
	m.button(h.box, "Skip (+10 gold)", function() h.close() run:skipReward() onDone(nil) end, { anchor = "bottom", offset = vec2(0, -16), size = vec2(580, 96), background = th().disabled })
	return h
end

-- shop(run, onDone)
function M.shop(run, onDone)
	local m = menus()
	local h
	local function build()
		local items = {}
		for i, it in run.room.stock do
			local label
			if it.kind == "relic" then label = (S.req("relics", it.id).name or it.id)
			elseif it.kind == "active" then label = "Active: " .. (S.req("actives", it.id).name or it.id)
			else label = "Heal " .. math.floor(it.amount * 100) .. "%" end
			table.insert(items, { label = label, detail = if it.sold then "SOLD" else it.price .. "g", disabled = it.sold or run.gold < it.price, onSelect = function()
				local ok = run:buy(i)
				if ok then m.toast("Bought " .. label, 1.2) end
				h.refresh(build())
			end })
		end
		return items
	end
	h = m.list({ title = "Shop  ·  " .. run.gold .. "g", items = build(), keepOpen = true, closeLabel = "Leave", pause = false, onClose = function() run:clear() onDone() end })
	return h
end

-- rest(run, onDone)
function M.rest(run, onDone)
	local cfg = S.config.rest
	return menus().list({ title = "Campfire", closeLabel = false, pause = false, items = {
		{ label = "Rest: heal " .. math.floor(cfg.heal * 100) .. "%", onSelect = function() run:rest("heal") onDone() end },
		{ label = "Train: +" .. cfg.maxHp .. " max HP", onSelect = function() run:rest("maxHp") onDone() end },
	} })
end

-- event(run, onDone(reward))
function M.event(run, onDone)
	local m = menus()
	local d = run:eventDef()
	local ch = run:eventChoices()
	local h = m.modal(660, 420 + #ch * 112, d.title or "Event", { pause = false })
	m.text(h.box, d.text or "", { offset = vec2(0, 90), size = vec2(600, 200), font_size = 26 })
	for i, c in ch do
		m.button(h.box, c.text, function()
			if not c.ok then m.toast("You can't", 1) return end
			h.close()
			onDone(run:choose(c.index))
		end, { offset = vec2(0, 300 + (i - 1) * 112), size = vec2(600, 96), font_size = 24, background = if c.ok then th().primary else th().disabled })
	end
	return h
end

-- summary(sum, onDone): run summary screen (after roguelite.finish)
function M.summary(sum, onDone)
	local m = menus()
	local h = m.modal(660, 860, if sum.won then "VICTORY" else "RUN OVER", { pause = false })
	local cls = S.get("classes", sum.class)
	local lines = {
		(cls and cls.name or sum.class) .. (if sum.heat and sum.heat > 0 then "  ·  Heat " .. sum.heat else "") .. (if sum.daily then "  ·  Daily" else ""),
		"Floor " .. sum.floor .. " / " .. sum.floors .. (if sum.newBest then "  NEW BEST" else ""),
		"Rooms " .. sum.rooms .. "   Kills " .. sum.kills,
		"Gold earned " .. sum.gold,
		"Relics " .. #sum.relics,
		"+" .. (sum.metaEarned or 0) .. " " .. S.config.metaName,
	}
	if sum.unlockedHeat then table.insert(lines, "Heat " .. sum.unlockedHeat .. " unlocked!") end
	for i, l in lines do
		m.text(h.box, l, { offset = vec2(0, 100 + (i - 1) * 64), size = vec2(600, 56), font_size = if i == 6 then 34 else 30, color = if i == 6 then th().accent else th().text })
	end
	m.button(h.box, "Continue", function() h.close() onDone() end, { anchor = "bottom", offset = vec2(0, -24), size = vec2(580, 96) })
	return h
end

-- metaTree(onClose?): buy meta nodes with the meta currency
function M.metaTree(onClose)
	local m = menus()
	local t = require("./meta").tree
	local h
	local function build()
		local items = {}
		for _, e in t:list() do
			local cost = t:cost(e.id)
			local c = cost[S.config.metaCurrency] or 0
			local d = e.def
			local tag = if e.state == "max" then "OWNED" elseif e.state == "locked" then "locked" else c .. ""
			table.insert(items, { label = (d.name or e.id), detail = tag, disabled = e.state ~= "available", onSelect = function()
				local ok = t:unlock(e.id)
				if ok then m.toast((d.name or e.id) .. "!", 1.2) S.core.save.save() end
				h.refresh(build())
			end })
		end
		return items
	end
	h = m.list({ title = S.config.metaName .. ": " .. S.core.wallet.get(S.config.metaCurrency), items = build(), keepOpen = true, perPage = 6, pause = false, onClose = onClose })
	return h
end

-- relicList(run): owned relics + active synergies
function M.relicList(run)
	local items = {}
	for _, r in run.relics do
		local name, desc = M.relicText(r.id)
		table.insert(items, { label = name .. (if r.count > 1 then " x" .. r.count else ""), fontSize = 24 })
	end
	for _, s in run:synergies() do table.insert(items, { label = "SET: " .. (s.def.name or s.def.id), fontSize = 24 }) end
	if #items == 0 then items = { { label = "No relics yet" } } end
	return menus().list({ title = "Relics", items = items, keepOpen = true, pause = true })
end

return M
