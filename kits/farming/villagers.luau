--!nonstrict
-- Villager schedules (pure): which entry list applies today, and where a villager is at a given minute.
-- Schedule = { default = { {600, "house_a"}, {900, "square"}, ... }, rain?, <weekday lowercase>?, <season>?, <season>_<day>? }
-- Entries are { minute, location } (or { at = minute, to = location }). A villager walks from the previous entry's
-- location to the new one along the location graph (ai.graphPath over config.locations) at config.villagerSpeed px/min.
local ai = require("@kit/ai")
local M = {}

local function entry(e)
	if e.at then return e.at, e.to end
	return e[1], e[2]
end

-- scheduleKey(def, ctx{season, day, weekday, weather, festival}) -> key, entries
function M.pick(def, ctx)
	local s = def.schedule
	if ctx.festival and ctx.festival.location then
		local f = ctx.festival
		local _, list = M.pick(def, { season = ctx.season, day = ctx.day, weekday = ctx.weekday, weather = ctx.weather })
		-- festival overrides the window [start, end]: everyone goes to the festival location (or def.festivalSpot)
		local out = {}
		for _, e in list do
			local t, loc = entry(e)
			if t < f.start then table.insert(out, { t, loc }) end
		end
		table.insert(out, { f.start, (def.festivalSpots and def.festivalSpots[f.id]) or f.location })
		local after = def.home or (if #list > 0 then select(2, entry(list[1])) else f.location)
		table.insert(out, { f["end"], after })
		return "festival", out
	end
	local keys = {}
	if ctx.season and ctx.day then table.insert(keys, ctx.season .. "_" .. ctx.day) end
	if ctx.weather and ctx.weather ~= "sunny" then table.insert(keys, ctx.weather) end
	if ctx.weekday then table.insert(keys, string.lower(ctx.weekday)) end
	if ctx.season then table.insert(keys, ctx.season) end
	table.insert(keys, "default")
	for _, k in keys do
		if s[k] then return k, s[k] end
	end
	return "default", { { 0, def.home or "home" } }
end

local pathCache = {}
local function route(locations, from, to)
	if from == to then return { from } end
	local key = tostring(locations) .. "|" .. from .. ">" .. to
	local r = pathCache[key]
	if r == nil then
		r = ai.graphPath(locations, from, to) or { from, to }
		pathCache[key] = r
	end
	return r
end
M.route = route

local function xy(locations, id)
	local l = locations[id]
	if not l then error("farming: villager location \"" .. tostring(id) .. "\" is not in config.locations", 3) end
	return l.x or 0, l.y or 0
end

-- where(def, entries, minute, locations, speed) -> { x, y, loc (current or destination), moving, from, to }
function M.where(def, entries, minute, locations, speed)
	speed = speed or 3
	local prevLoc = nil
	local idx = 0
	for i, e in entries do
		local t = entry(e)
		if t <= minute then idx = i end
	end
	if idx == 0 then
		local _, loc = entry(entries[1])
		local x, y = xy(locations, def.home or loc)
		return { x = x, y = y, loc = def.home or loc, moving = false }
	end
	local t0, to = entry(entries[idx])
	if idx > 1 then prevLoc = select(2, entry(entries[idx - 1])) else prevLoc = def.home or to end
	if prevLoc == to then
		local x, y = xy(locations, to)
		return { x = x, y = y, loc = to, moving = false }
	end
	local path = route(locations, prevLoc, to)
	local dist = (minute - t0) * speed
	for i = 1, #path - 1 do
		local ax, ay = xy(locations, path[i])
		local bx, by = xy(locations, path[i + 1])
		local seg = math.sqrt((bx - ax) ^ 2 + (by - ay) ^ 2)
		if dist <= seg and seg > 0 then
			local f = dist / seg
			return { x = ax + (bx - ax) * f, y = ay + (by - ay) * f, loc = to, moving = true, from = prevLoc, to = to }
		end
		dist -= seg
	end
	local x, y = xy(locations, to)
	return { x = x, y = y, loc = to, moving = false }
end

-- giftTaste(def, itemId, itemDef?) -> "love" | "like" | "neutral" | "dislike" | "hate"
-- lists may hold item ids or "category:<name>"
function M.taste(def, item, itemDef)
	local cat = itemDef and itemDef.category and ("category:" .. itemDef.category)
	for _, k in { "loves", "likes", "dislikes", "hates" } do
		for _, x in def[k] do
			if x == item or (cat and x == cat) then
				return (({ loves = "love", likes = "like", dislikes = "dislike", hates = "hate" }) :: any)[k]
			end
		end
	end
	return "neutral"
end

return M
