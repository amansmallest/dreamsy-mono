-- Pebble Dash obby: climb a stage (hand-authored or procgen), checkpoints, timer, race your best-run ghost.
-- Controls: joystick / arrows to move, A / space to jump (hold for higher).
local core = require("@kit/core")
local R = require("@kit/runner")
local juice = require("@kit/juice")
local G = require("../shared/game")
local config = require("../shared/config")
G.init()

local course, cam, sky = entity("course"), entity("camera_main"), entity("sky")
local hudStage, hudTime, hudInfo, msg = entity("hud_stage"), entity("hud_time"), entity("hud_info"), entity("obby_msg")
local SPR = { solid = "asset:plat", move = "asset:plat", vanish = "asset:plat", conveyor = "asset:plat", bounce = "asset:plat", spike = "asset:spike",
	checkpoint = "asset:flag", goal = "asset:goal", spinner = "asset:px", hub = "asset:px", player = "asset:runner", ghost = "asset:ghost" }

local stageId = sceneParams().stage or R.stages()[1].id
local stage = R.stage(stageId)
for i, st in R.stages() do if st.id == stageId then G.stageIndex = i end end
local o = R.obbyRun(stageId)
local view = R.view.obby(o, { root = course, sprites = SPR, tintAll = true })
local ch = R.meta.character()
if ch and ch.tint then view.player.modulate = color(ch.tint) end
local bot = {}
local done = false
local rec = R.stageRecord(stageId)
cam.follow = view.player
cam.limit_min = vec2(0, -400)
cam.limit_max = vec2(720, stage.height + 300)
camera.snap()
music.play("obby")

local function say(text: string, secs: number?)
	msg.text = text
	local mine = text
	after(secs or 1.5, function() if msg.text == mine then msg.text = "" end end)
end
say(stage.name or stageId, 1.5)

local function finishMenu(isBest: boolean)
	local m = core.menus
	local h = m.modal(620, 620, if isBest then "NEW RECORD!" else "Stage clear!", { pause = false })
	m.text(h.box, string.format("%.2f s", o.time), { offset = vec2(0, 100), size = vec2(560, 70), font_size = 60, color = "#ffd23f" })
	local best = R.stageRecord(stageId)
	m.text(h.box, string.format("Best %.2f s   ·   %d falls", best.best, o.deaths), { offset = vec2(0, 180), size = vec2(560, 50), font_size = 28 })
	local nextIdx = G.stageIndex + 1
	local stages = R.stages()
	if stages[nextIdx] then
		m.button(h.box, "Next: " .. stages[nextIdx].name, function() h.close() G.stageIndex = nextIdx loadScene("scenes/obby.scene.json", { stage = stages[nextIdx].id }) end, { anchor = "bottom", offset = vec2(0, -236), size = vec2(540, 96) })
	end
	m.button(h.box, "Retry (race ghost)", function() h.close() loadScene("scenes/obby.scene.json", { stage = stageId }) end, { anchor = "bottom", offset = vec2(0, -128), size = vec2(540, 96) })
	m.button(h.box, "Menu", function() h.close() loadScene("scenes/run.scene.json") end, { anchor = "bottom", offset = vec2(0, -20), size = vec2(540, 96), background = "#5a5470" })
end

onTick(function(dt: number)
	if done then return end
	local ax, jp, jh
	if config.bot then ax, jp, jh = R.obby.botInput(o, bot)
	else
		ax = R.controls.axis()
		jp, jh = R.controls.jump()
	end
	local ev = o:step(dt, ax, jp, jh)
	for _, e in ev do
		local n = e.name
		if n == "jump" then sfx.play("jump", { volume = 0.6 })
		elseif n == "bounce" then sfx.play("bounce") juice.squash(view.player, { amount = 0.3 })
		elseif n == "land" then juice.squash(view.player, { amount = 0.12 })
		elseif n == "crumble" then sfx.play("slide", { volume = 0.4 })
		elseif n == "death" then sfx.play("death") juice.shake("medium") juice.sparkle(vec2(e.x, e.y - 20), { color = "#ff5d5d", n = 12 })
		elseif n == "respawn" then camera.snap()
		elseif n == "checkpoint" then sfx.play("checkpoint") say("Checkpoint!", 1) juice.sparkle(vec2(o.x, o.y - 40), { color = "#59e3ff", n = 16 })
		elseif n == "finish" then
			done = true
			sfx.play("finish")
			juice.confetti()
			local isBest = R.finishStage(stageId, o)
			print(string.format("stage %s finished %.2fs deaths %d best %s", stageId, o.time, o.deaths, tostring(isBest)))
			if config.bot then
				local stages = R.stages()
				local nx = stages[G.stageIndex + 1]
				after(1, function() if nx then G.stageIndex += 1 loadScene("scenes/obby.scene.json", { stage = nx.id }) else loadScene("scenes/obby.scene.json", { stage = stageId }) end end)
			else
				after(1.2, function() finishMenu(isBest) end)
			end
		end
	end
	view.update()
	local c = camera.center()
	sky.position = c
	hudStage.text = (stage.name or stageId) .. "  " .. G.stageIndex .. "/" .. #R.stages()
	hudTime.text = string.format("%.1f", o.time)
	hudInfo.text = string.format("CP %d/%d   falls %d", o.checkpoint, #o.checkpoints, o.deaths) .. (if rec then string.format("   best %.1f", rec.best) else "")
end)
