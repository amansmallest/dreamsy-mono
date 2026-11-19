import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

const games = mkdtempSync(join(tmpdir(), "dreamsy-mcp-"));
const client = new Client({ name: "test", version: "0" });
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { ok: !r.isError, text: r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), images: r.content.filter((c) => c.type === "image").length };
};

describe("MCP server", () => {
  beforeAll(async () => {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(import.meta.dirname, "../src/mcp/server.ts")],
      env: { ...process.env, DREAMSY_GAMES_DIR: games, PLAYTEST_BROWSER: "0" } as Record<string, string>,
      stderr: "ignore",
    }));
  }, 30_000);
  afterAll(async () => {
    await client.close();
    rmSync(games, { recursive: true, force: true });
  });

  it("lists the engine tools and the build prompt", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["create_game", "dreamsy_guide", "apply_ops", "draw_sprite", "playtest", "check_game", "export_game"]));
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toContain("build_game");
  });

  it("creates a kit game, edits it, playtests, checks and exports it", async () => {
    expect((await call("create_game", { game: "frog", name: "Frog", kit: "platformer" })).ok).toBe(true);
    expect((await call("apply_ops", { game: "frog", reason: "rename", ops: [{ op: "set_manifest", key: "name", value: "Frog Jump" }] })).text).toMatch(/Applied 1 op/);
    expect((await call("draw_sprite", { game: "frog", id: "frog", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#4caf50"/></svg>' })).ok).toBe(true);
    expect((await call("dreamsy_guide", { game: "frog" })).text).toMatch(/^# Using this guide through MCP/);
    const run = await call("playtest", { game: "frog", seconds: 2, shots: [], timeline: [{ t: 0.5, hold: ["right"] }] });
    expect(run.ok).toBe(true);
    expect(run.text).toMatch(/No script errors/);
    expect((await call("check_game", { game: "frog" })).text).toMatch(/^Passed/);
    expect((await call("export_game", { game: "frog" })).ok).toBe(true);
    expect(existsSync(join(games, "frog.dpk"))).toBe(true);
  }, 120_000);

  it("refuses paths outside the games directory and broken ops", async () => {
    expect((await call("game_outline", { game: "../elsewhere" })).text).toMatch(/outside/);
    const bad = await call("apply_ops", { game: "frog", reason: "bad", ops: [{ op: "remove_entity", scene: "scenes/nope.scene.json", id: "x" }] });
    expect(bad.ok).toBe(false);
  });
});
