--!nonstrict
-- Portrait (720×1280) reading UI for the story kit: backgrounds, character sprites, CGs, text box with typewriter,
-- choices, backlog, auto/skip, save/load slots, gallery, journal (clues + affection), point-and-click rooms,
-- deduction boards, chapter + ending cards. Built on core.menus (modals/lists) + juice (typewriter, bounce, shake, sfx).
-- Call UI.play(Story, opts) (= Story.play(opts)) from a scene script; everything it spawns dies with the scene.
local Core = require("@kit/core")
local juice = require("@kit/juice")
local VM = require("./vm")
local X = require("./explore")

local UI = {}
local W, H = 720, 1280
local BOX_Y, BOX_H = 930, 310

local function theme() return Core.menus.theme() end
local function fontOf() local t = theme() return if t.font and t.font ~= "default" then t.font else nil end

local function panel(parent, props)
	local p = { anchor = "top_left", size = vec2(100, 100), background = "#00000000" }
	for k, v in props do p[k] = v end
	return spawn("UIPanel", p, parent)
end
local function text(parent, s, props)
	local p = { anchor = "top_left", size = vec2(300, 40), font_size = 28, color = theme().text, text = s or "", font = fontOf() }
	for k, v in props do p[k] = v end
	return spawn("UIText", p, parent)
end
local function button(parent, label, onPress, props)
	local t = theme()
	local p = { anchor = "top_left", size = vec2(200, 96), text = label, font_size = 30, color = t.text, background = t.primary, font = fontOf() }
	for k, v in props do p[k] = v end
	local b = spawn("UIButton", p, parent)
	if onPress then b.pressed:connect(function() juice.sfx(UI.sfx.tap) onPress(b) end) end
	return b
end
UI.panel, UI.text, UI.button = panel, text, button
UI.sfx = { tap = "tap", choice = "choice", clue = "clue", item = "item", ending = "ending", wrong = "wrong", right = "right", text = nil }

local function alive(e) return e ~= nil and not e.destroyed end
local function kill(e) if alive(e) then e:destroy() end end

-- play(Story, opts) -> view
--  opts: { start? (label), resume? (slot to load), continue? (keep the VM's current state), cps? (45), autoDelay? (1.4 s), onEnd?(ending, view) (default: ending card),
--          onTitle?() (ending card "Title" button; default restart the scene), labels? (true: name tags under hotspots),
--          menu? (true: Menu button), charSize? {w, h} (360×620) }
function UI.play(Story, opts)
	opts = opts or {}
	local vm = Story.vm
	local cfg = Story.story.cfg
	local uicfg = cfg.ui or {}
	local t = theme()
	local cps = opts.cps or uicfg.cps or 45
	local view = { mode = "read", auto = false, skip = false }
	local charSize = opts.charSize or uicfg.charSize or { 320, 550 }

	-- ---------- layers ----------
	local bg = panel(nil, { size = vec2(W, H), background = "#101018", z_index = 1 })
	local charLayer = panel(nil, { size = vec2(W, H), z_index = 10, input_transparent = true })
	local cg = panel(nil, { size = vec2(W, H), background = "#000000", z_index = 40, visible = false })
	local roomLayer = panel(nil, { size = vec2(W, H), z_index = 45, input_transparent = true })
	local catcher = panel(nil, { size = vec2(W, H), z_index = 55 })
	local box = panel(nil, { offset = vec2(16, BOX_Y), size = vec2(W - 32, BOX_H), background = t.background .. "f0", z_index = 60, input_transparent = true })
	local namePlate = panel(nil, { offset = vec2(36, BOX_Y - 34), size = vec2(250, 60), background = t.primary, z_index = 62, input_transparent = true, visible = false })
	local nameText = text(namePlate, "", { size = vec2(250, 60), font_size = 30, align = "center", z_index = 63, color = "#ffffff" })
	local body = text(box, "", { offset = vec2(28, 40), size = vec2(W - 32 - 56, BOX_H - 80), font_size = 32, z_index = 61 })
	local more = text(box, "▼", { offset = vec2(W - 32 - 60, BOX_H - 54), size = vec2(40, 40), font_size = 26, color = t.accent, z_index = 61, visible = false })
	local choiceLayer = panel(nil, { size = vec2(W, H), z_index = 70, input_transparent = true })
	local fade = panel(nil, { size = vec2(W, H), background = "#00000000", z_index = 85, input_transparent = true })
	local top = panel(nil, { size = vec2(W, 100), z_index = 90, input_transparent = true })
	local overlay = panel(nil, { size = vec2(W, H), z_index = 95, input_transparent = true })
	view.layers = { bg = bg, chars = charLayer, cg = cg, room = roomLayer, box = box, body = body, catcher = catcher, choices = choiceLayer, top = top }

	local typing = nil
	local autoTimer = nil
	local chars = {} -- id -> { e, expr, pos }
	local shownBg = nil

	-- ---------- top bar ----------
	local function topBtn(i, label, fn)
		return button(top, label, fn, { offset = vec2(16 + (i - 1) * 122, 18), size = vec2(112, 64), font_size = 24, background = t.background .. "cc", z_index = 91 })
	end
	local autoBtn, skipBtn
	local function refreshTop()
		autoBtn.background = if view.auto then t.accent else t.background .. "cc"
		autoBtn.color = if view.auto then t.background else t.text
		skipBtn.background = if view.skip then t.accent else t.background .. "cc"
		skipBtn.color = if view.skip then t.background else t.text
	end

	-- ---------- stage sync ----------
	local function setBg(id, transition)
		if id == shownBg then return end
		shownBg = id
		local img = Story.bgImage(id)
		if img and string.sub(img, 1, 1) == "#" then bg.image = "" bg.background = img
		else bg.background = "#101018" bg.image = img or "" end
		if transition and transition ~= "none" and not view.skip then
			fade.background = "#000000ff"
			tween(fade, { background = color("#00000000") }, 0.45, "quad_out")
		end
	end
	local function charProps(id, st)
		local d = Story.story.characters[id] or {}
		local size = d.size or charSize
		local x = VM.POSITIONS[st.pos] or 360
		return vec2(x - size[1] / 2, BOX_Y + 40 - size[2]), vec2(size[1], size[2])
	end
	local function syncChars()
		local stage = vm.stage
		for id, c in chars do
			if stage.chars[id] == nil or view.mode ~= "read" then kill(c.e) chars[id] = nil end
		end
		if view.mode ~= "read" then return end
		for id, st in stage.chars do
			local off, size = charProps(id, st)
			local img = Story.charImage(id, st.expr)
			local c = chars[id]
			if c == nil then
				local e = panel(charLayer, { offset = off + vec2(0, 30), size = size, image = img, z_index = 11 + (st.order or 0) % 20, input_transparent = true })
				tween(e, { offset = off }, 0.25, "quad_out")
				chars[id] = { e = e, expr = st.expr, pos = st.pos }
			else
				if c.expr ~= st.expr then c.e.image = img c.expr = st.expr juice.bounce(c.e, { amount = 0.04, seconds = 0.2 }) end
				if c.pos ~= st.pos then tween(c.e, { offset = off }, 0.3, "quad_in_out") c.pos = st.pos end
			end
		end
	end
	local function syncStage()
		local stage = vm.stage
		if view.mode == "read" then setBg(stage.bg, nil) end
		if stage.cg then cg.visible = true cg.image = Story.cgImage(stage.cg) or "" else cg.visible = false end
		syncChars()
	end
	view.syncStage = syncStage

	-- ---------- fx ----------
	local function caption(s, color)
		local tt = text(overlay, s, { anchor = "top", offset = vec2(0, 120), size = vec2(600, 64), font_size = 28, align = "center", color = color or t.accent,
			outline = "#000000", outline_size = 3, z_index = 96 })
		juice.bounce(tt, { amount = 0.15 })
		after(1.8, function() kill(tt) end)
	end
	view.caption = caption
	local function chapterCard(title, index)
		local p = panel(overlay, { size = vec2(W, H), background = "#000000cc", z_index = 97 })
		text(p, "Chapter " .. tostring(index), { offset = vec2(0, 520), size = vec2(W, 50), align = "center", font_size = 30, color = t.accent, z_index = 98 })
		local tt = text(p, title, { offset = vec2(40, 580), size = vec2(W - 80, 120), align = "center", font_size = 52, z_index = 98 })
		juice.bounce(tt, { amount = 0.08 })
		p.tapped:connect(function() kill(p) end)
		after(if view.skip then 0.3 else 1.8, function() kill(p) end)
	end
	local function runFx()
		for _, f in vm:drainFx() do
			local k = f.kind
			if k == "bg" then if view.mode == "read" then setBg(f.bg, f.transition) end
			elseif k == "sfx" then juice.sfx(f.sfx)
			elseif k == "music" then if type(music) == "table" then if f.music then music.play(f.music, { fade = 1 }) else music.stop(1) end end
			elseif k == "shake" then juice.shake(tonumber(f.amount) or f.amount)
			elseif k == "flash" then fade.background = color(f.color .. "ff") tween(fade, { background = color("#ffffff00") }, 0.35)
			elseif k == "chapter" then chapterCard(f.title, f.index)
			elseif k == "clue" then caption("Clue: " .. f.name) juice.sfx(UI.sfx.clue)
			elseif k == "item" then
				local d = Core.content.get("items", f.item)
				caption("Got " .. ((d and d.name) or f.item)) juice.sfx(UI.sfx.item)
			elseif k == "affection" then
				local d = Story.story.characters[f.character] or {}
				caption((d.name or f.character) .. (if f.delta > 0 then " ♥ +" .. f.delta else " ♥ " .. f.delta), if f.delta > 0 then "#ff8fb1" else "#9aa4b8")
			elseif k == "toast" then caption(f.text)
			elseif k == "cg" then if not view.skip then fade.background = "#000000ff" tween(fade, { background = color("#00000000") }, 0.6) end
			end
		end
	end

	-- ---------- reading ----------
	local advance
	local function clearChoices() for _, c in choiceLayer:children() do c:destroy() end end
	local function stopAuto() if autoTimer then autoTimer:cancel() autoTimer = nil end end
	local function scheduleAuto(n)
		stopAuto()
		if view.skip then autoTimer = every(0.06, function() stopAuto() advance() end) return end
		if view.auto then
			local delay = (opts.autoDelay or uicfg.autoDelay or 1.4) + n * 0.025
			autoTimer = every(delay, function() stopAuto() advance() end)
		end
	end
	local function fitBody(s)
		-- UIText centers vertically: size the rect to the text so lines start at the top of the box
		local lines = 0
		for para in string.gmatch(s .. "\n", "([^\n]*)\n") do lines += math.max(1, math.ceil((utf8.len(para) or #para) / 36)) end
		lines = math.min(math.ceil(lines), 6)
		body.size = vec2(W - 32 - 56, lines * 40 + 8)
	end
	local function showLine(ev)
		fitBody(ev.text)
		box.visible = true
		catcher.visible = true
		more.visible = false
		if ev.speaker then
			namePlate.visible = true
			nameText.text = ev.speaker
			namePlate.background = ev.color or t.primary
			body.color = t.text
		else
			namePlate.visible = false
			body.color = uicfg.narration or "#d8d4e8"
		end
		-- the speaking character pops a little
		if ev.char and chars[ev.char] then juice.bounce(chars[ev.char].e, { amount = 0.025, seconds = 0.18 }) end
		if view.skip then
			body.text = ev.text
			more.visible = true
			scheduleAuto(0)
			return
		end
		typing = juice.typewriter(body, ev.text, { cps = cps, sfx = UI.sfx.text, onDone = function()
			typing = nil
			more.visible = true
			scheduleAuto(#ev.text)
		end })
	end

	local function showChoices(ev)
		view.skip = false
		refreshTop()
		catcher.visible = false
		more.visible = false
		clearChoices()
		local n = #ev.options
		local bh, gap = 96, 18
		local y0 = BOX_Y - 40 - n * (bh + gap)
		for i, o in ev.options do
			local label = if o.locked then "🔒 " .. o.text .. (if o.hint then "  (" .. o.hint .. ")" else "") else o.text
			local b = button(choiceLayer, label, function()
				if o.locked then juice.sfx(UI.sfx.wrong) caption(o.hint or "Locked") return end
				juice.sfx(UI.sfx.choice)
				clearChoices()
				Story.choose(i)
				advance()
			end, { offset = vec2(60, y0 + (i - 1) * (bh + gap)), size = vec2(W - 120, bh), font_size = 28, z_index = 71,
				background = if o.locked then t.background .. "dd" else t.primary, color = if o.locked then "#9a96a8" else t.text })
			b.scale = vec2(0.9, 0.9)
			tween(b, { scale = vec2(1, 1) }, 0.18 + i * 0.04, "back_out")
		end
	end

	-- ---------- rooms ----------
	local selected = nil
	local roomMsg = nil
	local function roomSay(lines, after_)
		if roomMsg then kill(roomMsg) end
		if lines == nil or #lines == 0 then return end
		local p = panel(roomLayer, { offset = vec2(16, 860), size = vec2(W - 32, 220), background = t.background .. "f0", z_index = 66 })
		local i = 1
		local tt = text(p, lines[1], { offset = vec2(24, 20), size = vec2(W - 80, 180), font_size = 30, z_index = 67 })
		roomMsg = p
		p.tapped:connect(function()
			i += 1
			if lines[i] then tt.text = lines[i] else kill(p) roomMsg = nil if after_ then after_() end end
		end)
	end
	local buildRoom
	local function itemName(id) local d = Core.content.get("items", id) return (d and d.name) or id end
	local function roomResult(res)
		if res.jump or res.call then
			roomSay(res.lines, function() advance() end)
			if #res.lines == 0 then advance() end
			return
		end
		if res.used then selected = nil end
		juice.sfx(if res.ok then UI.sfx.tap else UI.sfx.wrong)
		buildRoom()
		roomSay(res.lines)
	end
	buildRoom = function()
		for _, c in roomLayer:children() do if c ~= roomMsg then c:destroy() end end
		local room = Story.room()
		local def = room.def
		setBg(def.background or vm.stage.bg, nil)
		local tag = panel(roomLayer, { offset = vec2(16, 104), size = vec2(360, 56), background = t.background .. "cc", z_index = 50 })
		text(tag, def.name or room.id, { offset = vec2(16, 0), size = vec2(330, 56), font_size = 26, color = t.accent, z_index = 51 })
		if def.hint then text(roomLayer, def.hint, { offset = vec2(16, 166), size = vec2(560, 40), font_size = 22, z_index = 51, outline = "#000000", outline_size = 3 }) end
		for _, h in room:hotspots() do
			local r = h.rect
			local hp = panel(roomLayer, { offset = vec2(r[1], r[2]), size = vec2(r[3], r[4]), image = h.sprite or "", background = "#00000000", z_index = 47 })
			hp.tapped:connect(function()
				if roomMsg then return end
				local res = Story.tap(h.id, selected)
				if res.ok and h.sprite then juice.bounce(hp, { amount = 0.06 }) end
				roomResult(res)
			end)
			if opts.labels ~= false and def.labels ~= false then
				local lbl = text(roomLayer, h.name or h.id, { offset = vec2(r[1] + r[3] / 2 - 110, r[2] + r[4] - 6), size = vec2(220, 34), font_size = 20, align = "center",
					color = if h.go then t.accent else "#ffffffdd", outline = "#000000", outline_size = 3, z_index = 48 })
				lbl.input_transparent = true
			end
		end
		-- inventory bar
		local bar = panel(roomLayer, { offset = vec2(0, 1100), size = vec2(W, 180), background = t.background .. "e6", z_index = 64 })
		local items = Core.bag:list()
		text(bar, if selected then "Use " .. itemName(selected) .. " on…" elseif #items > 0 then "Tap an item to use it" else "Inventory is empty", { offset = vec2(20, 6), size = vec2(680, 34), font_size = 22, color = "#c9c4da", z_index = 65 })
		for i, it in items do
			if i > 6 then break end
			local def_ = it.def or {}
			local isSel = selected == it.id
			local b = button(bar, if def_.icon then "" else (def_.name or it.id), function()
				if roomMsg then return end
				if selected and selected ~= it.id then
					local res = Story.combine(selected, it.id)
					selected = nil
					juice.sfx(if res.ok then UI.sfx.right else UI.sfx.wrong)
					buildRoom()
					roomSay(res.lines)
				elseif selected == it.id then
					selected = nil
					buildRoom()
					roomSay({ (def_.name or it.id) .. (if def_.description then ": " .. def_.description else "") })
				else
					selected = it.id
					buildRoom()
				end
			end, { offset = vec2(16 + (i - 1) * 116, 44), size = vec2(104, 104), icon = def_.icon, icon_size = 72, font_size = 18, z_index = 65,
				background = if isSel then t.accent else t.primary .. "aa" })
			if isSel then juice.pulse(b, { amount = 0.05, seconds = 0.6 }) end
		end
	end

	-- ---------- boards ----------
	local buildBoard
	local pick = nil
	buildBoard = function(msg)
		for _, c in roomLayer:children() do c:destroy() end
		local b = Story.board()
		local def = b.def
		local dim = panel(roomLayer, { size = vec2(W, H), background = "#0b0a12e6", z_index = 46 })
		text(dim, def.title or "Deduction", { offset = vec2(24, 108), size = vec2(560, 60), font_size = 38, color = t.accent, z_index = 47 })
		text(dim, def.prompt or "Connect two clues that explain each other.", { offset = vec2(24, 168), size = vec2(672, 70), font_size = 24, color = "#c9c4da", z_index = 47 })
		local status = b:status()
		local max = def.mistakes
		text(dim, "Links " .. #b:found() .. "/" .. #b:need() .. (if max then "     Mistakes " .. b.st.mistakes .. "/" .. max else ""), { offset = vec2(24, 238), size = vec2(672, 40), font_size = 24, z_index = 47 })
		if status == "question" then
			local q = def.question
			text(dim, q.text, { offset = vec2(40, 330), size = vec2(640, 110), font_size = 36, align = "center", z_index = 47 })
			for i, o in q.options do
				button(dim, o.text, function()
					local res = Story.answer(i)
					if res.ok or res.failed then juice.sfx(if res.ok then UI.sfx.right else UI.sfx.wrong) advance() return end
					juice.sfx(UI.sfx.wrong) juice.shake("light")
					buildBoard("That doesn't fit the facts.")
				end, { offset = vec2(60, 470 + (i - 1) * 116), size = vec2(600, 96), z_index = 48 })
			end
		else
			local clues = b:clues()
			for i, id in clues do
				local d = Story.story.clues[id] or {}
				local col, row = (i - 1) % 2, (i - 1) // 2
				local isPick = pick == id
				local card = button(dim, d.name or id, function()
					if pick == nil then pick = id buildBoard() return end
					if pick == id then pick = nil buildBoard() return end
					local a = pick
					pick = nil
					local res = Story.connect(a, id)
					if res.solved or res.failed then juice.sfx(if res.solved then UI.sfx.right else UI.sfx.wrong) advance() return end
					if res.ok then
						juice.sfx(UI.sfx.right)
						buildBoard(if res.again then "Already linked." else res.link.text)
					else
						juice.sfx(UI.sfx.wrong) juice.shake("light")
						buildBoard("Those don't connect.")
					end
				end, { offset = vec2(24 + col * 342, 300 + row * 124), size = vec2(330, 110), font_size = 26, z_index = 48, icon = d.icon, icon_size = 56,
					background = if isPick then t.accent else t.primary, color = if isPick then t.background else t.text })
				if isPick then juice.pulse(card, { amount = 0.04, seconds = 0.5 }) end
			end
			local y = 300 + math.ceil(#clues / 2) * 124 + 20
			text(dim, "Conclusions", { offset = vec2(24, y), size = vec2(400, 44), font_size = 28, color = t.accent, z_index = 47 })
			for i, l in b:found() do
				text(dim, "• " .. l.text, { offset = vec2(24, y + 44 + (i - 1) * 64), size = vec2(672, 60), font_size = 24, z_index = 47 })
			end
		end
		if msg then
			local m = text(dim, msg, { offset = vec2(24, 1150), size = vec2(672, 90), font_size = 28, align = "center", color = t.accent, outline = "#000000", outline_size = 3, z_index = 49 })
			juice.bounce(m, { amount = 0.1 })
		end
	end

	-- ---------- endings ----------
	local function endingCard(ending)
		juice.sfx(UI.sfx.ending)
		local p = panel(overlay, { size = vec2(W, H), background = "#05040acc", z_index = 97 })
		text(p, "ENDING", { offset = vec2(0, 430), size = vec2(W, 50), align = "center", font_size = 30, color = t.accent, z_index = 98 })
		local tt = text(p, ending.title or ending.id, { offset = vec2(40, 490), size = vec2(W - 80, 130), align = "center", font_size = 56, z_index = 98 })
		juice.bounce(tt, { amount = 0.1 })
		if ending.text then text(p, ending.text, { offset = vec2(60, 640), size = vec2(W - 120, 160), align = "center", font_size = 26, color = "#d8d4e8", z_index = 98 }) end
		local seen = 0
		local all = Story.endings()
		for _, e in all do if e.seen then seen += 1 end end
		text(p, "Endings found " .. seen .. "/" .. #all, { offset = vec2(0, 820), size = vec2(W, 40), align = "center", font_size = 24, z_index = 98 })
		button(p, "Gallery", function() UI.gallery(Story) end, { offset = vec2(60, 900), size = vec2(290, 96), z_index = 99 })
		button(p, "Title", function()
			if opts.onTitle then opts.onTitle() else loadScene(currentScene()) end
		end, { offset = vec2(370, 900), size = vec2(290, 96), z_index = 99 })
	end

	-- ---------- driver ----------
	advance = function()
		stopAuto()
		if typing then typing.skip() return end
		local ev = Story.step()
		runFx()
		local prevMode = view.mode
		view.mode = if ev.kind == "explore" then "room" elseif ev.kind == "deduce" then "board" else "read"
		if prevMode ~= view.mode then for _, c in roomLayer:children() do c:destroy() end roomMsg = nil end
		syncStage()
		clearChoices()
		view.event = ev
		if ev.kind == "say" then
			showLine(ev)
		elseif ev.kind == "choice" then
			if #(vm.backlog) > 0 and body.text == "" then body.text = vm.backlog[#vm.backlog].text end
			showChoices(ev)
		elseif ev.kind == "wait" then
			catcher.visible = false
			after(if view.skip then 0.05 else ev.seconds, advance)
		elseif ev.kind == "explore" then
			view.skip = false refreshTop()
			box.visible, namePlate.visible, catcher.visible = false, false, false
			buildRoom()
		elseif ev.kind == "deduce" then
			view.skip = false refreshTop()
			box.visible, namePlate.visible, catcher.visible = false, false, false
			buildBoard()
		elseif ev.kind == "end" or ev.kind == "done" then
			view.skip, view.auto = false, false refreshTop()
			catcher.visible = false
			local ending = ev.ending or { id = "end", title = cfg.theEnd or "The End" }
			if opts.onEnd then opts.onEnd(ending, view) else endingCard(ending) end
		end
	end
	view.advance = advance

	catcher.tapped:connect(function() 
		if view.skip then view.skip = false refreshTop() end
		advance()
	end)

	autoBtn = topBtn(2, "Auto", function() view.auto = not view.auto view.skip = false refreshTop() if view.auto and typing == nil and view.event and view.event.kind == "say" then scheduleAuto(0) end end)
	skipBtn = topBtn(3, "Skip", function()
		view.skip = not view.skip
		refreshTop()
		if view.skip and view.event and view.event.kind == "say" then advance() end
	end)
	topBtn(1, "Log", function() UI.backlog(Story) end)
	if opts.menu ~= false then
		topBtn(4, "Menu", function() UI.menu(Story, view) end)
	end
	refreshTop()

	-- reload the whole view from VM state (after Story.load)
	function view.reload()
		stopAuto()
		if typing then typing.cancel() typing = nil end
		for _, c in chars do kill(c.e) end
		chars = {}
		shownBg = nil
		view.mode = "read"
		for _, c in roomLayer:children() do c:destroy() end
		vm:drainFx()
		setBg(vm.stage.bg, nil)
		advance()
	end

	-- start
	if opts.resume and Story.load(opts.resume) then
		view.reload()
	elseif opts.continue and vm.started then
		view.reload()
	else
		Story.start(opts.start)
		advance()
	end
	UI.current = view
	return view
end

-- ---------- modals ----------
function UI.backlog(Story)
	local t = theme()
	local h = Core.menus.modal(680, 1120, "Backlog", { tapOutside = true })
	local list = panel(h.box, { anchor = "top", offset = vec2(0, 96), size = vec2(640, 870), scroll = true, background = "#00000000", z_index = 902 })
	local log = Story.backlog()
	local from = math.max(1, #log - 80)
	for i = from, #log do
		local e = log[i]
		local s = if e.kind == "choice" then "➤ " .. e.text elseif e.speaker then e.speaker .. ": " .. e.text else e.text
		local lines = math.max(1, math.ceil(#s / 34))
		text(list, s, { size = vec2(620, lines * 36 + 18), font_size = 26, z_index = 903, color = if e.kind == "choice" then t.accent elseif e.speaker then t.text else "#c9c4da" })
	end
	button(h.box, "Close", function() h.close() end, { anchor = "bottom", offset = vec2(0, -16), size = vec2(600, 96), z_index = 903, background = t.disabled })
	return h
end

function UI.slots(Story, mode, view)
	local items = {}
	for _, s in Story.slots(3) do
		local label = "Slot " .. s.slot .. (if s.exists then " — " .. tostring(s.chapter or "") else " — empty")
		table.insert(items, { label = label, disabled = mode == "load" and not s.exists, onSelect = function()
			if mode == "save" then
				Story.save(s.slot)
				Core.menus.toast("Saved to slot " .. s.slot)
			else
				Story.load(s.slot)
				if view and view.reload then view.reload() end
			end
		end })
	end
	if mode == "load" and Story.hasSave("auto") then
		table.insert(items, 1, { label = "Autosave", onSelect = function() Story.load("auto") if view and view.reload then view.reload() end end })
	end
	return Core.menus.list({ title = if mode == "save" then "Save" else "Load", items = items })
end

function UI.journal(Story)
	local items = {}
	for _, c in Story.clues() do table.insert(items, { label = c.name, detail = nil, onSelect = function() Core.menus.toast(c.text ~= "" and c.text or c.name, 3) end }) end
	for id, d in Story.story.characters do
		if d.affection then
			local v = Story.affection(id)
			local max = (type(d.affection) == "table" and d.affection.max) or 10
			local hearts = string.rep("♥", math.clamp(math.floor(v / max * 5 + 0.5), 0, 5)) .. string.rep("♡", 5 - math.clamp(math.floor(v / max * 5 + 0.5), 0, 5))
			table.insert(items, { label = (d.name or id) .. "  " .. hearts, disabled = true })
		end
	end
	if #items == 0 then table.insert(items, { label = "Nothing yet", disabled = true }) end
	return Core.menus.list({ title = "Journal", items = items, keepOpen = true })
end

function UI.gallery(Story)
	local items = {}
	for _, e in Story.endings() do
		local d = e.def or {}
		table.insert(items, { label = if e.seen then "Ending: " .. (d.title or e.id) else "Ending: ???", disabled = not e.seen,
			onSelect = function() Core.menus.toast(d.text or d.title or e.id, 3) end })
	end
	for _, c in Story.cgs() do
		local d = c.def or {}
		table.insert(items, { label = if c.seen then "Picture: " .. (d.title or c.id) else "Picture: ???", disabled = not c.seen, onSelect = function()
			local p = panel(nil, { size = vec2(W, H), background = "#000000", image = Story.cgImage(c.id), z_index = 1200 })
			p.tapped:connect(function() p:destroy() end)
		end })
	end
	return Core.menus.list({ title = "Gallery", items = items, keepOpen = true })
end

function UI.menu(Story, view)
	return Core.menus.list({ title = "Menu", items = {
		{ label = "Save", onSelect = function() UI.slots(Story, "save", view) end },
		{ label = "Load", onSelect = function() UI.slots(Story, "load", view) end },
		{ label = "Journal", onSelect = function() UI.journal(Story) end },
		{ label = "Gallery", onSelect = function() UI.gallery(Story) end },
	} })
end

-- title(Story, { title, subtitle?, background? (bg id/asset), music?, onStart(resumeSlot?) }) — title screen with New / Continue / Gallery
function UI.title(Story, opts)
	local t = theme()
	local root = panel(nil, { size = vec2(W, H), background = "#101018", image = Story.bgImage(opts.background) or "", z_index = 1 })
	panel(root, { size = vec2(W, H), background = "#00000055", z_index = 2 })
	local tt = text(root, opts.title or Story.story.cfg.title or "Story", { offset = vec2(40, 300), size = vec2(W - 80, 180), font_size = 72, align = "center", color = t.accent,
		outline = "#000000", outline_size = 4, z_index = 3 })
	juice.float(tt, { height = 6, seconds = 2.4 })
	if opts.subtitle then text(root, opts.subtitle, { offset = vec2(60, 480), size = vec2(W - 120, 90), font_size = 28, align = "center", z_index = 3, outline = "#000000", outline_size = 3 }) end
	if opts.music and type(music) == "table" then music.play(opts.music) end
	local y = 700
	button(root, "New Game", function() root:destroy() opts.onStart(nil) end, { offset = vec2(110, y), size = vec2(500, 104), font_size = 34, z_index = 4 })
	local canContinue = Story.hasSave("auto")
	button(root, "Continue", function() if canContinue then root:destroy() opts.onStart("auto") end end, { offset = vec2(110, y + 124), size = vec2(500, 104), font_size = 34, z_index = 4,
		background = if canContinue then t.primary else t.disabled })
	button(root, "Gallery", function() UI.gallery(Story) end, { offset = vec2(110, y + 248), size = vec2(500, 104), font_size = 34, z_index = 4, background = t.background .. "dd" })
	local seen, all = 0, Story.endings()
	for _, e in all do if e.seen then seen += 1 end end
	if #all > 0 then text(root, "Endings " .. seen .. "/" .. #all, { offset = vec2(0, 1120), size = vec2(W, 40), align = "center", font_size = 24, z_index = 3 }) end
	return root
end

return UI
