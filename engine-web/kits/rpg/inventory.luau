-- rpg kit: using items outside battle, and shops (data/shops/<id>.json).
local U = require("./util")
local Content = require("./content")
local State = require("./state")
local Events = require("./events")
local Creatures = require("./creatures")
local Logic = require("./logic")

local I = {}

-- can `itemId` be used on `mon` right now (field)?
function I.canUseOn(itemId: string, mon): boolean
	local it = Content.item(itemId)
	if it.revive then return mon.hp <= 0 end
	if mon.hp <= 0 then return false end
	if (it.heal or it.heal_percent) and mon.hp < mon.maxhp then return true end
	if it.cure and mon.status and (it.cure == true or table.find(it.cure, mon.status)) then return true end
	if it.evolve or it.kind == "evolve" then return Creatures.evolutionFor(mon, { item = itemId }, Logic.check) ~= nil end
	if it.teach then return not Creatures.knows(mon, it.teach) and (it.teach_to == nil or table.find(it.teach_to, mon.id) ~= nil) end
	if it.level_up then return mon.level < Creatures.MAX_LEVEL end
	if it.kind == "held" then return true end
	return false
end

-- does the item need a creature target?
function I.targets(itemId: string): boolean
	local it = Content.item(itemId)
	return it.heal ~= nil or it.heal_percent ~= nil or it.cure ~= nil or it.revive ~= nil or it.evolve ~= nil or it.kind == "evolve"
		or it.teach ~= nil or it.level_up ~= nil or it.kind == "held"
end

-- use on a creature; returns ok, message, extra ({ evolved = into })
function I.useOn(itemId: string, mon)
	local it = Content.item(itemId)
	if State.count(itemId) <= 0 then return false, "You don't have any." end
	if not I.canUseOn(itemId, mon) then return false, "It won't have any effect." end
	local name = Creatures.name(mon)
	if it.kind == "held" then
		if mon.held then State.give(mon.held, 1) end
		State.take(itemId, 1)
		mon.held = itemId
		return true, name .. " is now holding " .. it.name .. "."
	end
	local consume = it.consumable ~= false
	local msg
	local extra = {}
	if it.revive then
		mon.hp = math.max(1, math.floor(mon.maxhp * it.revive / 100))
		mon.status = nil
		msg = name .. " was revived!"
	elseif it.evolve or it.kind == "evolve" then
		local into = Creatures.evolutionFor(mon, { item = itemId }, Logic.check)
		local from = Creatures.evolve(mon, into)
		extra.evolved = into
		msg = name .. " became " .. Creatures.species(mon).name .. "!"
		Events.evolved:fire(mon, from, into)
		State.get().caught[into] = true
		State.get().seen[into] = true
	elseif it.teach then
		local r = Creatures.learn(mon, it.teach)
		if r == "full" then return false, name .. " already knows 4 moves." end
		msg = name .. " learned " .. Content.move(it.teach).name .. "!"
	elseif it.level_up then
		local sp = Creatures.species(mon)
		local need = Creatures.xpForLevel(sp.xp_curve, mon.level + it.level_up) - mon.xp
		Creatures.gainXp(mon, need)
		Events.levelUp:fire(mon, mon.level)
		msg = name .. " grew to level " .. mon.level .. "!"
	else
		local before = mon.hp
		mon.hp = math.min(mon.maxhp, mon.hp + math.floor((it.heal or 0) + mon.maxhp * (it.heal_percent or 0) / 100))
		local parts = {}
		if mon.hp > before then table.insert(parts, name .. " recovered " .. (mon.hp - before) .. " HP.") end
		if it.cure and mon.status and (it.cure == true or table.find(it.cure, mon.status)) then
			mon.status, mon.sleep = nil, nil
			table.insert(parts, name .. " was cured.")
		end
		msg = table.concat(parts, " ")
	end
	if consume then State.take(itemId, 1) end
	Events.itemUsed:fire(itemId, mon)
	return true, msg, extra
end

-- key items / tools with "use": [effects] (no target)
function I.useKey(itemId: string, done: ((boolean) -> ())?)
	local it = Content.item(itemId)
	if not it.use then
		if done then done(false) end
		return false
	end
	if it.consumable == true then State.take(itemId, 1) end
	Events.itemUsed:fire(itemId, nil)
	Logic.run(it.use, done)
	return true
end

-- ---------------------------------------------------------------- shops
-- data/shops/<id>.json: { "name": "Mart", "items": [ "tonic", { "item": "orb", "price": 150, "if": {...} } ],
--                         "sell": true, "sell_rate": 0.5 }

function I.shopItems(shopId: string)
	local s = Content.shops[shopId]
	if not s then error("rpg: unknown shop \"" .. tostring(shopId) .. "\"") end
	local out = {}
	for _, e in s.items or {} do
		local id = if type(e) == "table" then e.item else e
		local cond = if type(e) == "table" then e["if"] else nil
		local def = Content.items[id]
		if def and (cond == nil or Logic.check(cond)) then
			table.insert(out, { id = id, def = def, price = (if type(e) == "table" then e.price else nil) or def.price })
		end
	end
	return out
end

function I.buy(shopId: string, itemId: string, qty: number?): (boolean, string)
	qty = qty or 1
	local price
	for _, e in I.shopItems(shopId) do
		if e.id == itemId then price = e.price end
	end
	if not price then return false, "Not sold here." end
	local total = price * qty
	if not State.spend(total) then return false, "You don't have enough money." end
	State.give(itemId, qty)
	return true, "Bought " .. (if qty > 1 then qty .. "× " else "") .. Content.item(itemId).name .. " for $" .. total .. "."
end

function I.sellPrice(shopId: string?, itemId: string): number
	local it = Content.item(itemId)
	if it.kind == "key" then return 0 end
	local rate = shopId and Content.shops[shopId] and Content.shops[shopId].sell_rate
	if rate then return math.floor(it.price * rate) end
	return it.sell
end

function I.sell(shopId: string?, itemId: string, qty: number?): (boolean, string)
	qty = qty or 1
	local p = I.sellPrice(shopId, itemId)
	if p <= 0 then return false, "That can't be sold." end
	if not State.take(itemId, qty) then return false, "You don't have that many." end
	State.addMoney(p * qty)
	return true, "Sold for $" .. (p * qty) .. "."
end

return I
