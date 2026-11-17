--!strict
print("hello", 1, true, nil)
local a, b = vec2(1, 2), vec2(3, 4)
print(a + b, a * 2, b:length(), (a - b):normalized(), a:dot(b), vec3(1, 2, 3):cross(vec3(0, 1, 0)))
local c = color("#ff8000")
print(c, c.r, c:lerp(color("#000000"), 0.5), color("#abc"))
print(string.format("%.6f %.6f %.6f", random(), random(10, 20), random(5)))
print(math.random(), math.random(6), math.random(3, 9))
local ticks = 0
local conn
conn = onTick(function(dt)
  ticks += 1
  if ticks == 3 then print("tick", ticks, string.format("%.6f", dt), string.format("%.6f", time())) end
  if ticks == 10 then conn:disconnect() end
end)
after(0.5, function() print("after 0.5", string.format("%.4f", time()), ticks) end)
local n = 0
local t
t = every(0.25, function()
  n += 1
  print("every", n, string.format("%.4f", time()))
  if n == 3 then t:cancel() end
end)
local never = after(0.1, function() print("never") end)
never:cancel()
after(1, function()
  game.timeScale = 2
  print("timeScale", game.timeScale)
  after(0.5, function() print("scaled after", string.format("%.4f", time())) end)
end)
print("theme", ui.theme().primary, ui.theme().panel)
print("clock", clock.now())
print(isEntity(nil), isEntity({}), typeof(script), script.path, script.entity)
