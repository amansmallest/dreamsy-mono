-- Built-in status effects. Stacking: "refresh" (reset duration), "stack" (+stacks up to max, refresh),
-- "extend" (add duration), "max" (keep the longer), "ignore" (no effect while active).
-- Fields: duration, tick (s between damage ticks), damage (per tick per stack), type (damage type),
-- speedMult, busy (can't act), damageTakenMult, tint ("#rrggbb"), maxStacks, breaksOnHit, immuneAfter (s)
return {
	burn = { duration = 3, tick = 0.5, damage = 2, type = "fire", stacking = "stack", maxStacks = 5, tint = "#ff7b39" },
	poison = { duration = 5, tick = 1, damage = 1, type = "poison", stacking = "stack", maxStacks = 10, tint = "#8bd34a", ignoreArmor = true },
	bleed = { duration = 4, tick = 0.5, damage = 1, type = "physical", stacking = "stack", maxStacks = 8, tint = "#c0392b", ignoreArmor = true },
	slow = { duration = 2, speedMult = 0.5, stacking = "refresh", tint = "#7fb2ff" },
	stun = { duration = 0.8, busy = true, stacking = "max", tint = "#fff275", immuneAfter = 0.5 },
	freeze = { duration = 1.5, busy = true, speedMult = 0, damageTakenMult = 1.25, stacking = "refresh", tint = "#9be7ff", breaksOnHit = true, immuneAfter = 1 },
	regen = { duration = 5, tick = 1, heal = 2, stacking = "refresh", tint = "#7dff9b" },
	haste = { duration = 4, speedMult = 1.5, stacking = "refresh" },
	vulnerable = { duration = 4, damageTakenMult = 1.5, stacking = "refresh", tint = "#ff9be7" },
}
