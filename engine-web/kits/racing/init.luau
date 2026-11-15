--!nonstrict
-- racing kit: top-down arcade racing on core + progression + juice + ai. See KIT.md.
--   pure sim: track, car, race, driver (AI), ghost, cup, garage, balance — all deterministic, testable headless
--   view: one call builds a playable race scene (tilemap, cars, camera, touch input, HUD, mini-map, countdown, results)
local R = { VERSION = "0.1.0" }
R.util = require("./util")
R.track = require("./track")
R.car = require("./car")
R.race = require("./race")
R.driver = require("./driver")
R.ghost = require("./ghost")
R.cup = require("./cup")
R.garage = require("./garage")
R.balance = require("./balance")
R.content = require("./content")
R.view = require("./view")
R.hud = require("./hud")
R.time = R.util.time
R.ordinal = R.util.ordinal
-- shorthands
function R.newTrack(def, opts) return R.track.new(def, opts) end
function R.newRace(track, opts) return R.race.new(track, opts) end
return R
