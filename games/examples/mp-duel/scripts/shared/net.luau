--!strict
-- Remote events shared by both sides (same names everywhere).
return {
	orb = remoteEvent("orb"),     -- host → players: an orb appeared (id, position)
	sync = remoteEvent("sync"),   -- player → host: "send me the orbs already on the field"
	grab = remoteEvent("grab"),   -- player → host: I touched orb id
	taken = remoteEvent("taken"), -- host → players: orb id went to player
	WIN = 5,
	TIME = 60,
	MAX_ORBS = 3,
	roundStart = 0,
}
