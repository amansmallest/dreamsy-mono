--!nonstrict
-- Finite state machine.
-- local m = fsm.new({ initial = "idle", context = player, states = {
--   idle = { enter = function(m, from) end, update = function(m, dt) end, exit = function(m, to) end,
--            on = { jump = "air", hurt = function(m, dmg) return if dmg > 5 then "dead" else nil end } },
--   air = {...} }, onChange = function(m, from, to) end })
local FSM = {}
FSM.__index = FSM

local M = {}

function M.new(def)
	if type(def) ~= "table" or type(def.states) ~= "table" then error("fsm.new expects { initial = \"name\", states = { name = { enter?, update?, exit?, on? } } }", 2) end
	local m = setmetatable({ states = def.states, context = def.context, onChange = def.onChange, state = nil, previous = nil, time = 0, history = {} }, FSM)
	if def.initial then m:go(def.initial) end
	return m
end

function FSM:go(to: string, ...)
	local st = self.states[to]
	if not st then error("fsm: unknown state \"" .. tostring(to) .. "\"", 2) end
	local from = self.state
	if from and self.states[from].exit then self.states[from].exit(self, to) end
	self.previous = from
	self.state = to
	self.time = 0
	table.insert(self.history, to)
	if #self.history > 16 then table.remove(self.history, 1) end
	if st.enter then st.enter(self, from, ...) end
	if self.onChange then self.onChange(self, from, to) end
	return true
end

-- send(event, ...): follow the current state's `on[event]` (a state name, or a function returning one/nil)
function FSM:send(event: string, ...)
	if not self.state then return false end
	local on = self.states[self.state].on
	local t = on and on[event]
	if type(t) == "function" then t = t(self, ...) end
	if type(t) == "string" then
		self:go(t, ...)
		return true
	end
	return false
end

function FSM:update(dt: number)
	if not self.state then return end
	self.time += dt
	local st = self.states[self.state]
	if st.update then
		local nxt = st.update(self, dt)
		if type(nxt) == "string" and nxt ~= self.state then self:go(nxt) end
	end
end

function FSM:is(name: string) return self.state == name end
function FSM:can(event: string)
	local on = self.state and self.states[self.state].on
	return on ~= nil and on[event] ~= nil
end

return M
