--!strict
-- tycoon kit (idle / incremental): require("@kit/tycoon"). See KIT.md.
local Core = require("./core")
local Format = require("./format")
local Content = require("./content")

local Tycoon = {}
Tycoon.VERSION = "0.2.0"
local G: any = _G

-- new game state; content = a raw content table, or nil to read the game's data/*.json (Content.read)
function Tycoon.new(content: any?, opts: any?): any
	return Core.new(content, opts)
end

Tycoon.read = Content.read
Tycoon.normalize = Content.normalize
Tycoon.format = Format.format
Tycoon.duration = Format.duration
Tycoon.suffix = Format.suffix

-- wall clock (engine clock.now(), unix seconds; fixed in playtests) — used for offline progress
function Tycoon.wallClock(): number?
	local c = G.clock
	return if type(c) == "table" and type(c.now) == "function" then c.now() else nil
end

-- ---------- persistence through the engine `save` global ----------
-- Tycoon.persist(t, "tycoon") writes t:serialize(now) under the key (call every few seconds + on purchases).
function Tycoon.persist(t: any, key: string?, now: number?)
	local s: any = G.save
	if s == nil then
		return
	end
	s.set(key or "tycoon", t:serialize(now or Tycoon.wallClock()))
end

-- Tycoon.restore(content?, key, opts) / Tycoon.restore(key, opts) → state (fresh if no save) + the offline report (or nil)
function Tycoon.restore(content: any, key: any?, opts: any?): (any, any)
	if type(content) == "string" then
		content, key, opts = nil, content, key
	end
	local t = Tycoon.new(content, opts)
	local s: any = G.save
	local report = nil
	if s ~= nil then
		local d = s.get(key or "tycoon")
		if d ~= nil and t:deserialize(d) then
			report = t:applyOffline((opts and opts.now) or Tycoon.wallClock())
		end
	end
	return t, report
end

-- Tycoon.bindSave(t, name = "tycoon"): store t as a core.save section (one save with flags/quests/…);
-- core.save.load() restores it and applies offline progress (t.on.offline fires).
function Tycoon.bindSave(t: any, name: string?): any
	local core: any = require("@kit/core")
	core.save.section(name or "tycoon", {
		serialize = function()
			return t:serialize(Tycoon.wallClock())
		end,
		deserialize = function(_, d: any)
			if d ~= nil and t:deserialize(d) then
				t:applyOffline(Tycoon.wallClock())
			end
		end,
	})
	return t
end

-- presentation helpers (engine entities); safe to require headless
Tycoon.ui = require("./ui")

return Tycoon
