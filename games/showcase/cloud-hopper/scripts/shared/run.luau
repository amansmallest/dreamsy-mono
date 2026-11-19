-- session state shared across scenes
local run = {
	level = 1,
	gems = {},
	frozen = false,
	grace = 0,
}
function run.fell() end
function run.fx(kind: string, pos: any, n: number?) end
return run
