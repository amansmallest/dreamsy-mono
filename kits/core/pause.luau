--!nonstrict
-- Gameplay pause stack, independent of the platform pause menu (which freezes everything anyway).
-- Menus/dialogs push a reason; gameplay code checks pause.isPaused() / uses pause.clock().
-- push(reason, scoped?) — scoped = true: released automatically when the scene changes (menus, dialogs, transitions
-- opened by scene scripts). Emits "pause_changed" {paused, reason}.
local S = require("./shared")
local M = {}
local entries: { { reason: string, scene: string? } } = {}
local pausedAt: number? = nil
local pausedTotal = 0

local function now() return if type(time) == "function" then time() else 0 end
local function scene() return if type(currentScene) == "function" then currentScene() else nil end
local function changed(paused, reason)
	if paused then pausedAt = now()
	else
		pausedTotal += now() - (pausedAt or now())
		pausedAt = nil
	end
	if S.events then S.events.emit("pause_changed", { paused = paused, reason = reason }) end
end
local function sweep()
	local sc = scene()
	local removed = nil
	for i = #entries, 1, -1 do
		local e = entries[i]
		if e.scene ~= nil and e.scene ~= sc then removed = e.reason table.remove(entries, i) end
	end
	if removed and #entries == 0 and pausedAt then changed(false, removed) end
end

function M.push(reason: string?, scoped: boolean?)
	sweep()
	reason = reason or "game"
	table.insert(entries, { reason = reason, scene = if scoped then scene() else nil })
	if #entries == 1 then changed(true, reason) end
end
function M.pop(reason: string?)
	reason = reason or "game"
	for i = #entries, 1, -1 do
		if entries[i].reason == reason then
			table.remove(entries, i)
			if #entries == 0 then changed(false, reason) end
			return
		end
	end
end
function M.isPaused(): boolean sweep() return #entries > 0 end
function M.reasons()
	sweep()
	local out, seen = {}, {}
	for _, e in entries do if not seen[e.reason] then seen[e.reason] = true table.insert(out, e.reason) end end
	table.sort(out)
	return out
end
-- gameplay clock: seconds since start excluding kit-paused time
function M.clock(): number
	sweep()
	if pausedAt then return pausedAt - pausedTotal end
	return now() - pausedTotal
end
function M.clear()
	local was = #entries > 0
	entries = {}
	if was then changed(false, "clear") end
end
return M
