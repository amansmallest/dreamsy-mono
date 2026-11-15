--!nonstrict
-- Session script (unattached): runs once, survives scene changes. Autosaves while playing.
local G = require("../shared/game")
G.init()
every(10, function() if G.playing then G.core.save.save() end end)
