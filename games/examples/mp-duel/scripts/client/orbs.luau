--!strict
-- Orbs on this device: shown when the host announces them, claimed on touch (the host decides who was first).
local net = require("../shared/net")
local orbs: { [number]: Entity } = {}
local claimed: { [number]: boolean } = {}

net.orb:onClient(function(id: number, pos: Vec2)
	if orbs[id] then return end
	local e = spawn("Sprite2D", { position = pos, size = vec2(26, 26), color = "#ffd34a", z_index = 2 })
	e.scale = vec2(0.2, 0.2)
	tween(e, { scale = vec2(1, 1) }, 0.25, "back_out")
	orbs[id] = e
end)

net.taken:onClient(function(id: number, player: Player)
	local e = orbs[id]
	orbs[id] = nil
	if e and not e.destroyed then
		tween(e, { scale = vec2(1.8, 1.8), modulate = color("#ffffff00") }, 0.2).done:connect(function() if not e.destroyed then e:destroy() end end)
	end
	if player then
		sfx.play("pickup", { pitch = if player.isLocal then 1.2 else 0.8 })
		if room.active then ui.toast((if player.isLocal then "You" else player.name) .. " +1", 1) end
	end
end)

-- late devices ask the host for orbs they missed
after(0.3, function() net.sync:fireServer() end)

onTick(function()
	local me = players["local"].avatar
	if not me then return end
	for id, e in orbs do
		if not claimed[id] and not e.destroyed and (e.position - me.position):length() < 34 then
			claimed[id] = true
			net.grab:fireServer(id)
		end
	end
end)

-- countdown (the round start lives in the shared module, set by the rules script)
local clock = entity("clock")
onTick(function()
	if clock and not clock.destroyed then clock.text = tostring(math.max(0, math.ceil(net.TIME - (time() - (net.roundStart or 0))))) end
end)
