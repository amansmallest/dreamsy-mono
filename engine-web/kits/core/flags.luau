--!nonstrict
-- Flags/variables store (story flags, counters, choices). Emits "flag_changed" {key, value, old}.
local S = require("./shared")
local M = {}
local vals: { [string]: any } = {}

local function changed(k, v, old)
	if v ~= old and S.events then S.events.emit("flag_changed", { key = k, value = v, old = old }) end
end
function M.get(key: string, default: any?)
	local v = vals[key]
	if v == nil then return default end
	return v
end
function M.set(key: string, value: any)
	if type(key) ~= "string" then error("flags.set expects a string key", 2) end
	local old = vals[key]
	vals[key] = value
	changed(key, value, old)
	return value
end
function M.add(key: string, n: number?)
	local old = vals[key]
	local v = (if type(old) == "number" then old else 0) + (n or 1)
	vals[key] = v
	changed(key, v, old)
	return v
end
function M.toggle(key: string) return M.set(key, not vals[key]) end
function M.has(key: string) return vals[key] ~= nil and vals[key] ~= false end
function M.all() return table.clone(vals) end
function M.reset() vals = {} end
function M.serialize() return table.clone(vals) end
function M.deserialize(t) vals = if type(t) == "table" then table.clone(t) else {} end
return M
