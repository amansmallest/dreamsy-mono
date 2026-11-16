import { describe, expect, it } from "vitest";
import { setKitSources } from "../core/index.js";
import { detectInputUsage } from "../input/index.js";

const fakeGame = (files: Record<string, string>) =>
  ({ pkg: { paths: (pre: string) => Object.keys(files).filter((p) => p.startsWith(pre)), text: (p: string) => files[p] } }) as never;

describe("detectInputUsage", () => {
  it("includes buttons read inside required kits (platformer jump)", () => {
    setKitSources({
      "kits/fakeplat/init.luau": 'if input.pressed("jump") then end',
      "kits/fakeplat/kit.json": '{"requires":["fakecore"]}',
      "kits/fakecore/init.luau": 'local x = input.held("action")',
    });
    const u = detectInputUsage(fakeGame({ "scripts/shared/game.luau": 'local kit = require("@kit/fakeplat")\nlocal a = input.axis("move_x")\nif input.pressed("action2") then end' }));
    expect(u.move).toBe(true);
    expect([...u.buttons].sort()).toEqual(["action", "action2", "jump"]);
  });

  it("ignores kits the game doesn't require", () => {
    const u = detectInputUsage(fakeGame({ "scripts/client/main.luau": 'if input.pressed("action2") then end' }));
    expect([...u.buttons]).toEqual(["action2"]);
  });
});

import { InputState } from "../core/input.js";
describe("InputState.onFirstRead", () => {
  it("reports each name once, the first time scripts read it", () => {
    const s = new InputState();
    const seen: string[] = [];
    s.onFirstRead = (n) => seen.push(n);
    s.pressed("jump"); s.held("jump"); s.axis("move_x"); s.pressed("action2");
    expect(seen).toEqual(["jump", "move_x", "action2"]);
    expect([...s.read]).toEqual(["jump", "move_x", "action2"]);
  });
});

describe("InputState.recentlyRead", () => {
  it("is true only while scripts keep reading the input", () => {
    const s = new InputState();
    expect(s.recentlyRead("jump")).toBe(false);
    s.pressed("jump");
    expect(s.recentlyRead("jump")).toBe(true);
    for (let i = 0; i < 46; i++) s.beginTick();
    expect(s.recentlyRead("jump")).toBe(false);
    s.rawHeld("jump");
    expect(s.recentlyRead("jump")).toBe(false);
  });
});

import { shapeStick } from "../input/index.js";
describe("shapeStick", () => {
  it("drops the small axis when the thumb clearly pushes the other way", () => {
    const [x, y] = shapeStick(0.9, 0.35);   // steering right with a thumb drifting down
    expect(x).toBeGreaterThan(0.8); expect(y).toBe(0);
    expect(shapeStick(0.1, 0.1)).toEqual([0, 0]);  // dead zone
    const [dx, dy] = shapeStick(0.6, 0.6);  // real diagonal passes through
    expect(dx).toBeGreaterThan(0.3); expect(dy).toBeGreaterThan(0.3);
    expect(shapeStick(1, 0)[0]).toBeCloseTo(1, 5);
  });
});
