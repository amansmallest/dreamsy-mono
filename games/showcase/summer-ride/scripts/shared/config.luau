--!strict
-- All world units are VIRTUAL pixels (camera zoom 3 -> view ~427x240).
local C = {}

C.ZOOM = 3
C.CAM_Y = 120
C.HALF_W = 214 -- half view width at 1280x720
C.GROUND_Y = 184 -- wheel contact line
C.BIKE_HALF_H = 20 -- bike sprite is 48x40
C.CELL = 40
C.FIRST_X = 300
C.CRUISE = 80
C.FAST = 120
C.SLOW = 40
C.ACCEL = 87
C.BRAKE = 140
C.JUMP_V = 215
C.GRAVITY = 570
C.BUMP_TIME = 0.7
C.BUMP_SPEED = 24
C.INVULN = 1.4

C.stages = {
	{
		name = "Stage 1 - Rice Field Road",
		time = 70,
		evening = false,
		finale = false,
		layout = "pp..r...ppp...w....p.p..R...pp..w..hh...r..ppp...W...pp..r..p.p..w..ppp..",
	},
	{
		name = "Stage 2 - Evening Station",
		time = 75,
		evening = true,
		finale = true,
		layout = "p..r..pp.w..R..ppp...r.r...W..pp..w..hh..R...p.p..w.r..ppp..W...hhh..r..w..pp..R..p.p..",
	},
}

function C.totalPeaches(): number
	local n = 0
	for _, s in C.stages do
		for i = 1, #s.layout do
			local ch = string.sub(s.layout, i, i)
			if ch == "p" or ch == "h" or ch == "R" or ch == "W" then
				n += 1
			end
		end
	end
	return n
end

return C
