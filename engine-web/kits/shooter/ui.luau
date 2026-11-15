--!nonstrict
-- Between-stage screens on core.menus: results, shop, ship select. All modal, touch-sized.
local core = require("@kit/core")
local Run = require("./run")
local M = {}

local REASON = { max = "MAX", credits = "need credits", owned = "owned", unknown = "?" }

-- results(result, onNext) : stage summary list
function M.results(res, onNext, opts)
	opts = opts or {}
	local items = {
		{ label = "Score " .. res.stageScore, disabled = true },
		{ label = "Kills " .. res.kills .. "   Best chain " .. res.bestCombo, disabled = true },
		{ label = "Credits +" .. res.credits .. (if res.noMiss then "   NO MISS!" else ""), disabled = true },
		{ label = opts.nextLabel or "Continue", onSelect = function() if onNext then onNext() end end },
	}
	return core.menus.list({ title = if res.cleared then "STAGE CLEAR" else "GAME OVER", items = items, closeLabel = false })
end

-- shop(run, onDone) : config.shop items, credits via core.wallet; stays open until "Next stage"
function M.shop(run, onDone, opts)
	opts = opts or {}
	local cur = run.C.config.currency
	local h
	local function items()
		local out = {}
		for _, row in Run.shopItems(run) do
			local it = row.def
			table.insert(out, { label = it.name or it.id, detail = if row.ok then tostring(it.cost or 0) .. " cr" else "(" .. (REASON[row.reason] or row.reason) .. ")",
				disabled = not row.ok, onSelect = function()
					if Run.buy(run, it.id) then
						core.menus.toast("Bought " .. (it.name or it.id), 1)
						pcall(sfx.play, "powerup")
					end
					h.refresh(items())
				end })
		end
		return out
	end
	h = core.menus.list({ title = (opts.title or "Hangar") .. "   " .. core.wallet.get(cur) .. " cr", items = items(), keepOpen = true, perPage = 5,
		closeLabel = opts.doneLabel or "Next stage", onClose = function() if onDone then onDone() end end })
	return h
end

-- ships(C, onPick(id)) : grid of ships; locked ones show their price / unlock rule
function M.ships(C, onPick)
	local items = {}
	for _, id in C.shipsOrder do
		local s = C.ships[id]
		local st = Run.shipState(C, id)
		local detail = if st == "owned" then "" elseif st == "buyable" then "(" .. s.cost .. " cr)" else
			(if s.unlock and s.unlock.score then "(score " .. s.unlock.score .. ")" elseif s.unlock and s.unlock.clear then "(clear " .. s.unlock.clear .. ")" else "(" .. tostring(s.cost) .. " cr)")
		table.insert(items, { label = s.name or id, detail = detail, disabled = st == "locked", onSelect = function()
			if st == "buyable" then Run.unlockShip(C, id) end
			if onPick then onPick(id) end
		end })
	end
	return core.menus.list({ title = "Choose ship", items = items })
end

return M
