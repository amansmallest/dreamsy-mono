--!strict
-- Match rules. Every device runs this script, but only the room host's device acts on it (room.isHost; true when
-- playing solo): it spawns orbs, judges grabs (first claim wins), keeps the tally and calls room.finish.
local net = require("../shared/net")

local orbs: { [number]: Vec2 } = {}
local tally: { [string]: number } = {}
local nextId = 0
local over = false

local function liveCount(): number
	local n = 0
	for _ in orbs do n += 1 end
	return n
end

local function spawnOrb()
	if over or not room.isHost or liveCount() >= net.MAX_ORBS then return end
	nextId += 1
	local pos = vec2(math.random(90, 630), math.random(260, 1040))
	orbs[nextId] = pos
	net.orb:fireAll(nextId, pos)
end
after(1, spawnOrb)
every(1.2, spawnOrb)

net.sync:onServer(function(player: Player)
	for id, pos in orbs do net.orb:fireClient(player, id, pos) end
end)

net.grab:onServer(function(player: Player, id: number)
	if over or not orbs[id] then return end -- someone was faster
	orbs[id] = nil
	tally[player.id] = (tally[player.id] or 0) + 1
	room.addScore(player, 1)
	net.taken:fireAll(id, player)
	if tally[player.id] >= net.WIN then
		over = true
		room.finish(player)
	end
end)

net.roundStart = time()

-- time up: most orbs wins
onTick(function()
	if over or not room.isHost or time() - net.roundStart < net.TIME then return end
	over = true
	local best: Player? = nil
	local bestN, tie = -1, false
	for _, p in players.all() do
		local n = tally[p.id] or 0
		if n > bestN then best, bestN, tie = p, n, false elseif n == bestN then tie = true end
	end
	room.finish(if tie then "draw" else best)
end)

-- solo: there is no platform results card or rematch, so start a new round after a short pause
room.ended:connect(function(r)
	if room.active then return end
	ui.toast(if r.draw then "Draw!" else "You win! New round...", 2.5)
	after(3, function()
		tally, over = {}, false
		net.roundStart = time()
	end)
end)

players.joined:connect(function(p: Player)
	-- joined also fires for everyone already here at start; only announce late joiners
	if room.active and not p.isLocal and time() > 1 then ui.toast(p.name .. " joined (" .. tostring(p.team) .. ")", 2) end
end)
players.left:connect(function(p: Player) ui.toast(p.name .. " left", 2) end)
