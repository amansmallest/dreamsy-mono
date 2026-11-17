local M = { count = 0 }
function M.bump() M.count += 1; return M.count end
print("state module loaded once")
return M