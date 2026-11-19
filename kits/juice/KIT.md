# juice kit

Game-feel presets on engine tween / particles / camera / UI. One call per effect; every function is safe headless,
ignores nil/destroyed entities, and degrades to a no-op (or instant change) when an engine feature is missing.
Repeated effects on one entity don't compound (the kit remembers each entity's resting scale/size/modulate).

## Setup
```toml
kits = ["juice"]          # with "core": hitstop/transitions also push core.pause (kit.json: no deps)
```
```luau
local juice = require("@kit/juice")
```

## API
```luau
-- time
juice.hitstop(seconds? = 0.06)       -- freeze-frame on big hits: game.timeScale = 0 for `seconds` real time (physics, tweens,
                                     -- timers, anims freeze; onTick runs with dt = 0); core.pause "hitstop" pushed too
juice.slowmo(scale? = 0.3, seconds? = 0.5)   -- bullet time (game.timeScale) for real seconds, then restores the previous scale
juice.stopped() -> boolean           juice.timeScale() -> game.timeScale
-- camera
juice.shake("tiny"|"light"|"medium"|"heavy"|"explosion" | intensity, seconds?)   -- juice.SHAKES table is editable
juice.zoomPunch(amount? = 0.06, seconds? = 0.25)
-- entity feedback (Sprite2D/Node2D: scale/modulate; UI: size/background/color)
juice.squash(e, { amount = 0.25, seconds = 0.3, easing = "back_out" })   juice.stretch(e, opts)
juice.punch(e, amount? = 0.2, seconds?)       juice.bounce(e, { amount = 0.15, seconds = 0.35 })   -- UI pop
juice.flash(e, color? = "#ffffff", seconds? = 0.12)      juice.blink(e, seconds? = 1, rate? = 12)   -- i-frames
juice.pulse(e, { amount = 0.08, seconds = 0.6 }) -> Tween (loop; :cancel())   juice.float(e, { height = 8, seconds = 1 }) -> Tween
juice.fadeOut(e, seconds? = 0.3, destroy?)
-- popups (world space Text2D, rises + fades, auto-destroyed)
juice.popup(text, worldPos, { color, size = 32, rise = 70, seconds = 0.8, outline = "#000000", font = "bold", drift?, pop? })
juice.damage(n, worldPos, { crit?, heal?, miss?, color? })        -- white / big yellow "n!" / green "+n" / grey "miss"
-- particles (spawned Particles2D bursts, auto-destroyed)
juice.sparkle(pos, { color = "#ffe066", n = 10 })   juice.dust(pos, { color?, n = 8 })
juice.coinBurst(pos, { n = 12, color = "#ffd34d", texture? = "asset:coin", size = 20, collectTo? = worldPos, onArrive?(i) })
   -- collectTo: coins spray out then fly to the target (HUD counter: camera.screenToWorld(vec2(x, y)))
juice.confetti(pos? (top of view), { n = 60, colors? })      juice.emitter(pos, particleProps, n)   -- raw burst helper
-- UI text
juice.typewriter(textEntity, text, { cps = 40, sfx?, onDone? }) -> { skip(), cancel(), done }
juice.rollup(textEntity, from, to, { seconds = 0.6, prefix?, suffix?, format?(n) -> string, onDone? }) -> { cancel() }
-- scene transitions (UI overlay, z 3000)
juice.transition("fade"|"wipe"|"iris", { scene?, params?, seconds = 0.35, color = "#000000", onCovered? })
juice.reveal(kind?, { seconds?, color? })      -- call at the top of each scene script (no-op cost if nothing is pending)
-- audio
juice.sfx(id, opts?)                -- sfx.play that never errors on a missing id
```

## Recipes
```luau
-- hit
juice.flash(enemy) juice.squash(enemy) juice.damage(dmg, enemy.position + vec2(0, -60), { crit = crit })
juice.shake(if crit then "medium" else "light") juice.sfx("hit")
-- kill
juice.hitstop(0.08) juice.shake("heavy")
juice.coinBurst(enemy.position, { n = 8, texture = "asset:coin", collectTo = camera.screenToWorld(vec2(120, 55)) })
-- currency HUD
core.events.onScene("currency_changed", function(d) juice.rollup(goldText, shown, d.amount, { prefix = "Gold " }) shown = d.amount juice.bounce(goldText) end)
-- level up / win
juice.confetti() juice.sfx("level")
-- scene change (from any script) + reveal in the next scene
juice.transition("iris", { scene = "scenes/level_2.scene.json" })      -- level_2 script: juice.reveal("iris")
-- landing
juice.dust(player.position + vec2(0, 16)) juice.squash(player, { amount = 0.2 })
```

## Notes
- Gameplay that should freeze during hitstop: `if juice.stopped() then return end` in `onTick` (or check `core.pause.isPaused()`).
- Transition reveal: `juice.transition` reveals automatically when called from a session script; scene scripts should call
  `juice.reveal(kind)` at top level (harmless when nothing is pending — it plays a quick reveal).
- `flash` restores the entity's original color; `pulse`/`float` loop until cancelled or the entity dies.
- Effects spawn entities into the current scene; they die with it.

## Do / don't
- Do layer 2–3 small effects per event (flash + squash + number) rather than one huge one.
- Don't shake on every frame or every small action; reserve "heavy"/"explosion" for kills and bosses.
- Don't rely on juice for game logic (no state lives here except hitstop).
