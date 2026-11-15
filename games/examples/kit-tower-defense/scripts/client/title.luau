-- Bramble Watch: title + level select (stars, locks, endless best).
local G = require("../shared/game")

music.play("garden")

local camp = G.campaign
local y = 540
for _, l in camp:levels() do
	local label = if l.unlocked then l.index .. ". " .. l.name else "LOCKED"
	if not l.unlocked and l.requiresStars > camp:totalStars() then
		label = "LOCKED  (" .. l.requiresStars .. " stars)"
	end
	local btn = spawn("UIButton", {
		anchor = "top", offset = vec2(0, y), size = vec2(600, 110), text = label, font_size = 38, font = "rounded",
		background = if l.unlocked then "#3a86ff" else "#40513d", color = if l.unlocked then "#ffffff" else "#a7b5a2",
	})
	for i = 1, 3 do
		spawn("UIPanel", {
			anchor = "right", offset = vec2(-20 - (3 - i) * 44, 0), size = vec2(40, 40), image = "asset:icon_star",
			background = if i <= l.stars then "#ffffff" else "#ffffff33",
		}, btn)
	end
	if l.unlocked then
		local id = l.id
		btn.pressed:connect(function()
			sfx.play("select")
			loadScene(G.SCENE[id])
		end)
	end
	y += 130
end

local endlessOn = camp:endlessUnlocked()
local eb = spawn("UIButton", {
	anchor = "top", offset = vec2(0, y + 20), size = vec2(600, 110), font_size = 38, font = "rounded",
	text = if endlessOn then "ENDLESS  (best " .. camp:endlessBest() .. ")" else "ENDLESS  (clear Old Stump)",
	background = if endlessOn then "#ef476f" else "#40513d", color = if endlessOn then "#ffffff" else "#a7b5a2",
})
if endlessOn then
	eb.pressed:connect(function()
		sfx.play("select")
		loadScene(G.SCENE.stump, { endless = true })
	end)
end

spawn("UIText", {
	anchor = "bottom", offset = vec2(0, -40), size = vec2(680, 40), font_size = 26, align = "center", color = "#ffffff",
	text = "Stars: " .. camp:totalStars() .. " / " .. (#camp:levels() * 3), outline = "#26301f", outline_size = 3,
})
