// Headless playtest: every package under games/examples and games/showcase, core only (no DOM).
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game, GameLoadError } from "../core/index.js";

const GAMES = resolve(__dirname, "../../games");
const dirs = ["examples", "showcase"].flatMap((g) => {
  const root = join(GAMES, g);
  return existsSync(root) ? readdirSync(root).map((d) => join(root, d)).filter((d) => existsSync(join(d, "dreamsy.toml"))) : [];
});

describe("headless playtest", () => {
  for (const dir of dirs) {
    const name = dir.slice(GAMES.length + 1);
    it(name, async () => {
      const pkg = await Package.fromDir(dir);
      let game: Game;
      try {
        game = await Game.load(pkg, { seed: 7 });
      } catch (e) {
        if (e instanceof GameLoadError && /3D games are not supported/.test(e.message)) {
          console.log(`${name}: skipped (${e.message})`);
          return;
        }
        throw e;
      }
      const avatar = game.avatar();
      const start = avatar ? [...avatar.get<number[]>("position")] : null;
      const startCount = game.world.count;
      const buttons = [...game.world.walk()].filter((e) => e.type === "UIButton").map((e) => e.id);
      let maxX = start?.[0] ?? 0;
      for (let i = 0; i < 300; i++) {
        game.input.setAxis("move_x", 1);
        game.input.setButton("jump", i % 40 < 6);
        // tap-driven games: press every visible button once, spread over the run
        if (i % 20 === 10 && buttons.length) game.press(buttons[(i / 20) | 0 % buttons.length]!);
        if (i === 150) game.tapWorld(game.currentCamera2D()?.get<number[]>("position")[0] ?? 0, game.currentCamera2D()?.get<number[]>("position")[1] ?? 0);
        game.step();
        if (avatar?.alive) maxX = Math.max(maxX, avatar.get<number[]>("position")[0]!);
      }
      const hud = [...game.world.walk()].filter((e) => e.type === "UIText" && game.effectiveVisible(e)).map((e) => `${e.id}=${JSON.stringify(e.get("text"))}`);
      console.log(
        `${name}: entities ${startCount} → ${game.world.count}, ticks ${game.tick}, ` +
          (start ? `avatar ${start.map((n) => n.toFixed(0))} → ${avatar!.get<number[]>("position").map((n) => n.toFixed(0))} (max x ${maxX.toFixed(0)}), ` : "no avatar, ") +
          `mem ${(game.memoryUsed() / 1024).toFixed(0)}KB\n  HUD: ${hud.join(" ")}` +
          (game.errors.length ? `\n  ERRORS:\n${game.errors.map((e) => `    ${e.script}:${e.line ?? "?"}: ${e.message} (x${e.count})`).join("\n")}` : ""),
      );
      expect(game.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
      if (start) expect(maxX).toBeGreaterThan(start[0]! + 20);
      game.dispose();
    });
  }
});
