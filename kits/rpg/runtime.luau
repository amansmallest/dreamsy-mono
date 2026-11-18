-- rpg kit: late-bound services so logic modules don't require the UI modules (no require cycles).
-- init.luau fills these in; tests can stub them.
local R = {}

-- R.startTrainerBattle(trainerId, done(result))     R.startWildBattle({ creature, level, can_run }, done(result))
-- R.warp(mapId, spawnId?)                            R.openShop(shopId, done())
-- R.openStorage(done())                              R.dialog(dialogId | def, opts?, done(result))
-- R.toast(text, seconds?)                            R.save() -> boolean
-- R.notify(text)                                     (non-blocking message, e.g. "Got 2 Tonics!")
R.startTrainerBattle = nil
R.startWildBattle = nil
R.warp = nil
R.openShop = nil
R.openStorage = nil
R.dialog = nil
R.save = nil
R.toast = function(text: string, seconds: number?)
	ui.toast(text, seconds)
end
R.notify = function(text: string)
	ui.toast(text, 1.6)
end

return R
