print("later scripts still run")
after(0.4, function()
  while true do end
end)
after(0.5, function() print("game continues after a budget kill") end)