--!strict
local net = require("../shared/net")
net.announce:onClient(function(message: string)
	ui.toast(message)
end)
