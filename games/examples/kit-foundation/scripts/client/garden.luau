--!nonstrict
local G = require("../shared/game")
G.init()
local core, juice = G.core, G.juice
G.playing = true
juice.reveal("iris", { color = "#22333b" })

local goldText, lvlText, xpBar, questText = entity("hud_gold"), entity("hud_level"), entity("hud_xp"), entity("hud_quest")
local owl, slime, slimeHp = entity("owl"), entity("slime"), entity("slime_hp")
local busy = function() return core.menus.isOpen() or ui.dialogOpen() end

-- ---------- HUD ----------
local shownGold = core.wallet.get("gold")
goldText.text = "Gold " .. shownGold
local function refreshLevel()
	local L, _, _, frac = G.level:progress()
	lvlText.text = "Lv " .. L .. "  pts " .. G.skills.points
	xpBar.size = vec2(math.max(1, 640 * frac), 18)
end
local function refreshQuest()
	local active = core.quests.list("active")
	if #active == 0 then
		questText.text = if core.quests.isDone("slime_trouble") then "All quests done!" else "Tap the owl"
		return
	end
	local q = active[1]
	local step = core.quests.step(q.id)
	local p = core.quests.progress(q.id)[1]
	local extra = ""
	if step.id == "gather" then extra = " (" .. math.min(3, core.bag:count("apple")) .. "/3)"
	elseif p and p.target > 1 then extra = " (" .. p.count .. "/" .. p.target .. ")" end
	questText.text = q.title .. ": " .. step.text .. extra
end
refreshLevel()
refreshQuest()

core.events.onScene("currency_changed", function(d)
	if d.currency ~= "gold" then return end
	juice.rollup(goldText, shownGold, d.amount, { prefix = "Gold ", seconds = 0.5 })
	shownGold = d.amount
	juice.bounce(goldText, { amount = 0.12 })
end)
core.events.onScene("level_up", function(d)
	refreshLevel()
	juice.confetti()
	juice.sfx("level")
	core.menus.toast("Level " .. d.level .. "! +1 skill point")
end)
for _, ev in { "quest_started", "quest_step", "quest_progress", "quest_completed", "item_gained", "item_lost", "skill_unlocked" } do
	core.events.onScene(ev, function() refreshQuest() refreshLevel() end)
end
core.events.onScene("quest_completed", function() juice.confetti() end)
core.events.onScene("achievement_unlocked", function(d)
	local a = core.content.get("achievements", d.achievement)
	core.menus.toast("Achievement: " .. a.name, 2.5)
end)
-- xp bar animates on any xp change
local lastXp = G.level.xp
onTick(function()
	if G.level.xp ~= lastXp then lastXp = G.level.xp refreshLevel() end
end)

-- ---------- trees ----------
for _, tree in entitiesTagged("tree") do
	local cd = core.timers.cooldown(1.2)
	tree.tapped:connect(function()
		if busy() then return end
		cd.set(if G.skills:has("green_thumb") then 0.6 else 1.2)
		if not cd.use() then
			juice.popup("regrowing...", tree.position + vec2(0, -40), { size = 22, color = "#22333b", outline = "#f7f3e9" })
			return
		end
		local n = if G.skills:has("harvest_moon") then 2 else 1
		if core.bag:add("apple", n) == 0 then core.menus.toast("Bag is full!") return end
		core.emit("apple_picked", { count = n })
		juice.squash(tree, { amount = 0.1 })
		juice.sparkle(tree.position + vec2(0, -30), { color = "#ef476f" })
		juice.popup("+" .. n .. " apple", tree.position + vec2(0, -80), { color = "#ef476f", outline = "#ffffff" })
		juice.sfx("pick")
	end)
end

-- ---------- owl ----------
juice.float(owl, { height = 6, seconds = 1.4 })
owl.tapped:connect(function()
	if busy() then return end
	juice.squash(owl, { amount = 0.15 })
	core.emit("talked", { npc = "owl" })
	core.dialog.play("owl", { onEnd = function() refreshQuest() end })
end)

-- ---------- slime ----------
local hp, maxHp, dead = 3, 3, false
local slimeHome = slime.position
juice.pulse(slime, { amount = 0.06, seconds = 0.5 })
local function showHp() slimeHp.text = if dead then "" else hp .. "/" .. maxHp end
showHp()
slime.tapped:connect(function()
	if dead or busy() then return end
	local crit = random() < 0.2
	local dmg = G.damage() * (if crit then 2 else 1)
	hp = math.max(0, hp - dmg)
	juice.flash(slime, "#ffffff", 0.12)
	juice.squash(slime, { amount = 0.25 })
	juice.damage(dmg, slime.position + vec2(0, -120), { crit = crit })
	juice.shake(if crit then "medium" else "light")
	juice.sfx("hit")
	if hp > 0 then showHp() return end
	dead = true
	showHp()
	juice.hitstop(0.08)
	juice.shake("heavy")
	local reward = 5 + 3 * G.skills:rank("golden_touch")
	juice.coinBurst(slime.position, { n = 8, texture = "asset:coin", size = 28, collectTo = camera.screenToWorld(vec2(120, 55)),
		onArrive = function(i) if i == 1 then juice.sfx("coin") end end })
	slime.visible = false
	core.wallet.add("gold", reward)
	core.bag:add("jelly", 1)
	core.flags.add("slimes_popped")
	core.apply({ { xp = 10 } })
	core.emit("enemy_defeated", { enemy = "slime" })
	after(1.2, function()
		hp, dead = maxHp, false
		slime.position = slimeHome
		slime.visible = true
		juice.punch(slime, 0.3)
		juice.dust(slimeHome + vec2(0, 60))
		showHp()
	end)
end)

-- ---------- menus ----------
local function openBag()
	local cells = {}
	for _, it in core.bag:list() do
		table.insert(cells, { label = it.def.name, icon = it.def.icon, count = it.count, onSelect = function(_, h)
			if it.def.use then
				core.menus.confirm("Use " .. it.def.name .. "?\n" .. (it.def.description or ""), function()
					core.bag:use(it.id)
					h.close()
				end, nil, { yes = "Use", no = "Keep", pause = true })
			else
				core.menus.toast(it.def.name .. ": " .. (it.def.description or ""))
			end
		end })
	end
	if #cells == 0 then core.menus.toast("Your bag is empty") return end
	core.menus.grid({ title = "Bag  (" .. core.bag:usedSlots() .. "/" .. core.bag.slotCount .. ")", cells = cells, columns = 4, rows = 3 })
end
local function questTab(status)
	return function(p)
		local list = core.quests.list(status)
		if #list == 0 then core.menus.text(p, if status == "active" then "No active quests" else "Nothing yet", { offset = vec2(0, 30) }) return end
		for i, q in list do
			local step = core.quests.step(q.id)
			core.menus.text(p, q.title, { offset = vec2(0, 20 + (i - 1) * 130), color = "#ffd166", font_size = 32 })
			core.menus.text(p, if step then step.text else (q.description or ""), { offset = vec2(0, 64 + (i - 1) * 130), font_size = 24 })
		end
	end
end
local function openQuests()
	core.menus.tabs({ title = "Journal", tabs = {
		{ label = "Active", build = questTab("active") },
		{ label = "Done", build = questTab("done") },
		{ label = "Awards", build = function(p)
			for i, a in core.achievements.list(true) do
				core.menus.text(p, (if a.unlocked then "[x] " else "[ ] ") .. a.def.name .. " - " .. (a.def.description or ""), { offset = vec2(0, 20 + (i - 1) * 70), font_size = 26, color = if a.unlocked then "#ffd166" else "#f7f3e9" })
			end
		end },
	} })
end
local openSkills
openSkills = function()
	local items = {}
	for _, row in G.skills:list() do
		local d = row.def
		local cost = G.skills:cost(row.id)
		local costText = (cost.points or 0) .. " pt" .. (if cost.gold then " + " .. cost.gold .. "g" else "")
		local detail = if row.state == "max" then "MAX" elseif row.state == "available" then costText elseif row.state == "unaffordable" then costText else "locked"
		table.insert(items, { label = d.name .. (if (d.maxRank or 1) > 1 then " " .. row.rank .. "/" .. d.maxRank else (if row.rank > 0 then " *" else "")), detail = detail,
			disabled = row.state ~= "available", onSelect = function(_, h)
				if G.skills:unlock(row.id) then
					juice.sfx("level")
					core.menus.toast(d.name .. " unlocked!")
					h.close()
					openSkills()
				end
			end })
	end
	core.menus.list({ title = "Skills (" .. G.skills.points .. " pts)", items = items, keepOpen = true })
end
entity("btn_bag").pressed:connect(function() if not busy() then juice.bounce(entity("btn_bag")) openBag() end end)
entity("btn_quests").pressed:connect(function() if not busy() then openQuests() end end)
entity("btn_skills").pressed:connect(function() if not busy() then openSkills() end end)
entity("btn_menu").pressed:connect(function()
	if busy() then return end
	core.save.save()
	G.playing = false
	G.go(G.TITLE)
end)
