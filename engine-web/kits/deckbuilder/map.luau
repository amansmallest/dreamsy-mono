--!nonstrict
-- Act map: rows × cols node graph from bottom (row 1) to boss (row rows+1), StS-style non-crossing paths.
-- generate({ seed|rng, rows = 12, cols = 7, paths = 6, weights?, rules? }) -> map
--   map = { rows, cols, nodes = { [id] = {id, row, col, type, next = {ids}, prev = {ids}} }, starts = {ids}, boss = id, order = {ids} }
local procgen = require("@kit/procgen")
local M = {}

M.WEIGHTS = { fight = 45, event = 22, elite = 12, rest = 12, shop = 7 }
M.RULES = { eliteFrom = 5, restFrom = 5, treasureRow = nil, restBeforeBoss = true, firstRow = "fight", noRepeat = { elite = true, rest = true, shop = true } }

local function id(r, c) return r .. "_" .. c end

function M.generate(opts)
	opts = opts or {}
	local rng = opts.rng or procgen.rng(opts.seed or 1)
	local rows, cols, paths = opts.rows or 12, opts.cols or 7, opts.paths or 6
	local rules = table.clone(M.RULES)
	for k, v in opts.rules or {} do rules[k] = v end
	rules.treasureRow = rules.treasureRow or (math.floor(rows / 2) + 1)
	local weights = opts.weights or M.WEIGHTS
	local nodes = {}
	local edges = {} -- "r_c>r_c"
	local function node(r, c)
		local k = id(r, c)
		if not nodes[k] then nodes[k] = { id = k, row = r, col = c, next = {}, prev = {} } end
		return nodes[k]
	end
	local function link(a, b)
		local key = a.id .. ">" .. b.id
		if edges[key] then return end
		edges[key] = true
		table.insert(a.next, b.id)
		table.insert(b.prev, a.id)
	end
	local startCols = {}
	for p = 1, paths do
		local c = rng:int(1, cols)
		if p == 2 then
			-- second path starts elsewhere so there are at least two starts
			local tries = 0
			while c == startCols[1] and tries < 10 do c = rng:int(1, cols) tries += 1 end
		end
		table.insert(startCols, c)
		for r = 1, rows - 1 do
			local options = {}
			for dc = -1, 1 do
				local nc = c + dc
				if nc >= 1 and nc <= cols then
					-- no crossing: moving right from c means (r,c+1)->(r+1,c) must not exist, and vice versa
					local cross = false
					if dc == 1 and edges[id(r, c + 1) .. ">" .. id(r + 1, c)] then cross = true end
					if dc == -1 and edges[id(r, c - 1) .. ">" .. id(r + 1, c)] then cross = true end
					if not cross then table.insert(options, nc) end
				end
			end
			local nc = if #options > 0 then rng:pick(options) else c
			link(node(r, c), node(r + 1, nc))
			c = nc
		end
	end
	-- boss
	local boss = { id = "boss", row = rows + 1, col = math.ceil(cols / 2), next = {}, prev = {}, type = "boss" }
	nodes.boss = boss
	for k, n in nodes do if n.row == rows then link(n, boss) end end
	-- order (row, col) for deterministic typing
	local order = {}
	for k in nodes do table.insert(order, k) end
	table.sort(order, function(a, b)
		local na, nb = nodes[a], nodes[b]
		if na.row ~= nb.row then return na.row < nb.row end
		return na.col < nb.col
	end)
	for _, k in order do
		local n = nodes[k]
		if n.type == nil then
			if n.row == 1 then n.type = rules.firstRow
			elseif rules.restBeforeBoss and n.row == rows then n.type = "rest"
			elseif n.row == rules.treasureRow then n.type = "treasure"
			else
				local t
				for _ = 1, 20 do
					t = rng:weighted(weights)
					local ok = true
					if t == "elite" and n.row < rules.eliteFrom then ok = false end
					if t == "rest" and (n.row < rules.restFrom or n.row >= rows - 1) then ok = false end
					if ok and rules.noRepeat[t] then
						for _, pid in n.prev do if nodes[pid].type == t then ok = false end end
					end
					if ok then break end
					t = nil
				end
				n.type = t or "fight"
			end
		end
	end
	local starts = {}
	for _, k in order do if nodes[k].row == 1 then table.insert(starts, k) end end
	for _, n in nodes do table.sort(n.next) end
	return { rows = rows, cols = cols, nodes = nodes, starts = starts, boss = "boss", order = order }
end

-- check(map) -> { ok, problems }: every node reachable from a start and every node reaches the boss; no crossings
function M.check(map)
	local problems = {}
	local reach = {}
	local queue = {}
	for _, s in map.starts do reach[s] = true table.insert(queue, s) end
	while #queue > 0 do
		local k = table.remove(queue, 1)
		for _, n in map.nodes[k].next do if not reach[n] then reach[n] = true table.insert(queue, n) end end
	end
	local toBoss = { [map.boss] = true }
	queue = { map.boss }
	while #queue > 0 do
		local k = table.remove(queue, 1)
		for _, p in map.nodes[k].prev do if not toBoss[p] then toBoss[p] = true table.insert(queue, p) end end
	end
	for k, n in map.nodes do
		if not reach[k] then table.insert(problems, "unreachable " .. k) end
		if not toBoss[k] then table.insert(problems, "dead end " .. k) end
		for _, nx in n.next do
			local m = map.nodes[nx]
			if m.row ~= n.row + 1 then table.insert(problems, "skip " .. k .. ">" .. nx) end
			if m.type ~= "boss" and math.abs(m.col - n.col) > 1 then table.insert(problems, "wide " .. k .. ">" .. nx) end
			-- crossing
			if m.type ~= "boss" and m.col ~= n.col then
				local other = map.nodes[n.row .. "_" .. m.col]
				if other and table.find(other.next, n.row + 1 .. "_" .. n.col) then table.insert(problems, "cross " .. k .. ">" .. nx) end
			end
		end
	end
	table.sort(problems)
	return { ok = #problems == 0, problems = problems }
end

return M
