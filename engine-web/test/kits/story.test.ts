// story kit (engine-web/kits/story): parser, branching/conditions/effects, gated choices, save/load mid-scene,
// endings gallery, hotspots + item use + combine, deduction boards, and the example package end-to-end.
import { resolve, join, relative } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game, MemorySaveHost } from "../../core/index.js";
import { simulate } from "../../tools/playtest.js";

const EXAMPLE = resolve(__dirname, "../../../games/examples/kit-story");
const scene = JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } });

const SCRIPT = `
# test story
@chapter one "Chapter One"
@label start
@bg dock fade
@show mira smile left
Mira: Hello, {$name}.
The fog rolls in.
Mira (sad): It's cold.
@set name = Ash
@add trust 2
@aff mira 3
@if trust >= 2 and not cursed
  > Trust is high.
@elseif cursed
  > Cursed.
@else
  > Low.
@endif
* Open the box -> box {if has key}
* Ask about the lamp -> lamp {req aff mira >= 5} {hint Needs more trust}
* Wait {set waited} {once}
* Leave -> leave
@label after_wait
> You waited.
@goto choose2

@label box
> The box opens.
@goto choose2

@label lamp
> The lamp.
@goto choose2

@label leave
@end bad "Walked Away"

@label choose2
* Visit the shed -> shed
* Think {once} -> think

@label think
> Hmm, {$name}.
@call sub
> Back from sub.
@goto choose2

@label sub
> In sub.
@return

@label shed
@explore shed
@label shed_out
@clue knife_mark
@deduce who
@label solved
@cg finale
@if aff mira >= 3
@end good
@endif
@end bad

@label shed_crate
> You pry at the crate.
@set pried
@return
`;

const CONFIG = {
  start: "start",
  characters: { mira: { name: "Mira", color: "#e88", default: "neutral", expressions: { neutral: "asset:mira_n", smile: "asset:mira_s", sad: "asset:mira_sad" }, affection: { min: 0, max: 10 } } },
  endings: { good: { title: "Lamp Lit", order: 1 }, bad: { title: "Dark Shore", order: 2 } },
  cgs: { finale: { image: "asset:cg_finale" } },
  clues: { knife_mark: { name: "Knife mark" }, wet_boots: { name: "Wet boots" }, logbook: { name: "Logbook" } },
  combine: [{ items: ["rope", "hook"], result: "grapple", text: "You tie the hook to the rope." }],
};
const ROOM = {
  name: "Shed", background: "asset:bg_shed",
  hotspots: [
    { id: "boots", name: "Boots", rect: [10, 10, 100, 100], look: "Wet boots.", clue: "wet_boots" },
    { id: "rope", name: "Rope", rect: [120, 10, 100, 100], take: "rope", look: "A coil of rope." },
    { id: "crate", name: "Crate", rect: [240, 10, 100, 100], look: "@shed_crate" },
    { id: "lock", name: "Lock", rect: [10, 200, 100, 100], look: "A rusty padlock.", use: { grapple: { text: "It pulls free!", effects: ["set lock_open", "clue logbook"], consume: true, remove: true }, "*": { text: "Nope." } } },
    { id: "door", name: "Door", rect: [240, 200, 100, 100], "if": "lock_open", go: "shed_out" },
  ],
};
const BOARD = {
  title: "Who?", links: [
    { id: "climbed", clues: ["wet_boots", "knife_mark"], text: "Someone came by boat." },
    { id: "wrote", clues: ["logbook", "knife_mark"], text: "The keeper lied." },
  ],
  question: { text: "Who did it?", options: [{ text: "Mira" }, { text: "The keeper", correct: true }] },
  mistakes: 3, solved: "solved", failed: "leave",
};

function files(extra: Record<string, string> = {}) {
  return {
    "data/story/01_main.story.txt": SCRIPT,
    "data/story/story.json": JSON.stringify(CONFIG),
    "data/story/rooms/shed.json": JSON.stringify(ROOM),
    "data/story/boards/who.json": JSON.stringify(BOARD),
    "data/items/key.json": JSON.stringify({ name: "Key" }),
    "data/items/rope.json": JSON.stringify({ name: "Rope" }),
    "data/items/hook.json": JSON.stringify({ name: "Hook" }),
    "data/items/grapple.json": JSON.stringify({ name: "Grapple" }),
    ...extra,
  };
}
function pkg(script: string, extra: Record<string, string> = {}) {
  return Package.fromFiles({
    "dreamsy.toml": `format = "0"\nname = "K"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/main.scene.json"\nkits = ["story"]\n`,
    "scenes/main.scene.json": scene,
    "scripts/client/main.luau": script,
    ...files(extra),
  });
}
const PRE = `
local fails = 0
local function check(name, c, extra) if c then print("ok " .. name) else fails += 1 print("FAIL " .. name .. " " .. tostring(extra)) end end
local function eq(name, a, b) check(name, a == b, tostring(a) .. " ~= " .. tostring(b)) end
local Story = require("@kit/story")
local core = require("@kit/core")
core.setup({})
Story.setup()
local function texts(ev) local t = {} for _, o in ev.options do table.insert(t, o.text .. (if o.locked then "#" else "")) end return table.concat(t, "|") end
`;
async function run(body: string, opts: { save?: MemorySaveHost; steps?: number } = {}) {
  const g = await Game.load(pkg(PRE + body + `\nprint("fails " .. fails)`), { save: opts.save ?? new MemorySaveHost() });
  for (let i = 0; i < (opts.steps ?? 1); i++) g.step();
  const errs = g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`);
  const logs = g.logs.map((l) => l.text);
  const fails = logs.filter((l) => l.startsWith("FAIL") || l.startsWith("[story]"));
  return { g, errs, logs, fails };
}
const ok = (r: Awaited<ReturnType<typeof run>>) => {
  if (r.errs.length || r.fails.length) console.log(r.errs, r.fails);
  expect(r.errs).toEqual([]);
  expect(r.fails).toEqual([]);
  expect(r.logs.some((l) => l === "fails 0")).toBe(true);
};

describe("story kit: parser", () => {
  it("parses labels, chapters, dialog, narration, choices, if-blocks, expressions", async () => {
    ok(await run(`
      local P = Story.parse
      local prog = Story.story.prog
      check("labels", prog.labels.start ~= nil and prog.labels.shed_crate ~= nil)
      eq("chapters", #prog.chapters, 1) eq("chapter title", prog.chapters[1].title, "Chapter One")
      eq("no problems", #Story.validate(), 0)
      -- expressions
      local e = P.expr("trust >= 2 and not cursed or has key 2")
      check("or", e.any ~= nil) check("and", e.any[1].all ~= nil)
      eq("gte", e.any[1].all[1].gte, 2) eq("not", e.any[1].all[2]["not"].flag, "cursed")
      eq("has", e.any[2].item, "key") eq("has n", e.any[2].count, 2)
      eq("aff", P.expr("aff mira > 4").flag, "aff_mira") eq("aff gt", P.expr("aff mira > 4").gt, 4)
      eq("clue", P.expr("clue knife").storyClue, "knife")
      eq("string eq", P.expr('name == "Ash Grey"').eq, "Ash Grey")
      eq("paren", #P.expr("(a or b) and c").all, 2)
      local okp = pcall(P.expr, "a and (b")
      check("bad expr errors", not okp)
      -- dialog/narration detection
      local p2 = P.parse("Mira: hi\\nThe end. Really: yes\\n> Mira: not dialog\\nOld Man (angry): Get out!\\n* A -> x {if f} {set g}\\n* B")
      eq("say speaker", p2.ops[1].speaker, "Mira")
      eq("narr with colon", p2.ops[2].speaker, nil)
      eq("forced narr", p2.ops[3].text, "Mira: not dialog")
      eq("expr", p2.ops[4].expr, "angry") eq("multiword", p2.ops[4].speaker, "Old Man")
      eq("choice block", #p2.ops[5].options, 2)
      eq("choice target", p2.ops[5].options[1].target, "x")
      eq("choice cond", p2.ops[5].options[1].cond.flag, "f")
      eq("choice effect", p2.ops[5].options[1].effects[1].name, "set")
      local bad = P.finish(P.parse("@goto nowhere"))
      eq("unknown label reported", #bad, 1)
      check("unclosed if errors", not pcall(P.parse, "@if x\\nhello"))
      check("words", Story.words() > 20)
    `));
  });
});

describe("story kit: VM", () => {
  it("branching, interpolation, effects, gated + once choices, call/return", async () => {
    ok(await run(`
      local vm = Story.start()
      local ev = Story.step()
      eq("say", ev.text, "Hello, .") eq("speaker name", ev.speaker, "Mira") eq("expr", ev.expr, "smile")
      eq("bg", Story.stage().bg, "dock") eq("shown", Story.stage().chars.mira.pos, "left")
      eq("chapter", vm.chapter, "one")
      ev = Story.step() eq("narr", ev.speaker, nil)
      ev = Story.step() eq("expr change", Story.stage().chars.mira.expr, "sad")
      ev = Story.step() eq("if branch", ev.text, "Trust is high.")
      eq("flag str", core.flags.get("name"), "Ash") eq("aff", Story.affection("mira"), 3)
      ev = Story.step()
      eq("choice kind", ev.kind, "choice")
      eq("gated", texts(ev), "Ask about the lamp#|Wait|Leave")
      check("locked refuses", not Story.choose(1))
      Story.choose(2)
      ev = Story.step() eq("fallthrough", ev.text, "You waited.")
      eq("effect", core.flags.get("waited"), true)
      ev = Story.step() eq("choose2", texts(ev), "Visit the shed|Think")
      Story.choose(2)
      ev = Story.step() eq("interp", ev.text, "Hmm, Ash.")
      ev = Story.step() eq("sub", ev.text, "In sub.")
      ev = Story.step() eq("returned", ev.text, "Back from sub.")
      ev = Story.step() eq("once hidden", texts(ev), "Visit the shed")
      -- the key unlocks the box choice; aff clamps to max
      Story.start()
      core.bag:add("key", 1)
      for i = 1, 4 do Story.step() end
      eq("has key shows", texts(Story.step()), "Open the box|Ask about the lamp#|Wait|Leave")
      vm:affection("mira", 50) eq("clamped", Story.affection("mira"), 10)
      eq("unlocked", texts(Story.event()), "Open the box|Ask about the lamp#|Wait|Leave")
      Story.choose(1)
      eq("box", Story.step().text, "The box opens.")
      eq("backlog choice", Story.backlog()[#Story.backlog() - 1].text, "Open the box")
      eq("backlog say", Story.backlog()[#Story.backlog()].text, "The box opens.")
    `));
  });

  it("save/load mid-scene restores position, stage, flags, items and backlog", async () => {
    const save = new MemorySaveHost();
    ok(await run(`
      Story.start()
      Story.step() Story.step()
      core.bag:add("key", 1)
      local ev = Story.step()
      eq("before", ev.text, "It's cold.")
      local n = #Story.backlog()
      check("saved", Story.save("2"))
      Story.step() Story.step()
      Story.start()
      eq("reset bag", core.bag:count("key"), 0)
      check("loaded", Story.load("2"))
      eq("bag back", core.bag:count("key"), 1)
      ev = Story.step()
      eq("same line", ev.text, "It's cold.")
      eq("backlog not duplicated", #Story.backlog(), n)
      eq("stage", Story.stage().chars.mira.expr, "sad")
      eq("next", Story.step().text, "Trust is high.")
      local slots = Story.slots(3)
      check("slot2 exists", slots[2].exists) check("slot1 empty", not slots[1].exists)
      eq("slot meta", slots[2].chapter, "Chapter One")
      -- save at a choice, load, choose
      Story.step()
      Story.save("3")
      Story.start()
      Story.load("3")
      eq("choice again", Story.step().kind, "choice")
      check("choose after load", Story.choose(3))
    `, { save }));
  });

  it("endings gallery persists across new games and reloads", async () => {
    const save = new MemorySaveHost();
    ok(await run(`
      Story.start()
      local r = Story.autoplay({ pick = function(opts) for i, o in opts do if o.text == "Leave" then return i end end return nil end })
      eq("ending", r.ending, "bad")
      local list = Story.endings()
      eq("gallery order", list[1].id, "good") eq("good unseen", list[1].seen, false) eq("bad seen", list[2].seen, true)
      Story.start()
      check("persists newGame", Story.gallery():hasEnding("bad"))
      check("ending condition", core.check(Story.parse.expr("ending bad")))
    `, { save }));
    // second boot with the same save host: gallery still there
    ok(await run(`check("persisted", Story.endings()[2].seen) check("not good", not Story.endings()[1].seen)`, { save }));
  });

  it("point-and-click: hotspots, take, examine scripts, item use, combine, exits", async () => {
    ok(await run(`
      Story.start("shed")
      local ev = Story.step()
      eq("explore", ev.kind, "explore") eq("room", ev.room, "shed")
      local room = Story.room()
      eq("visible", #room:hotspots(), 4)
      local r = Story.tap("boots")
      eq("look", r.lines[1], "Wet boots.") check("clue", core.check(Story.parse.expr("clue wet_boots")))
      r = Story.tap("rope")
      eq("took", r.took, "rope") eq("rope in bag", core.bag:count("rope"), 1) eq("rope gone", #room:hotspots(), 3)
      r = Story.tap("lock", "rope") eq("wrong item", r.lines[1], "Nope.")
      r = Story.tap("lock", "key") eq("wildcard", r.lines[1], "Nope.")
      core.bag:add("hook", 1)
      r = Story.combine("rope", "hook")
      check("combined", r.ok) eq("grapple", core.bag:count("grapple"), 1) eq("rope used", core.bag:count("rope"), 0)
      check("bad combine", not Story.combine("grapple", "key").ok)
      r = Story.tap("lock", "grapple")
      eq("use", r.lines[1], "It pulls free!") check("flag", core.flags.get("lock_open")) eq("consumed", core.bag:count("grapple"), 0)
      check("logbook clue", core.check({ storyClue = "logbook" }))
      -- examine runs a script and comes back to the room
      r = Story.tap("crate")
      eq("call", r.call, "shed_crate")
      eq("script line", Story.step().text, "You pry at the crate.")
      eq("back in room", Story.step().kind, "explore")
      check("pried", core.flags.get("pried"))
      -- lock removed, door visible
      local ids = {} for _, h in Story.room():hotspots() do table.insert(ids, h.id) end
      eq("hotspots now", table.concat(ids, ","), "boots,crate,door")
      r = Story.tap("door")
      eq("exit", r.jump, "shed_out")
      ev = Story.step()
      eq("deduce", ev.kind, "deduce") eq("board", ev.board, "who")
    `));
  });

  it("deduction board: connect clues → conclusions, mistakes, final question, solved/failed", async () => {
    ok(await run(`
      Story.start("shed_out")
      local ev = Story.step()
      eq("deduce", ev.kind, "deduce")
      local vm = Story.vm
      vm:addClue("wet_boots") vm:addClue("logbook")
      local b = Story.board()
      eq("clues", #b:clues(), 3)
      local r = Story.connect("wet_boots", "logbook")
      check("wrong", not r.ok) eq("mistake", r.mistakes, 1)
      r = Story.connect("knife_mark", "wet_boots")
      check("right", r.ok) eq("text", r.link.text, "Someone came by boat.")
      check("again", Story.connect("wet_boots", "knife_mark").again)
      eq("still linking", b:status(), "linking")
      check("cannot answer yet", not Story.answer(2).ok)
      r = Story.connect("logbook", "knife_mark")
      eq("question", Story.board():status(), "question")
      check("found cond", core.check({ storyConclusion = "wrote" }))
      r = Story.answer(1) check("wrong answer", not r.ok)
      r = Story.answer(2) check("solved", r.solved) eq("goto", r.jump, "solved")
      check("solved cond", core.check(Story.parse.expr("solved who")))
      ev = Story.step()
      eq("cg seen", Story.cgs()[1].seen, true)
      eq("ending", ev.kind, "end") eq("bad (aff low)", ev.ending.id, "bad")
      -- failing: 3 mistakes → failed label
      Story.start("shed_out") Story.step()
      Story.connect("a", "b") Story.connect("a", "c")
      r = Story.connect("b", "c")
      check("failed", r.failed) eq("fail goto", r.jump, "leave")
      eq("fail ending", Story.step().ending.id, "bad")
    `));
  });

  it("full autoplay reaches the good ending with rooms + boards solved by a bot", async () => {
    ok(await run(`
      Story.start()
      core.bag:add("hook", 1)
      local r = Story.autoplay({
        pick = function(opts, vm) for i, o in opts do if o.text == "Visit the shed" then return i end end return nil end,
        room = function(S)
          S.tap("boots") S.tap("rope") S.combine("rope", "hook") S.tap("lock", "grapple") S.tap("door")
        end,
        board = function(S) S.connect("wet_boots", "knife_mark") S.connect("logbook", "knife_mark") S.answer(2) end,
      })
      eq("good", r.ending, "good")
    `));
  });
});

// ---------- example ----------
function loadDir(dir: string) {
  const out: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split("\\").join("/")] = readFileSync(p);
    }
  };
  walk(dir);
  return Package.fromFiles(out);
}

describe("story kit: example (Lanternlight)", () => {
  it("validates, has both endings reachable by autoplay bots", async () => {
    const p = loadDir(EXAMPLE);
    const f: Record<string, Uint8Array | string> = {};
    for (const path of p.paths()) f[path] = p.bytes(path)!;
    for (const path of Object.keys(f)) if (/^scripts\/client\//.test(path)) delete f[path];
    f["scenes/main.scene.json"] = scene;
    f["scripts/client/t.luau"] = `
      local Story = require("@kit/story")
      local core = require("@kit/core")
      local G = require("../shared/game")
      G.init()
      local probs = Story.validate()
      for _, p in probs do print("PROBLEM " .. p) end
      print("words " .. Story.words() .. " chapters " .. #Story.chapters())
      local endings = {}
      for _, mode in { "kind", "cold" } do
        Story.start()
        local r = Story.autoplay(G.bot(mode))
        print("ending " .. mode .. " " .. tostring(r.ending or r.stuck) .. " lines " .. r.lines)
        endings[mode] = r.ending
      end
      print("distinct " .. tostring(endings.kind ~= nil and endings.cold ~= nil and endings.kind ~= endings.cold))
    `;
    const g = await Game.load(Package.fromFiles(f), { save: new MemorySaveHost() });
    g.step();
    const logs = g.logs.map((l) => l.text);
    console.log(logs.join("\n"));
    expect(g.errors.map((e) => e.message)).toEqual([]);
    expect(logs.filter((l) => l.startsWith("PROBLEM"))).toEqual([]);
    expect(logs).toContain("distinct true");
  });

  it("plays end-to-end headless with zero script errors (reading, choices, room, board, menu)", async () => {
    const p = loadDir(EXAMPLE);
    const timeline = [
      { t: 1.0, tap: [360, 760] as [number, number] }, // title: New game
      // alternate text-box taps (advance) with taps where the last choice button sits
      ...Array.from({ length: 140 }, (_, i) => ({ t: 2 + i * 0.4, tap: [360, i % 2 === 0 ? 1080 : 800] as [number, number] })),
    ];
    const r = await simulate(p, timeline, 62);
    if (r.errors.length) console.log(r.errors);
    console.log((r.dialogLog ?? []).slice(0, 5), r.logs.slice(-8), r.audio);
    expect(r.loadError).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.audio.music).toContain("mystery"); // reached the boathouse (point-and-click) through 3 choices
    expect(Object.keys(r.save ?? {})).toContain("lanternlight_story_auto"); // @autosave
  });
});
