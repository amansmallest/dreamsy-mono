print("start")
local function boom() local t = nil; return t.x end
onTick(function()
  if time() < 0.1 then boom() end
end)
after(0.2, function() error("custom failure") end)
after(0.3, function() error({ code = 1 }) end)
local ok, err = pcall(function()
  local i = 0
  while true do i += 1 end
end)
print("pcall cannot swallow the budget", ok)