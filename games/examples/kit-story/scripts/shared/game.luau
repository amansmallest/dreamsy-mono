--!nonstrict
-- Lanternlight: one-time setup + headless bots used by the kit tests (kind / cold playthroughs).
local Core = require("@kit/core")
local Story = require("@kit/story")

local G = {}
local ready = false

function G.init()
	if ready then return end
	ready = true
	Core.setup({
		theme = { primary = "#2f7f86", accent = "#ffd36b", background = "#1c1a2b", text = "#f5efe2", font = "rounded" },
		save = { key = "lanternlight", version = 1 },
	})
	Story.setup()
end

-- bot(mode): "kind" picks the first option of every choice, "cold" the last; both solve the boathouse and the board.
function G.bot(mode)
	return {
		pick = function(opts)
			local ids = {}
			for i, o in opts do if not o.locked then table.insert(ids, i) end end
			return if mode == "cold" then ids[#ids] else ids[1]
		end,
		room = function(S, room)
			S.tap("net") S.tap("drum") S.tap("prints") S.tap("ledger")
			-- the ledger runs a short script and comes back to the room
			while S.step().kind ~= "explore" do end
			S.tap("toolbox", "brass_key")
			S.combine("wick", "oil_flask")
			S.tap("door")
		end,
		board = function(S)
			S.connect("cut_wick", "shears_oil")
			S.connect("wet_prints", "ott_alibi")
			S.connect("ledger_gap", "lantern_boat")
			S.answer(2)
		end,
	}
end

return G
