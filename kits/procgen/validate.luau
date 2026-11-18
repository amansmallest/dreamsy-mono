-- Connectivity checks (BFS). validate(grid, opts) -> report
--   opts: { pass = passable (nil = not "#"/" ", set, "chars", fn), from = {x,y} (default: first passable),
--           targets = { {x,y,name?} }, requireAll = true (every passable cell reachable) }
-- report: { ok, reachable, total, regions, unreachable = { {x,y} } (max 32), missing = { target }, distances = {[name|i] = steps} , problems = { string } }
local Grid = require("./grid")

local function validate(g: any, opts: any?): any
	opts = opts or {}
	if type(g) == "string" then g = Grid.fromString(g) end
	local ok = Grid.passFn(opts.pass)
	local from = opts.from
	if from == nil then
		for y = 0, g.h - 1 do
			for x = 0, g.w - 1 do
				if from == nil and ok(g:get(x, y)) then from = { x = x, y = y } end
			end
		end
	end
	local report = { ok = true, reachable = 0, total = 0, regions = 0, unreachable = {}, missing = {}, distances = {}, problems = {} }
	for y = 0, g.h - 1 do for x = 0, g.w - 1 do if ok(g:get(x, y)) then report.total += 1 end end end
	if from == nil then
		report.ok = false
		table.insert(report.problems, "no passable cells")
		return report
	end
	local fx, fy = from.x or from[1], from.y or from[2]
	if not ok(g:get(fx, fy)) then
		report.ok = false
		table.insert(report.problems, `start ({fx},{fy}) is not passable`)
		return report
	end
	local seen, n = g:flood(fx, fy, ok)
	report.reachable = n
	report.regions = #g:regions(ok)
	for i, t in opts.targets or {} do
		local tx, ty = t.x or t[1], t.y or t[2]
		local d = seen[ty * g.w + tx]
		local name = t.name or i
		if d == nil then
			report.ok = false
			table.insert(report.missing, t)
			table.insert(report.problems, `target {name} at ({tx},{ty}) unreachable`)
		else
			report.distances[name] = d
		end
	end
	if opts.requireAll ~= false and n < report.total then
		report.ok = false
		table.insert(report.problems, `{report.total - n} passable cells unreachable ({report.regions} regions)`)
		for y = 0, g.h - 1 do
			for x = 0, g.w - 1 do
				if #report.unreachable < 32 and ok(g:get(x, y)) and seen[y * g.w + x] == nil then
					table.insert(report.unreachable, { x = x, y = y })
				end
			end
		end
	end
	return report
end

return validate
