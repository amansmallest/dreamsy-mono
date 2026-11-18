-- tower-defense kit (Dreamsy §12.1) — require("@kit/tower-defense").
-- Data-driven TD: paths from TileMap2D grids or waypoints, enemies/towers/waves/levels/campaign from JSON content,
-- a deterministic Sim, a View (entities + radial build/upgrade menus), a portrait Hud, campaign progress + save,
-- and a headless balance bot. See KIT.md.
local core = require("@kit/core")
local TD = {}

TD.VERSION = "1.0.0"
TD.Util = require("@kit/tower-defense/util")
TD.Path = require("@kit/tower-defense/path")
TD.Content = require("@kit/tower-defense/content")
TD.Sim = require("@kit/tower-defense/sim")
TD.Campaign = require("@kit/tower-defense/campaign")
TD.Balance = require("@kit/tower-defense/balance")

-- View/Hud use engine entity globals; load lazily so pure sims work anywhere.
setmetatable(TD, {
	__index = function(t, k)
		if k == "View" then
			local m = require("@kit/tower-defense/view")
			rawset(t, k, m)
			return m
		elseif k == "Hud" then
			local m = require("@kit/tower-defense/hud")
			rawset(t, k, m)
			return m
		end
		return nil
	end,
})

-- Content (see KIT.md "Content"): TD.content() reads the package's data/** (once; cached), TD.content("data/td")
-- reads another root, TD.content(tbl) normalizes a table. Cheap to call repeatedly.
local loaded = {}
function TD.content(raw)
	if raw == nil or type(raw) == "string" then
		local root = raw or "data"
		loaded[root] = loaded[root] or TD.Content.load(TD.Content.read(root))
		return loaded[root]
	end
	return TD.Content.load(raw)
end

-- Start a level: returns sim. opts: Sim.new options.
function TD.level(content, levelId, opts)
	return TD.Sim.new(content, levelId, opts)
end

-- One-call setup for a level scene: sim + view + hud, wired to onTick. Returns { sim, view, hud }.
-- opts: { map = TileMap2D, root = Node2D, campaign = Campaign?, endless = bool, theme, hudTheme, sfx, labels,
--         onWin = fn(result), onLose = fn(result) }. Finishing records the result in the campaign (+ save) and emits
--         core events "td_level_won" / "td_level_lost" { level, stars, wave, endless } for quests/achievements.
function TD.play(content, levelId, opts)
	opts = opts or {}
	local simOpts = if opts.campaign then opts.campaign:simOptions(levelId, opts.simOptions) else (opts.simOptions or {})
	if opts.endless and opts.campaign then
		simOpts = opts.campaign:endlessOptions(opts.simOptions)
	end
	local sim = TD.Sim.new(content, levelId, simOpts)
	local view = TD.View.new(sim, { map = opts.map, root = opts.root, theme = opts.theme, sfx = opts.sfx, names = opts.names, tile = opts.tile, origin = opts.origin })
	local hud = if opts.hud == false then nil else TD.Hud.new(sim, { theme = opts.hudTheme, labels = opts.labels })
	local finished = false
	onTick(function(dt)
		view:update(dt)
		if hud then
			hud:update()
		end
		if not finished and (sim.state == "won" or sim.state == "lost") then
			finished = true
			view:closeMenu()
			TD.View.resetTimeScale(view) -- result banner runs at normal speed
			local res = sim:result()
			if opts.campaign then
				res.progress = opts.campaign:complete(res)
				opts.campaign:save()
			end
			core.emit(if sim.state == "won" then "td_level_won" else "td_level_lost", { level = res.level, stars = res.stars, wave = res.wave, endless = res.endless })
			if sim.state == "won" and opts.onWin then
				opts.onWin(res)
			elseif sim.state == "lost" and opts.onLose then
				opts.onLose(res)
			end
		end
	end)
	return { sim = sim, view = view, hud = hud }
end

return TD
