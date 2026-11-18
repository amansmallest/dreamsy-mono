--!nonstrict
-- Event bus. core.events is the global game bus; core.events.new() makes a private one.
local Bus = {}
Bus.__index = Bus

function Bus.new()
	return setmetatable({ _h = {} }, Bus)
end

function Bus:on(name: string, fn)
	if type(name) ~= "string" or type(fn) ~= "function" then error("events:on(name, fn) expects an event name and a function", 2) end
	local list = self._h[name]
	if not list then list = {} self._h[name] = list end
	local entry = { fn = fn }
	table.insert(list, entry)
	return {
		disconnect = function()
			entry.dead = true
			local l = self._h[name]
			if l then
				local i = table.find(l, entry)
				if i then table.remove(l, i) end
			end
		end,
	}
end

-- onScene(name, fn): like on(), but dropped automatically once the scene changes
-- (use from scene scripts whose handlers touch scene entities: HUD labels, sprites).
function Bus:onScene(name: string, fn)
	local sc = if type(currentScene) == "function" then currentScene() else nil
	local c
	c = self:on(name, function(...)
		if type(currentScene) == "function" and currentScene() ~= sc then c.disconnect() return end
		fn(...)
	end)
	return c
end

function Bus:once(name: string, fn)
	local c
	c = self:on(name, function(...)
		c.disconnect()
		fn(...)
	end)
	return c
end

-- emit(name, data): handlers of `name` get (data, name); "*" handlers get (name, data).
function Bus:emit(name: string, data: any?)
	local list = self._h[name]
	if list then
		for _, e in table.clone(list) do
			if not e.dead then e.fn(data, name) end
		end
	end
	local any = self._h["*"]
	if any then
		for _, e in table.clone(any) do
			if not e.dead then e.fn(name, data) end
		end
	end
end

function Bus:clear(name: string?)
	if name then self._h[name] = nil else self._h = {} end
end

-- module = the global bus, callable with dot syntax: events.on(...), events.emit(...)
local global = Bus.new()
local M = { new = Bus.new }
function M.on(name, fn) return global:on(name, fn) end
function M.once(name, fn) return global:once(name, fn) end
function M.onScene(name, fn) return global:onScene(name, fn) end
function M.emit(name, data) global:emit(name, data) end
function M.clear(name) global:clear(name) end
return M
