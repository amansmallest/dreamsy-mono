-- ai kit: data-driven enemy behaviours, FSM/utility/boss brains, steering, A*, line of sight. See KIT.md.
local Path = require("./path")
local Brain = require("./brain")

local AI = {}
AI.VERSION = "0.1.0"
AI.grid = Path.grid
AI.graphPath = Path.graph
AI.steer = require("./steer")
AI.behaviors = require("./behaviors")
AI.brain = Brain.new

local function alive(e) return isEntity(e) and not e.destroyed end
AI.alive = alive

local function posOf(t)
	if t == nil then return nil end
	if type(t) == "function" then t = t() if t == nil then return nil end end
	if not isEntity(t) then return if type(t) == "table" and t.x ~= nil then t else nil end
	if t.destroyed then return nil end
	local p = t.position
	local vx, vy = 0, 0
	if t.type == "Body2D" then local v = t.velocity vx, vy = v.x, v.y end
	return { x = p.x, y = p.y, vx = vx, vy = vy, entity = t }
end

-- pure step for agents without physics: { x, y, vx, vy, home?, hp?, maxHp?, radius? }.
-- Moves with grid collision (axis-separated, against `world.grid` solid cells). Returns actions emitted.
function AI.step(brain: any, agent: any, world: any?, dt: number): { any }
	world = world or {}
	local actions = {}
	agent.home = agent.home or { x = agent.x, y = agent.y }
	local ctx = {
		dt = dt, x = agent.x, y = agent.y, vx = agent.vx or 0, vy = agent.vy or 0, onFloor = agent.onFloor,
		target = posOf(world.target), home = agent.home, grid = world.grid, rand = world.rand or math.random,
		hp = agent.hp, maxHp = agent.maxHp, mode = world.mode or agent.mode or "topdown",
		children = world.children, sight = world.sight,
		emit = function(name, data) table.insert(actions, { name = name, data = data }) end,
	}
	local vx, vy = brain:update(ctx)
	local mult = agent.speedMult or 1
	vx = (vx or 0) * mult
	if vy == nil then
		vy = (agent.vy or 0) + (world.gravity or 0) * dt
	else
		vy *= mult
	end
	local r = agent.radius or 4
	local g = world.grid
	local nx = agent.x + vx * dt
	if g and (g:solidAt(nx + (if vx > 0 then r else -r), agent.y)) then nx = agent.x vx = 0 end
	local ny = agent.y + vy * dt
	agent.onFloor = false
	if g and (g:solidAt(nx, ny + (if vy > 0 then r else -r))) then
		if vy > 0 then agent.onFloor = true end
		ny = agent.y
		vy = 0
	end
	agent.x, agent.y, agent.vx, agent.vy = nx, ny, vx, vy
	return actions
end

--[[ attach(entity, spec, opts) -> controller
   spec: behaviour spec (see KIT.md), e.g. { behavior = "chase", speed = 70, aggro = 140 } or an enemy data table
         with a `behavior` field (+ `params`).
   opts: { target = Entity | fn() -> Entity|{x,y} (default: first entity tagged "player"),
           grid = PathGrid | TileMap2D entity (+ solid = "#"), mode = "topdown"|"platformer"|"flyer",
           onAction = fn(name, data, entity, controller) -> Entity? (return spawned entity for "spawn"),
           canAct = fn() -> bool (false = brain paused, e.g. stunned / knocked back),
           speedMult = fn() -> number (e.g. slow status), hp = fn() -> (hp, maxHp),
           rand = fn() -> [0,1) (default math.random, seeded) }
   Body2D: sets velocity (dynamic top-down bodies: gravity_scale = 0). Other entities: moves position. ]]
function AI.attach(e: any, spec: any, opts: any?): any
	opts = opts or {}
	local brain = Brain.new(spec)
	local grid = opts.grid
	if grid ~= nil and not (type(grid) == "table" and getmetatable(grid) == Path.PathGrid) then grid = Path.grid(grid, { solid = opts.solid }) end
	local isBody = e.type == "Body2D"
	local home = { x = e.position.x, y = e.position.y }
	local children = {}
	local ctl = { entity = e, brain = brain, home = home, stopped = false, actions = {} }
	local mode = opts.mode or spec.mode or "topdown"
	function ctl.stop() ctl.stopped = true end
	local function countChildren()
		local n = 0
		for i = #children, 1, -1 do
			if alive(children[i]) then n += 1 else table.remove(children, i) end
		end
		return n
	end
	local function getTarget()
		if opts.target ~= nil then return posOf(opts.target) end
		local list = entitiesTagged("player")
		return posOf(list[1])
	end
	ctl.update = function(dt)
		if ctl.stopped or not alive(e) then ctl.stopped = true return end
		if opts.canAct and not opts.canAct() then return end
		local p = e.position
		local v = if isBody then e.velocity else vec2(0, 0)
		local hp, maxHp = nil, nil
		if opts.hp then hp, maxHp = opts.hp() end
		local ctx = {
			dt = dt, x = p.x, y = p.y, vx = v.x, vy = v.y, onFloor = if isBody then e.onFloor else true,
			target = getTarget(), home = home, grid = grid, rand = opts.rand or math.random,
			hp = hp, maxHp = maxHp, mode = mode, children = countChildren, sight = opts.sight,
			emit = function(name, data)
				if opts.onAction then
					local r = opts.onAction(name, data, e, ctl)
					if name == "spawn" and r ~= nil then table.insert(children, r) end
				end
			end,
		}
		local vx, vy = brain:update(ctx)
		local mult = if opts.speedMult then opts.speedMult() else 1
		vx = (vx or 0) * mult
		if isBody then
			e.velocity = vec2(vx, if vy == nil then v.y else vy * mult)
		else
			local ny = if vy == nil then 0 else vy * mult
			local nx, nyy = p.x + vx * dt, p.y + ny * dt
			if grid then
				if grid:solidAt(nx, p.y) then nx = p.x end
				if grid:solidAt(nx, nyy) then nyy = p.y end
			end
			e.position = vec2(nx, nyy)
		end
		-- face movement (flip the first Sprite2D child) unless auto_flip handles it
		if opts.flip ~= false and math.abs(vx) > 1 then
			local kids = e:children()
			local spr = kids[1]
			if spr and spr.type == "Sprite2D" and not spr.auto_flip then spr.flip_h = vx < 0 end
		end
	end
	if opts.tick ~= false then
		onTick(function(dt) ctl.update(dt) end)
	end
	return ctl
end

return AI
