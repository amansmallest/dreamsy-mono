-- rpg kit: battles — require("@kit/rpg/battle").
--   Battle.new(opts) / damage / catchChance / runChance / TEXT  — the pure engine (battle_core.luau)
--   Battle.start({ trainer = "id" } | { creature = "id", level = 5, can_run = true }, done(result))
--     plays a full battle screen (portrait: foe top, you bottom, move buttons) and applies the result
--     to the game state (XP, catches, money, beaten-trainer flags, blackout).
local U = require("./util")
local Content = require("./content")
local State = require("./state")
local Events = require("./events")
local Creatures = require("./creatures")
local Logic = require("./logic")
local Core = require("./battle_core")
local W = require("./widgets")
local R = require("./runtime")
local Juice = require("@kit/juice")

local BT = setmetatable({}, { __index = Core })
BT.Core = Core
BT.speed = 1 -- >1 = faster messages/animations (tests, impatient players)
BT.current = nil -- the screen state while a battle is on

local STAGE = vec2(0, -40000) -- battle stage lives far away from any map

local function bcfg()
	return Content.config.battle or {}
end
local function secs(x: number): number
	return x / math.max(0.05, BT.speed)
end

-- bag adapter for the core
local bagAdapter = {
	count = function(id) return State.count(id) end,
	take = function(id) return State.take(id, 1) end,
}

local function trainerParty(t)
	local party = {}
	for _, p in t.party do
		local mon = Creatures.create(p.creature, p.level or 5, nil, { genes = p.genes or { hp = 8, atk = 8, def = 8, mag = 8, res = 8, spd = 8 }, moves = p.moves })
		if p.held then mon.held = p.held end
		if p.name then mon.name = p.name end
		table.insert(party, mon)
	end
	return party
end

-- ---------------------------------------------------------------- screen

local function makeStage(S, bgOverride)
	local t = W.theme()
	local cfgb = bcfg()
	local scr = W.screen()
	local root = spawn("Node2D", { position = STAGE, z_index = 0 })
	S.stage = root
	local sky = bgOverride and bgOverride.sky or cfgb.sky or "#7ec4cf"
	local ground = bgOverride and bgOverride.ground or cfgb.ground or "#5a9f68"
	local bgTex = bgOverride and bgOverride.background or cfgb.background
	spawn("Sprite2D", { position = vec2(0, 0), size = scr + vec2(40, 40), modulate = sky, z_index = 0 }, root)
	if bgTex then
		spawn("Sprite2D", { position = vec2(0, 0), size = scr + vec2(40, 40), texture = bgTex, z_index = 1 }, root)
	else
		spawn("Sprite2D", { position = vec2(0, scr.y * 0.18), size = vec2(scr.x + 40, scr.y * 0.64 + 40), modulate = ground, z_index = 1 }, root)
	end
	local platTex = cfgb.platform
	local foePos = vec2(scr.x * 0.22, -scr.y * 0.245)
	local myPos = vec2(-scr.x * 0.25, -scr.y * 0.025)
	S.foePos, S.myPos = foePos, myPos
	local size = cfgb.sprite_size or 240
	S.size = size
	local platSize = vec2(size * 1.25, size * 0.32)
	spawn("Sprite2D", { position = foePos + vec2(0, size * 0.42), size = platSize, texture = platTex, modulate = if platTex then "#ffffff" else W.alpha("#000000", 0.18), z_index = 2 }, root)
	spawn("Sprite2D", { position = myPos + vec2(0, size * 0.42), size = platSize, texture = platTex, modulate = if platTex then "#ffffff" else W.alpha("#000000", 0.18), z_index = 2 }, root)
	S.foeSprite = spawn("Sprite2D", { position = foePos, size = vec2(size, size), z_index = 5, scale = vec2(0, 0) }, root)
	S.mySprite = spawn("Sprite2D", { position = myPos, size = vec2(size, size), z_index = 6, scale = vec2(0, 0) }, root)
	S.fx = spawn("Particles2D", {
		position = foePos, emitting = false, lifetime = 0.5, speed = 260, spread = 360, start_size = 14, end_size = 2,
		start_color = t.accent, end_color = W.alpha(t.accent, 0), max_particles = 128, damping = 2, z_index = 20,
	}, root)
	S.cam = spawn("Camera2D", { position = STAGE, zoom = 1, current = true }, nil)
end

local function setSprite(S, side: number)
	local b = S.core
	local mon = b:active(side)
	local spr = if side == 1 then S.mySprite else S.foeSprite
	if side == 1 then
		local back = Creatures.species(mon).sprites.back
		spr.texture = back or Creatures.sprite(mon, "front")
		spr.flip_h = back == nil
	else
		spr.texture = Creatures.sprite(mon, "front")
		spr.flip_h = false
	end
	spr.modulate = "#ffffff"
	spr.position = if side == 1 then S.myPos else S.foePos
end

local function infoPanel(S, side: number)
	local t = W.theme()
	local scr = W.screen()
	local w = math.min(400, scr.x * 0.56)
	local p
	if side == 2 then
		p = W.panel(S.ui, { anchor = "top_left", offset = vec2(24, 36), size = vec2(w, 124), bg = W.alpha(t.background, 0.9), z = 10 })
	else
		p = W.panel(S.ui, { anchor = "top_right", offset = vec2(-24, scr.y * 0.455), size = vec2(w, 150), bg = W.alpha(t.background, 0.9), z = 10 })
	end
	local info = { root = p }
	info.name = W.text(p, { text = "", anchor = "top_left", offset = vec2(20, 12), size = vec2(w - 150, 40), font_size = 28 })
	info.level = W.text(p, { text = "", anchor = "top_right", offset = vec2(-20, 12), size = vec2(120, 40), font_size = 24, align = "right", color = t.accent })
	info.status = W.text(p, { text = "", anchor = "top_left", offset = vec2(20, 54), size = vec2(80, 30), font_size = 18, color = t.warn })
	W.text(p, { text = "HP", anchor = "top_left", offset = vec2(92, 56), size = vec2(50, 30), font_size = 18, color = t.accent })
	info.hp = W.bar(p, { anchor = "top_left", offset = vec2(140, 60), size = vec2(w - 160, 20) })
	if side == 1 then
		info.hpText = W.text(p, { text = "", anchor = "top_right", offset = vec2(-20, 86), size = vec2(200, 30), font_size = 22, align = "right" })
		info.xp = W.bar(p, { anchor = "bottom_left", offset = vec2(20, -12), size = vec2(w - 40, 12), inset = 2, color = t.primary })
	end
	return info
end

local function refreshInfo(S, side: number, animate: boolean?)
	local b = S.core
	local mon = b:active(side)
	local info = if side == 1 then S.myInfo else S.foeInfo
	info.name.text = Creatures.name(mon)
	info.level.text = "Lv" .. mon.level
	info.status.text = (mon.status and (Core.STATUS_LABEL[mon.status] or string.upper(string.sub(mon.status, 1, 3)))) or ""
	local f = mon.hp / math.max(1, mon.maxhp)
	info.hp.set(f, if animate then secs(0.45) else nil)
	info.hp.color(W.hpColor(f))
	if info.hpText then info.hpText.text = mon.hp .. " / " .. mon.maxhp end
	if info.xp then info.xp.set(Creatures.xpProgress(mon), if animate then secs(0.5) else nil) end
end

local function setMessage(S, text: string)
	S.msg.text = text
end

local function clearMenu(S)
	if S.menu then W.destroy(S.menu) end
	S.menu = nil
end

-- ---------------------------------------------------------------- animations per event

local function flash(spr, times: number)
	for i = 0, times - 1 do
		U.after(secs(0.08 * i * 2), function()
			if W.alive(spr) then spr.modulate = "#ffffff40" end
		end)
		U.after(secs(0.08 * (i * 2 + 1)), function()
			if W.alive(spr) then spr.modulate = "#ffffff" end
		end)
	end
end

local function animate(S, ev): number
	local t = ev.t
	local b = S.core
	local function spr(side) return if side == 1 then S.mySprite else S.foeSprite end
	if t == "send" then
		setSprite(S, ev.side)
		local s = spr(ev.side)
		s.scale = vec2(0.1, 0.1)
		tween(s, { scale = vec2(1, 1) }, secs(0.35), "back_out")
		refreshInfo(S, ev.side, false)
		S.fx.position = (if ev.side == 1 then S.myPos else S.foePos)
		S.fx.start_color = color(W.theme().accent)
		S.fx:burst(16)
		local mon = b:active(ev.side)
		U.sfx((Creatures.species(mon).cry) or (Content.config.sfx and Content.config.sfx.send))
		return 0.45
	elseif t == "recall" then
		tween(spr(ev.side), { scale = vec2(0.05, 0.05) }, secs(0.25), "quad_in")
		return 0.3
	elseif t == "move" then
		local s = spr(ev.side)
		local home = if ev.side == 1 then S.myPos else S.foePos
		local dir = if ev.side == 1 then vec2(40, -30) else vec2(-40, 30)
		if ev.category ~= "status" then
			tween(s, { position = home + dir }, secs(0.12), { easing = "quad_out", yoyo = true })
		else
			tween(s, { scale = vec2(1.08, 1.08) }, secs(0.15), { easing = "sine_in_out", yoyo = true })
		end
		local m = Content.moves[ev.move]
		U.sfx((m and m.sfx) or (Content.config.sfx and Content.config.sfx.attack))
		return 0.3
	elseif t == "damage" then
		local s = spr(ev.side)
		local tc = Content.typeColor((S.lastMoveType or "none"))
		S.fx.position = (if ev.side == 1 then S.myPos else S.foePos)
		S.fx.start_color = color(tc)
		S.fx.end_color = color(W.alpha(tc, 0))
		S.fx:burst(if (ev.eff or 1) > 1 then 30 else 16)
		flash(s, 3)
		Juice.shake(if (ev.eff or 1) > 1 or ev.crit then 14 else 7, secs(0.25))
		U.sfx(Content.config.sfx and Content.config.sfx.hit)
		refreshInfo(S, ev.side, true)
		return 0.5
	elseif t == "heal" or t == "revive" or t == "cure" or t == "status" then
		if t == "heal" then U.sfx(Content.config.sfx and Content.config.sfx.heal) end
		refreshInfo(S, ev.side or 1, true)
		local s = spr(ev.side or 1)
		if t == "status" then
			tween(s, { modulate = color("#ff9a7a") }, secs(0.15), { easing = "sine_in_out", yoyo = true })
		end
		return 0.35
	elseif t == "status_tick" then
		flash(spr(ev.side), 2)
		return 0.2
	elseif t == "faint" then
		local s = spr(ev.side)
		local home = if ev.side == 1 then S.myPos else S.foePos
		tween(s, { position = home + vec2(0, 120), modulate = color("#ffffff00") }, secs(0.45), "quad_in")
		U.sfx(Content.config.sfx and Content.config.sfx.faint)
		return 0.5
	elseif t == "xp" or t == "xp_bar" then
		if b.sides[1].active == ev.slot then refreshInfo(S, 1, true) end
		return 0.3
	elseif t == "level" then
		if b.sides[1].active == ev.slot then
			refreshInfo(S, 1, false)
			S.fx.position = S.myPos
			S.fx.start_color = color(W.theme().accent)
			S.fx:burst(24)
		end
		U.sfx(Content.config.sfx and Content.config.sfx.level)
		return 0.4
	elseif t == "throw" then
		local orb = spawn("Sprite2D", { position = S.myPos + vec2(0, -60), size = vec2(48, 48), texture = (Content.items[ev.item] or {}).icon, modulate = if (Content.items[ev.item] or {}).icon then "#ffffff" else "#e04848", z_index = 30 }, S.stage)
		S.orb = orb
		tween(orb, { position = S.foePos + vec2(0, 40) }, secs(0.45), "quad_out")
		tween(orb, { rotation = 720 }, secs(0.45), "linear")
		U.after(secs(0.45), function()
			if W.alive(S.foeSprite) then tween(S.foeSprite, { scale = vec2(0.05, 0.05) }, secs(0.2), "quad_in") end
		end)
		U.sfx(Content.config.sfx and Content.config.sfx.throw)
		return 0.75
	elseif t == "catch" then
		local orb = S.orb
		for i = 1, ev.shakes do
			U.after(secs(0.45 * (i - 1)), function()
				if W.alive(orb) then tween(orb, { rotation = 20 }, secs(0.12), { easing = "sine_in_out", yoyo = true }) end
				U.sfx(Content.config.sfx and Content.config.sfx.shake)
			end)
		end
		local dur = 0.45 * ev.shakes + 0.2
		U.after(secs(dur), function()
			if ev.success then
				if W.alive(S.fx) then
					S.fx.position = S.foePos + vec2(0, 40)
					S.fx.start_color = color(W.theme().accent)
					S.fx:burst(30)
				end
				if W.alive(orb) then orb.modulate = "#c0c0c0" end
				U.sfx(Content.config.sfx and Content.config.sfx.caught)
			else
				W.destroy(orb)
				if W.alive(S.foeSprite) then tween(S.foeSprite, { scale = vec2(1, 1) }, secs(0.25), "back_out") end
			end
		end)
		return dur + 0.3
	elseif t == "run" then
		if ev.success then U.sfx(Content.config.sfx and Content.config.sfx.run) end
		return 0.2
	end
	return 0
end

-- play events one by one: text stays up ~1s (tap / A skips), then the next
local function play(S, events, cont: () -> ())
	local i = 0
	local function nxt()
		if S.dead then return end
		i += 1
		local ev = events[i]
		if not ev then return cont() end
		if ev.t == "move" then S.lastMoveType = ev.moveType end
		local d = animate(S, ev)
		if ev.text then
			setMessage(S, ev.text)
			d = math.max(d, bcfg().text_seconds or 1.0)
		end
		if d <= 0 then return nxt() end
		local fired = false
		local function go()
			if fired then return end
			fired = true
			S.skip = nil
			nxt()
		end
		S.skip = if ev.text then function()
			-- only allow skipping after the animation part
			go()
		end else nil
		S.skipAfter = time() + secs(math.min(d, 0.35))
		U.after(secs(d), go)
	end
	nxt()
end

-- ---------------------------------------------------------------- menus

local menuMain, menuMoves, menuBag, menuTeam

local function submit(S, action)
	clearMenu(S)
	local events = S.core:submit(action)
	play(S, events, function() BT.afterTurn(S) end)
end

local function bottom(S, h: number)
	local scr = W.screen()
	return W.panel(S.ui, { anchor = "bottom", offset = vec2(0, -24 - 172), size = vec2(scr.x - 48, h), bg = "#00000000", z = 20 })
end

menuMain = function(S)
	clearMenu(S)
	local t = W.theme()
	local b = S.core
	setMessage(S, Logic.text(U.format((Content.config.text and Content.config.text.what_will) or "Pick an action for {mon}.", { mon = Creatures.name(b:active(1)) })))
	local scr = W.screen()
	local m = bottom(S, 220)
	S.menu = m
	local w = (scr.x - 48 - 20) / 2
	local labels = Content.config.text or {}
	W.button(m, { text = labels.fight or "FIGHT", anchor = "top_left", offset = vec2(0, 0), size = vec2(w, 100), bg = t.bad, font_size = 32, onPress = function() menuMoves(S) end })
	W.button(m, { text = labels.bag or "BAG", anchor = "top_right", offset = vec2(0, 0), size = vec2(w, 100), bg = t.accent, color = t.background, font_size = 32, onPress = function() menuBag(S) end })
	W.button(m, { text = labels.team or "TEAM", anchor = "bottom_left", offset = vec2(0, 0), size = vec2(w, 100), bg = t.good, font_size = 32, onPress = function() menuTeam(S, false) end })
	W.button(m, {
		text = labels.run or "RUN", anchor = "bottom_right", offset = vec2(0, 0), size = vec2(w, 100),
		bg = if b.canRun then t.primary else W.alpha(t.muted, 0.5), font_size = 32,
		onPress = function()
			if not b.canRun then
				setMessage(S, Core.T("run_trainer"))
				return
			end
			submit(S, { kind = "run" })
		end,
	})
end

menuMoves = function(S)
	clearMenu(S)
	local t = W.theme()
	local b = S.core
	local mon = b:active(1)
	local scr = W.screen()
	local m = bottom(S, 330)
	S.menu = m
	local w = (scr.x - 48 - 20) / 2
	local any = #b:usableMoves(1) > 0
	for i = 1, 4 do
		local mv = mon.moves[i]
		local col, row = (i - 1) % 2, math.floor((i - 1) / 2)
		local off = vec2(col * (w + 20), row * 116)
		if mv then
			local def = Content.moves[mv.id] or Core.STRUGGLE
			local p = W.row(m, {
				anchor = "top_left", offset = off, size = vec2(w, 104), bg = if mv.pp > 0 then Content.typeColor(def.type) else W.alpha(t.muted, 0.5), z = 2,
				onTap = function()
					if mv.pp <= 0 then
						setMessage(S, "No energy left for that move!")
						return
					end
					submit(S, { kind = "move", slot = i })
				end,
			})
			W.text(p, { text = def.name, anchor = "top_left", offset = vec2(16, 10), size = vec2(w - 32, 44), font_size = 28, outline = "#00000099", outline_size = 2 })
			W.text(p, { text = string.upper(Content.typeName(def.type)), anchor = "bottom_left", offset = vec2(16, -8), size = vec2(w / 2, 34), font_size = 18, outline = "#00000099", outline_size = 2 })
			W.text(p, { text = "PP " .. mv.pp .. "/" .. def.pp, anchor = "bottom_right", offset = vec2(-16, -8), size = vec2(w / 2, 34), font_size = 18, align = "right", outline = "#00000099", outline_size = 2 })
		else
			W.panel(m, { anchor = "top_left", offset = off, size = vec2(w, 104), bg = W.alpha(t.background, 0.5), z = 2 })
		end
	end
	if not any then
		W.button(m, { text = "FLAIL", anchor = "bottom_left", offset = vec2(0, 0), size = vec2(w, 84), bg = t.bad, onPress = function() submit(S, { kind = "move", slot = 0 }) end })
	end
	W.button(m, { text = "BACK", anchor = "bottom_right", offset = vec2(0, 0), size = vec2(w, 84), bg = W.alpha(t.muted, 0.8), color = t.background, onPress = function() menuMain(S) end })
end

-- full list overlay (bag / team): rows = { { label, sub, icon, enabled, onTap } }
local function listOverlay(S, title: string, rows, onBack: (() -> ())?)
	clearMenu(S)
	local t = W.theme()
	local scr = W.screen()
	local h = math.min(scr.y * 0.62, 150 + #rows * 112)
	local m = W.panel(S.ui, { anchor = "bottom", offset = vec2(0, -24), size = vec2(scr.x - 48, h), bg = W.alpha(t.background, 0.97), z = 40 })
	S.menu = m
	W.text(m, { text = title, anchor = "top_left", offset = vec2(24, 18), size = vec2(scr.x - 300, 44), font_size = 30, color = t.accent })
	if onBack then
		W.button(m, { text = "BACK", anchor = "top_right", offset = vec2(-16, 12), size = vec2(150, 64), bg = W.alpha(t.muted, 0.8), color = t.background, font_size = 24, onPress = onBack })
	end
	local maxRows = math.floor((h - 100) / 112)
	for i, r in rows do
		if i > maxRows then break end
		local p = W.row(m, {
			anchor = "top_left", offset = vec2(16, 88 + (i - 1) * 112), size = vec2(scr.x - 48 - 32, 100),
			bg = if r.enabled == false then W.alpha(t.surface, 0.5) else t.surface, z = 2,
			onTap = function()
				if r.enabled ~= false and r.onTap then r.onTap() end
			end,
		})
		local x = 16
		if r.icon then
			W.image(p, { image = r.icon, anchor = "left", offset = vec2(10, 0), size = vec2(80, 80) })
			x = 104
		end
		W.text(p, { text = r.label, anchor = "top_left", offset = vec2(x, 10), size = vec2(scr.x - 300, 40), font_size = 26, color = if r.enabled == false then t.muted else t.text })
		if r.sub then W.text(p, { text = r.sub, anchor = "bottom_left", offset = vec2(x, -8), size = vec2(scr.x - 200, 34), font_size = 19, color = t.muted }) end
		if r.right then W.text(p, { text = r.right, anchor = "right", offset = vec2(-20, 0), size = vec2(160, 40), font_size = 24, align = "right", color = t.accent }) end
		if r.hp then
			local bar = W.bar(p, { anchor = "top_right", offset = vec2(-20, 18), size = vec2(170, 16), value = r.hp })
			bar.color(W.hpColor(r.hp))
		end
	end
end

local BATTLE_KINDS = { heal = true, cure = true, revive = true, capture = true, battle = true }

menuBag = function(S)
	local b = S.core
	local rows = {}
	for _, e in State.bagList(function(def) return BATTLE_KINDS[def.kind] == true or def.heal ~= nil or def.revive ~= nil end) do
		local def = e.def
		table.insert(rows, {
			label = def.name, right = "×" .. e.count, icon = def.icon, sub = def.description,
			enabled = def.kind ~= "capture" or b.canCatch,
			onTap = function()
				if def.kind == "capture" then
					submit(S, { kind = "item", item = e.id })
				elseif def.boost then
					submit(S, { kind = "item", item = e.id, target = b.sides[1].active })
				else
					-- choose who gets it
					local prow = {}
					for i, mon in State.party() do
						table.insert(prow, {
							label = Creatures.name(mon), sub = "Lv" .. mon.level .. "  " .. mon.hp .. "/" .. mon.maxhp .. (if mon.status then "  " .. string.upper(mon.status) else ""),
							icon = Creatures.sprite(mon, "icon"), hp = mon.hp / math.max(1, mon.maxhp),
							onTap = function() submit(S, { kind = "item", item = e.id, target = i }) end,
						})
					end
					listOverlay(S, "Use " .. def.name .. " on?", prow, function() menuBag(S) end)
				end
			end,
		})
	end
	if #rows == 0 then table.insert(rows, { label = "Nothing useful here.", enabled = false }) end
	listOverlay(S, "BAG", rows, function() menuMain(S) end)
end

menuTeam = function(S, forced: boolean)
	local b = S.core
	local rows = {}
	for i, mon in State.party() do
		local active = i == b.sides[1].active
		table.insert(rows, {
			label = Creatures.name(mon) .. (if active then "  (out)" else ""),
			sub = "Lv" .. mon.level .. "  HP " .. mon.hp .. "/" .. mon.maxhp .. (if mon.status then "  " .. string.upper(mon.status) else ""),
			icon = Creatures.sprite(mon, "icon"), hp = mon.hp / math.max(1, mon.maxhp),
			enabled = mon.hp > 0 and not active,
			onTap = function() submit(S, { kind = "switch", slot = i }) end,
		})
	end
	listOverlay(S, if forced then "Choose the next creature" else "TEAM", rows, if forced then nil else function() menuMain(S) end)
end

-- ---------------------------------------------------------------- flow

local function teardown(S)
	S.dead = true
	clearMenu(S)
	W.destroy(S.ui)
	W.destroy(S.stage)
	W.destroy(S.cam)
	if W.alive(S.prevCam) then S.prevCam.current = true end
	camera.snap()
	BT.current = nil
end

local function askLearn(S, list, i: number, cont: () -> ())
	local item = list[i]
	if not item then return cont() end
	local mon, mv = item.mon, item.move
	local labels = {}
	for k, x in mon.moves do labels[k] = (Content.moves[x.id] or Core.STRUGGLE).name end
	table.insert(labels, "Don't learn " .. Content.move(mv).name)
	ui.choice(Creatures.name(mon) .. " can forget a move to learn " .. Content.move(mv).name .. ".", labels, function(k: number)
		if k and k <= #mon.moves then
			Creatures.learn(mon, mv, k)
			R.notify(Creatures.name(mon) .. " learned " .. Content.move(mv).name .. "!")
		end
		askLearn(S, list, i + 1, cont)
	end)
end

local function runEvolutions(S, list, i: number, cont: () -> ())
	local e = list[i]
	if not e then return cont() end
	local mon = e.mon
	local fromName = Creatures.name(mon)
	clearMenu(S)
	-- show the evolving creature front and center
	S.mySprite.texture = Creatures.sprite(mon, "front")
	S.mySprite.flip_h = false
	S.mySprite.modulate = "#ffffff"
	S.mySprite.scale = vec2(1, 1)
	if W.alive(S.foeSprite) then S.foeSprite.visible = false end
	setMessage(S, U.format((Content.config.text and Content.config.text.evolving) or "{mon} is transforming!", { mon = fromName }))
	tween(S.mySprite, { modulate = color("#ffffff30") }, secs(0.25), { easing = "sine_in_out", loop = true, yoyo = true })
	U.after(secs(1.6), function()
		local from = Creatures.evolve(mon, e.into)
		S.mySprite.texture = Creatures.sprite(mon, "front")
		tween(S.mySprite, { modulate = color("#ffffff") }, 0.01)
		S.fx.position = S.myPos
		S.fx:burst(40)
		U.sfx(Content.config.sfx and Content.config.sfx.level)
		setMessage(S, U.format((Content.config.text and Content.config.text.evolved) or "{mon} became {into}!", { mon = fromName, into = Creatures.species(mon).name }))
		Events.evolved:fire(mon, from, mon.id)
		State.markSeen(mon.id)
		local d = State.get()
		d.caught[mon.id] = true
		U.after(secs(1.4), function() runEvolutions(S, list, i + 1, cont) end)
	end)
end

function BT.afterTurn(S)
	local b = S.core
	if b.over then return BT.finish(S) end
	if b.needSwitch then
		setMessage(S, "Choose the next creature.")
		return menuTeam(S, true)
	end
	menuMain(S)
end

function BT.finish(S)
	local b = S.core
	local result = b.result
	local after = {}
	-- apply the result to the game state
	if result == "caught" and b.caught then
		local mon = b.caught
		mon.uid = nil
		mon.status = nil
		mon.sleep = nil
		local where = State.addCreature(mon)
		Events.creatureCaught:fire(mon)
		if where == "box" then table.insert(after, Creatures.name(mon) .. " was sent to storage.") end
	elseif result == "win" and b.kind == "trainer" and S.trainerId then
		State.addMoney(b.moneyWon)
		State.setFlag("beat_" .. S.trainerId, true)
		local t = Content.trainers[S.trainerId]
		for _, f in (t and t.flags) or {} do State.setFlag(f, true) end
		Events.trainerDefeated:fire(S.trainerId)
		if t and t.defeat then table.insert(after, { speaker = t.name, lines = t.defeat }) end
		if t and t.on_win then Logic.run(t.on_win) end
	end
	local function close()
		local function leave()
			-- out of the battle: fade back to the overworld
			W.fade(1, secs(0.2), function()
				teardown(S)
				if result == "lose" then BT.blackout() end
				W.fade(0, 0.25)
				Events.battleEnded:fire(b, result)
				if S.done then S.done(result) end
			end)
		end
		askLearn(S, b.pendingLearn, 1, function()
			local evo = if result == "lose" then {} else b:evolutions(Logic.check)
			runEvolutions(S, evo, 1, leave)
		end)
	end
	-- post-battle lines (trainer defeat text, storage notice) as messages in the battle box
	local i = 0
	local function nxt()
		i += 1
		local a = after[i]
		if not a then return close() end
		local lines = if type(a) == "string" then { a } else a.lines
		local j = 0
		local function line()
			j += 1
			if not lines[j] then return nxt() end
			setMessage(S, (if type(a) == "table" and a.speaker then a.speaker .. ": " else "") .. Logic.text(lines[j]))
			S.skip = line
			S.skipAfter = time() + secs(0.3)
			U.after(secs(bcfg().text_seconds and bcfg().text_seconds * 1.4 or 1.6), function() if S.skip == line then line() end end)
		end
		line()
	end
	nxt()
end

-- after losing every battle: pay a fee, heal, return to the last heal point
function BT.blackout()
	local d = State.get()
	local pct = Content.config.lose_money_percent or 25
	local lost = math.floor(d.money * pct / 100)
	State.addMoney(-lost)
	State.healAll()
	local r = d.player.respawn
	local st = Content.config.start or {}
	if r and r.map then
		R.enterMap(r.map, { x = r.x, y = r.y, facing = r.facing or "down" })
	elseif st.map then
		R.enterMap(st.map, st.spawn)
	end
	R.notify(if lost > 0 then ("You lost $" .. lost .. " and rushed back to safety.") else "You rushed back to safety.")
end

-- opts: { trainer = id } or { creature = id, level = n, can_run = bool } (+ background overrides)
function BT.start(opts, done: ((string) -> ())?)
	if Events.hooks.startBattle and Events.hooks.startBattle(opts, done) == true then return end
	if not State.firstAlive() then
		if done then done("lose") end
		return
	end
	local kind = if opts.trainer then "trainer" else "wild"
	local enemy
	local trainer
	if kind == "trainer" then
		trainer = Content.trainers[opts.trainer]
		if not trainer then error("rpg: unknown trainer \"" .. tostring(opts.trainer) .. "\" (add data/trainers/" .. tostring(opts.trainer) .. ".json)") end
		enemy = { party = trainerParty(trainer), name = trainer.name, ai = trainer.ai, items = trainer.items }
	else
		local mon = Creatures.create(opts.creature, opts.level or 3)
		enemy = { party = { mon }, ai = opts.ai or Creatures.species(mon).ai or "random" }
	end
	local core = Core.new({
		kind = kind, trainer = trainer, rng = opts.rng,
		player = { party = State.party(), name = State.get().player.name },
		enemy = enemy, bag = bagAdapter, canRun = opts.can_run,
	})
	State.markSeen(core:active(2).id)
	local S = { core = core, done = done, trainerId = opts.trainer }
	BT.current = S
	-- screen
	S.prevCam = camera.current()
	if S.prevCam then S.prevCam.current = false end
	local bg = nil
	if kind == "trainer" and trainer.battle then bg = trainer.battle end
	if kind == "wild" and opts.battle then bg = opts.battle end
	makeStage(S, bg)
	camera.snap()
	local t = W.theme()
	local scr = W.screen()
	S.ui = W.panel(nil, { anchor = "top_left", offset = vec2(0, 0), size = scr, bg = "#00000000", z = 100 })
	S.ui.tapped:connect(function()
		if S.skip and time() >= (S.skipAfter or 0) then S.skip() end
	end)
	S.foeInfo = infoPanel(S, 2)
	S.myInfo = infoPanel(S, 1)
	local box = W.panel(S.ui, { anchor = "bottom", offset = vec2(0, -24), size = vec2(scr.x - 48, 156), bg = W.alpha(t.background, 0.95), z = 30 })
	S.msg = W.text(box, { text = "", anchor = "top_left", offset = vec2(26, 18), size = vec2(scr.x - 100, 120), font_size = 28 })
	S.msgBox = box
	U.music((kind == "trainer" and (trainer.music or bcfg().trainer_music)) or bcfg().music, { fade = 0.3 })
	-- intro
	S.foeSprite.scale = vec2(0, 0)
	S.mySprite.scale = vec2(0, 0)
	refreshInfo(S, 2, false)
	refreshInfo(S, 1, false)
	W.fade(1, 0.001)
	W.fade(0, secs(0.35))
	play(S, core:intro(), function() BT.afterTurn(S) end)
	-- A/confirm skips messages
	S.tick = true
	return S
end

-- called every frame by the kit (skip messages with the A button)
function BT.update()
	local S = BT.current
	if not S or S.dead then return end
	if (input.pressed("jump") or input.pressed("action")) and S.skip and time() >= (S.skipAfter or 0) then S.skip() end
end

-- leave the battle screen music: maps restore their own on enter
return BT
