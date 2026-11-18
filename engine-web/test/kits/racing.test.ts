// racing kit (engine-web/kits/racing): headless tests through real Luau + the example package end to end.
import { join, resolve } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game, MemoryLeaderboardHost, MemorySaveHost } from "../../core/index.js";
import { simulate } from "../../tools/playtest.js";

const EXAMPLE = resolve(__dirname, "../../../games/examples/kit-racing");
const scene = JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } });
function kitGame(script: string, files: Record<string, string> = {}) {
  return Package.fromFiles({
    "dreamsy.toml": `format = "0"\nname = "K"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/main.scene.json"\nkits = ["racing"]\n`,
    "scenes/main.scene.json": scene,
    "scripts/client/main.luau": script,
    ...files,
  });
}
async function run(script: string, opts: { steps?: number; save?: MemorySaveHost; files?: Record<string, string> } = {}) {
  const g = await Game.load(kitGame(script, opts.files), { save: opts.save, budgetMs: 5000 }); // pure-logic batches (thousands of sims in one callback) under parallel test load: the 250ms frame budget is wall-clock
  for (let i = 0; i < (opts.steps ?? 2); i++) g.step();
  const errs = g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`);
  const logs = g.logs.map((l) => l.text).filter((l) => !l.startsWith("[validate]"));
  return { g, errs, logs };
}
const PRE = `
local fails = 0
local function check(name, c, extra) if c then print("ok " .. name) else fails += 1 print("FAIL " .. name .. " " .. tostring(extra)) end end
local function eq(name, a, b) check(name, a == b, tostring(a) .. " ~= " .. tostring(b)) end
local function near(name, a, b, tol) check(name, math.abs(a - b) <= tol, tostring(a) .. " !~ " .. tostring(b)) end
local Racing = require("@kit/racing")
-- a tall portrait loop (cells): 10 x 22 grid, road half-width 1.5 tiles
local OVAL = { name = "oval", tileSize = 64, width = 1.5, laps = 2, checkpoints = 4,
  line = { {3,3}, {7,3}, {8,4}, {8,18}, {7,19}, {3,19}, {2,18}, {2,4} } }
`;
const noFails = (r: { errs: string[]; logs: string[] }) => {
  expect(r.errs).toEqual([]);
  expect(r.logs.filter((l) => l.startsWith("FAIL"))).toEqual([]);
  expect(r.logs.filter((l) => l.startsWith("ok ")).length).toBeGreaterThan(0);
};
const logged = (r: { logs: string[] }, prefix: string) => r.logs.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));

describe("racing kit: sim", () => {
  it("track: rasterize, closest/pointAt, surfaces, walls, gates", async () => {
    const r = await run(PRE + `
      local tr = Racing.track.new(OVAL)
      check("rows", tr.rowCount >= 22, tr.rowCount) check("cols", tr.cols >= 10, tr.cols)
      eq("gates", #tr.gates, 4)
      local x, y = tr:pointAt(100)
      local seg, s, lat = tr:closest(x, y)
      near("closest s", s, 100, 0.5) near("lat 0", lat, 0, 0.5)
      eq("road at line", tr:tileAt(x, y) == "=" or tr:tileAt(x, y) == "F", true)
      check("wall at edge", tr:solidAt(5, 5))
      check("offroad off the line", tr:surface(x, y + 2.5 * 64).offroad or tr:surface(x, y - 2.5 * 64).offroad)
      local nx, ny, d = tr:collide(10, 200, 18)
      check("collide pushes right", nx and nx > 0.9, nx)
    `);
    noFails(r);
  });

  it("car physics numbers: accel, top speed, braking, offroad, nitro, grip", async () => {
    const r = await run(PRE + `
      local st = Racing.car.stats({ maxSpeed = 500, accel = 400, brake = 1000 })
      local c = Racing.car.new(st, 0, 0, 0)
      local dt, t = 1/60, 0
      while c:speed() < 0.9 * 500 and t < 10 do c:step(dt, { throttle = 1 }) t += dt end
      print("t90 " .. string.format("%.2f", t))
      check("0-90% in 1.5..3s", t > 1.5 and t < 3, t)
      for i = 1, 600 do c:step(dt, { throttle = 1 }) end
      near("top speed", c:speed(), 500, 2)
      check("moved up (heading 0 = -y)", c.y < -1000, c.y)
      local y0 = c.y
      while c:speed() > 1 do c:step(dt, { brake = 1 }) end
      local dist = y0 - c.y
      print("brake " .. string.format("%.1f", dist))
      near("braking distance v^2/2b", dist, 500 * 500 / 2000, 15)
      -- offroad: fake track surface
      local fake = { surface = function() return { offroad = true } end, collide = function() return nil end }
      local c2 = Racing.car.new(st, 0, 0, 0)
      for i = 1, 600 do c2:step(dt, { throttle = 1 }, fake) end
      near("offroad top = 50%", c2:speed(), 250, 3)
      local c3 = Racing.car.new(st, 0, 0, 0, { nitro = 1 })
      for i = 1, 600 do c3:step(dt, { throttle = 1 }) end
      local before = c3:speed()
      for i = 1, 60 do c3:step(dt, { throttle = 1, nitro = true }) end
      check("nitro faster", c3:speed() > before * 1.15, c3:speed())
      check("nitro drains", c3.nitro < 0.6, c3.nitro)
      -- grip: lateral velocity decays, drift keeps more of it
      local function slide(steer)
        local k = Racing.car.new(st, 0, 0, 0)
        for i = 1, 300 do k:step(dt, { throttle = 1 }) end
        local seen = false
        for i = 1, 30 do k:step(dt, { throttle = 1, steer = steer }) seen = seen or k.drifting end
        local rx, ry = Racing.util.right(k.a)
        return math.abs(k.vx * rx + k.vy * ry), seen
      end
      local gripLat = slide(0.5)
      local driftLat, drifting = slide(1)
      check("drift slides more", driftLat > gripLat * 2, driftLat .. " vs " .. gripLat)
      check("drifting flag", drifting)
      -- wall bounce
      local tr = Racing.track.new(OVAL)
      local w = Racing.car.new(st, 120, 600, -math.pi / 2)
      w.vx = -400
      local hits, maxVx = 0, -1e9
      for i = 1, 60 do local ev = w:step(dt, {}, tr) maxVx = math.max(maxVx, w.vx) if ev then for _, e in ev do if e.name == "wall" then hits += 1 end end end end
      check("wall hit event", hits >= 1) check("bounced", maxVx > 100, maxVx) check("stays out of wall", not tr:solidAt(w.x, w.y))
    `);
    noFails(r); console.log("[racing] physics:", logged(r, "t90 "), logged(r, "brake "));
  });

  it("laps + checkpoints: ordered gates count, shortcuts don't, splits + best", async () => {
    noFails(await run(PRE + `
      local tr = Racing.track.new(OVAL)
      local race = Racing.race.new(tr, { laps = 2, countdown = 0 })
      local x, y, a = tr:gridSlot(1)
      local c = Racing.car.new(Racing.car.stats({}), x, y, a)
      local r = race:add("p", c, { player = true })
      -- teleport along the line in small steps = a clean lap
      local function drive(from, to, step)
        local s = from
        while s <= to do
          local px, py, tx, ty = tr:pointAt(s)
          c.x, c.y, c.vx, c.vy = px, py, tx * step * 60, ty * step * 60
          c.a = Racing.util.heading(tx, ty)
          race:step(1/60, { p = {} })
          s += step
        end
      end
      local s0 = tr.startS0
      drive(s0 - 60, s0 + tr.length + 20, 20)
      eq("one lap", r.lap, 1)
      eq("splits recorded", #r.bestSplits, 3)
      check("best set", r.best ~= nil)
      -- shortcut: jump from just after the line straight to before the line (skip checkpoints)
      local px, py = tr:pointAt(s0 + 40) c.x, c.y, c.vx, c.vy = px, py, 0, 0 race:step(1/60, { p = {} })
      px, py = tr:pointAt(s0 - 30) c.x, c.y = px, py race:step(1/60, { p = {} })
      drive(s0 - 20, s0 + 30, 10)
      eq("shortcut lap not counted", r.lap, 1)
      check("missed event", (r.missed or 0) >= 1, r.missed)
      check("rank progress clamped", race:rankProg(r) < 2 * tr.length, race:rankProg(r))
      -- finish the race properly
      drive(s0 + 30, s0 + 2 * tr.length + 10, 20)
      eq("two laps", r.lap, 2) check("finished", r.finished) eq("place", r.place, 1) check("done", race.done)
    `));
  });

  it("AI completes laps (oval), rubber band stays within bounds, positions", async () => {
    const r = await run(PRE + `
      local D = Racing.driver
      local lo, hi = 9, 0
      for gap = -3000, 3000, 50 do local m = D.rubber(gap) lo = math.min(lo, m) hi = math.max(hi, m) end
      near("rubber min", lo, 0.92, 1e-9) near("rubber max", hi, 1.08, 1e-9)
      check("ahead slows", D.rubber(500) < 1) check("behind speeds", D.rubber(-500) > 1) eq("even", D.rubber(0), 1)
      local tr = Racing.track.new(OVAL)
      local race = Racing.race.new(tr, { laps = 2, countdown = 0 })
      for i, p in { "easy", "normal", "hard", "expert" } do
        local x, y, a = tr:gridSlot(i)
        race:add(p, Racing.car.new(Racing.car.stats({}), x, y, a), { driver = D.new({ preset = p, seed = i }) })
      end
      local t = 0
      while not race.done and t < 200 do race:step(1/30) t += 1/30 end
      check("race done", race.done, t)
      for _, res in race:results() do print("ai " .. res.id .. " " .. res.place .. " " .. Racing.time(res.time) .. " best " .. Racing.time(res.best)) end
      local b = Racing.balance.report(tr, Racing.car.stats({}), { laps = 2 })
      for _, k in { "reference", "easy", "normal", "hard", "expert" } do
        check("bal finished " .. k, b[k].finished)
        print("bal " .. k .. " " .. string.format("%.2f", b[k].best or -1) .. " ratio " .. tostring(b[k].ratio and string.format("%.3f", b[k].ratio)) .. " walls " .. b[k].walls)
      end
      check("easy slower than hard", b.easy.best > b.hard.best)
      -- elimination: last place is knocked out each time the leader completes a lap
      local el = Racing.race.new(tr, { laps = 4, countdown = 0, mode = "elimination" })
      for i, p in { "easy", "normal", "hard", "expert" } do
        local x, y, a = tr:gridSlot(i)
        el:add(p, Racing.car.new(Racing.car.stats({}), x, y, a), { driver = D.new({ preset = p, seed = i }) })
      end
      local outs = 0
      t = 0
      while not el.done and t < 300 do for _, e in el:step(1/30) do if e.name == "eliminated" then outs += 1 end end t += 1/30 end
      eq("3 eliminated", outs, 3) check("elim done", el.done)
      local winner = el:results()[1]
      check("winner not out", not winner.out, winner.id) print("elim winner " .. winner.id)
    `);
    console.log(logged(r, "ai ").concat(logged(r, "bal ")).join("\n"));
    noFails(r);
  });

  it("cup points + standings, ghost record/replay/save, garage upgrades", async () => {
    noFails(await run(PRE + `
      local cup = Racing.cup.new({ id = "c", tracks = { "a", "b", "c" } }, { "p", "x", "y", "z" })
      eq("first track", cup:track(), "a")
      cup:record({ "x", "p", "y", "z" }) cup:record({ "p", "x", "z", "y" }) cup:record({ "p", "y", "x", "z" })
      check("done", cup:isDone())
      local st = cup:standings()
      eq("leader", st[1].id, "p") eq("leader pts", st[1].points, 7 + 10 + 10) eq("2nd", st[2].id, "x") eq("2nd pts", 10 + 7 + 5, st[2].points)
      -- ghost
      local rec = Racing.ghost.recorder(0.1)
      local fake = { x = 0, y = 0, a = 0 }
      for i = 0, 100 do fake.x = i * 5 fake.y = -i * 2 fake.a = i * 0.01 rec:add(i / 60, fake) end
      local g = rec:finish(100 / 60)
      local gx, gy = Racing.ghost.at(g, 0.55)
      near("ghost x interp", gx, 0.55 * 60 * 5, 1.5) near("ghost y interp", gy, -0.55 * 60 * 2, 1.5)
      check("ghost past end nil", Racing.ghost.at(g, 99) == nil)
      check("submit first", Racing.ghost.submit("oval", g))
      local slower = rec:finish(5)
      check("slower rejected", not Racing.ghost.submit("oval", slower))
      eq("best kept", Racing.ghost.best("oval").t, g.t)
      check("ghost compact", #save.get("racing_ghost_oval").d <= 3 * 18, #g.d)
      -- garage
      local core = require("@kit/core")
      core.wallet.define("coins", { start = 1000 })
      local gar = Racing.garage.new({ cars = { bug = { name = "Bug", stats = { maxSpeed = 500 } }, gt = { name = "GT", price = 800, stats = { maxSpeed = 620 }, unlock = { flag = "cup_won" } } } })
      eq("starter owned", gar:owns("bug"), true)
      local ok, why = gar:canBuy("gt") eq("locked", why, "locked")
      core.flags.set("cup_won", true)
      check("buy gt", gar:buy("gt")) eq("paid", core.wallet.get("coins"), 200)
      eq("engine cost L0", gar:upgradeCost("gt", "engine"), 150)
      core.wallet.add("coins", 10000)
      check("upgrade", gar:upgrade("gt", "engine")) eq("engine cost L1", gar:upgradeCost("gt", "engine"), 240)
      near("stats +4%", gar:stats("gt").maxSpeed, 620 * 1.04, 1e-6)
      for i = 1, 4 do gar:upgrade("gt", "engine") end
      eq("max", gar:upgradeCost("gt", "engine"), nil)
      local _, w2 = gar:upgrade("gt", "engine") eq("max reason", w2, "max")
      near("stats +20%", gar:stats("gt").maxSpeed, 620 * 1.2, 1e-6)
      check("select", gar:select("gt")) eq("selected", gar.selected, "gt")
      check("rating 0..1", gar:rating("gt").speed > 0 and gar:rating("gt").speed <= 1)
    `));
  });
});

async function examplePkg(extra: Record<string, string> = {}) {
  const base = await Package.fromDir(EXAMPLE);
  const files: Record<string, Uint8Array | string> = {};
  for (const p of base.paths()) files[p] = base.bytes(p)!;
  return Package.fromFiles({ ...files, ...extra });
}

describe("racing kit: example (Sprout Speedway)", () => {
  it("content files match the kit schemas (keys + required)", () => {
    for (const [kind, sc] of [["tracks", "track"], ["cars", "car"], ["cups", "cup"]] as const) {
      const schema = JSON.parse(readFileSync(join(__dirname, `../../../kits/racing/schemas/${sc}.schema.json`), "utf8"));
      for (const f of readdirSync(join(EXAMPLE, "data", kind))) {
        const d = JSON.parse(readFileSync(join(EXAMPLE, "data", kind, f), "utf8"));
        for (const k of Object.keys(d)) expect(Object.keys(schema.properties), `${kind}/${f}: ${k}`).toContain(k);
        for (const r of schema.required) expect(d, `${kind}/${f} requires ${r}`).toHaveProperty(r);
      }
    }
  });

  it("every example track: AI presets finish, balance vs reference bot", async () => {
    const pkg = await examplePkg({ "scripts/client/__t.luau": `
      local Racing = require("@kit/racing")
      local C = Racing.content.load()
      local cars = C.cars
      for _, id in { "pea_patch", "teapot_turns", "greenhouse" } do
        local tr = Racing.track.new(C.tracks[id])
        local st = Racing.car.stats(cars.beetle_buggy)
        local b = Racing.balance.report(tr, st, { laps = 2 })
        local line = id
        for _, k in { "reference", "easy", "normal", "hard", "expert" } do
          local r = b[k]
          line ..= string.format(" %s=%s%s/w%d/m%d", k, if r.best then string.format("%.2f", r.best) else "DNF", if r.ratio then string.format("(x%.3f)", r.ratio) else "", r.walls, r.missed)
          if not r.finished or r.missed > 0 then print("FAIL " .. id .. " " .. k) end
        end
        print("BAL " .. line)
      end
    `, "scenes/menu.scene.json": JSON.stringify({ format: "0", root: "w", entities: { w: { type: "Node2D" } } }) });
    const g = await Game.load(pkg, { budgetMs: 20000 });
    g.step();
    const logs = g.logs.map((l) => l.text);
    console.log(logs.filter((l) => l.startsWith("BAL")).join("\n"));
    expect(g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
    expect(logs.filter((l) => l.startsWith("FAIL"))).toEqual([]);
    expect(logs.filter((l) => l.startsWith("BAL")).length).toBe(3);
  }, 60000);

  it("menu + garage boot clean; a full autopilot cup (3 races) and a time trial run with zero script errors", async () => {
    const menu = await simulate(await examplePkg(), [{ t: 1, tap: [360, 1140] }], 3);
    expect(menu.loadError).toBeUndefined();
    expect(menu.errors).toEqual([]);
    const driver = `
      local G = require("../shared/game")
      local core = require("@kit/core")
      local last = nil
      loadScene("scenes/race.scene.json", { mode = "cup", autopilot = true })
      every(0.5, function()
        if not G.cup then return end
        if last == nil then last = G.cup.race end
        if G.cup.race ~= last then
          last = G.cup.race
          print("RACE_DONE " .. math.floor(time()) .. " pts " .. (G.cup.table.you or 0) .. " coins " .. core.wallet.get("coins"))
          if G.cup.race <= 3 then after(1, function() loadScene("scenes/race.scene.json", { mode = "cup", autopilot = true }) end)
          else after(1, function() loadScene("scenes/race.scene.json", { mode = "time_trial", track = "pea_patch", autopilot = true }) end) end
        end
      end)
    `;
    const save = new MemorySaveHost();
    const lb = new MemoryLeaderboardHost();
    const g = await Game.load(await examplePkg({ "scripts/client/__drive.luau": driver }), { save, leaderboard: lb, budgetMs: 2000 });
    const done = () => g.logs.filter((l) => l.text.startsWith("RACE_DONE")).length;
    for (let i = 0; i < 60 * 60 * 8 && done() < 3; i++) g.step();
    for (let i = 0; i < 60 * 80; i++) g.step(); // time trial (3 laps) after the cup
    const errs = g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`);
    console.log(g.logs.filter((l) => l.text.startsWith("RACE_DONE")).map((l) => l.text).join("\n"));
    expect(errs).toEqual([]);
    expect(done()).toBe(3);
    const ghost = JSON.stringify(save.data).includes("racing_ghost_pea_patch");
    expect(ghost).toBe(true); // the autopilot time trial recorded + saved its best-lap ghost
    expect(JSON.stringify(save.data)).toContain("garage");
    // platform leaderboard: every finished race (3 cup races + the time trial) submitted a time on its track board
    expect(lb.submitted.length).toBe(4);
    expect(lb.submitted.every((r) => /^track_[a-z_]+$/.test(r.board) && r.order === "asc" && r.value > 5 && (r.ghost?.frames.length ?? 0) > 10)).toBe(true);
    expect(lb.submitted[3]!.board).toBe("track_pea_patch");
  }, 120000);
});
