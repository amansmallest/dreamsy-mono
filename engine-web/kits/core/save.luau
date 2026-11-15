--!nonstrict
-- Save/load of all core state (+ registered sections) through the engine's save.get/set, versioned.
-- save.configure({ key = "core", version = 1, migrate = function(data, fromVersion) return data end })
-- save.section(name, { serialize = fn() -> table, deserialize = fn(table) })  (or any object with those methods)
local S = require("./shared")
local M = { key = "core", version = 1, migrate = nil }
local sections: { [string]: any } = {}
local order: { string } = {}
local hooks = { beforeSave = {}, afterLoad = {} }

local function store()
	if type(save) == "table" and type(save.get) == "function" then return save end
	return nil
end

function M.configure(opts)
	if opts.key then M.key = opts.key end
	if opts.version then M.version = opts.version end
	if opts.migrate then M.migrate = opts.migrate end
end
function M.section(name: string, obj)
	if type(obj) ~= "table" or type(obj.serialize) ~= "function" or type(obj.deserialize) ~= "function" then
		error("save.section(name, obj): obj needs serialize() and deserialize(t)", 2)
	end
	if sections[name] == nil then table.insert(order, name) end
	sections[name] = obj
end
function M.onBeforeSave(fn) table.insert(hooks.beforeSave, fn) end
function M.onAfterLoad(fn) table.insert(hooks.afterLoad, fn) end

-- snapshot() -> { v = version, t = time(), d = { section = data } } (plain JSON-able)
function M.snapshot()
	for _, f in hooks.beforeSave do f() end
	local d = {}
	for _, name in order do
		local obj = sections[name]
		d[name] = obj:serialize()
	end
	return { v = M.version, t = if type(time) == "function" then time() else 0, d = d }
end

-- restore(snapshot): runs migrate(data, fromVersion) when snapshot.v < version (data = the sections table)
function M.restore(snap)
	if type(snap) ~= "table" then return false end
	local d = snap.d or {}
	local from = snap.v or 1
	if from > M.version then error("save is from a newer version (" .. from .. " > " .. M.version .. ")", 2) end
	if from < M.version then
		if M.migrate then
			d = M.migrate(d, from) or d
		end
	end
	for _, name in order do sections[name]:deserialize(d[name]) end
	for _, f in hooks.afterLoad do f(d) end
	if S.events then S.events.emit("game_loaded", { version = from }) end
	return true
end

function M.save(slot: string?): boolean
	local s = store()
	if not s then return false end
	s.set(M.key .. (if slot then "_" .. slot else ""), M.snapshot())
	if S.events then S.events.emit("game_saved", { slot = slot }) end
	return true
end
function M.load(slot: string?): boolean
	local s = store()
	if not s then return false end
	local snap = s.get(M.key .. (if slot then "_" .. slot else ""))
	if snap == nil then return false end
	return M.restore(snap)
end
function M.exists(slot: string?): boolean
	local s = store()
	return s ~= nil and s.get(M.key .. (if slot then "_" .. slot else "")) ~= nil
end
function M.delete(slot: string?)
	local s = store()
	if s then s.remove(M.key .. (if slot then "_" .. slot else "")) end
end
-- reset(): wipe in-memory state of every section (new game); does not touch stored saves
function M.reset()
	for _, name in order do
		local obj = sections[name]
		if obj.reset then obj:reset() else obj:deserialize(nil) end
	end
end
return M
