// The hosted MCP endpoint (src/mcp/http.ts): sessions over Streamable HTTP, each with its own workspace.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

const dir = mkdtempSync(join(tmpdir(), "dreamsy-mcp-http-"));
process.env.DREAMSY_MCP_DIR = dir;
process.env.DREAMSY_CLOUD = "0";
process.env.PLAYTEST_BROWSER = "0";

let http: Server;
let url: URL;
let closeAll: () => Promise<void>;

async function connect() {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(url));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await c.callTool({ name, arguments: args })) as ToolResult;
    return { ok: !r.isError, text: r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n") };
  };
  return { c, call };
}

describe("hosted MCP (Streamable HTTP)", () => {
  beforeAll(async () => {
    const mod = await import("../src/mcp/http.js");
    closeAll = mod.closeAll;
    http = createServer((req, res) => void mod.handle(req, res));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
  });
  afterAll(async () => {
    await closeAll();
    await new Promise<void>((r) => http.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("describes itself on a plain GET and answers health", async () => {
    expect((await (await fetch(url)).json()).name).toBe("dreamsy");
    expect((await (await fetch(new URL("/mcp/health", url))).json()).ok).toBe(true);
  });

  it("builds a game in a private workspace", async () => {
    const a = await connect();
    const tools = (await a.c.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["create_game", "apply_ops", "playtest", "check_game", "publish_game"]));
    expect((await a.c.listResources()).resources.map((r) => r.uri)).toContain("dreamsy://kits");
    expect(a.c.getServerVersion()?.icons?.length).toBeGreaterThan(0);

    const created = await a.call("create_game", { game: "frog-hop", name: "Frog Hop", kit: "platformer" });
    expect(created.ok, created.text).toBe(true);
    expect((await a.call("check_game", { game: "frog-hop" })).ok).toBe(true);
    expect((await a.call("game_outline", { game: "../../etc" })).ok).toBe(false);

    // Another connection can't see it.
    const b = await connect();
    expect((await b.call("game_outline", { game: "frog-hop" })).ok).toBe(false);
    expect(readdirSync(dir)).toHaveLength(2);

    await a.c.close();
    await b.c.close();
  }, 120_000);

  it("limits games per connection", async () => {
    const a = await connect();
    for (let i = 0; i < 5; i++) expect((await a.call("create_game", { game: `g${i}`, name: `G${i}` })).ok).toBe(true);
    const sixth = await a.call("create_game", { game: "g5", name: "G5" });
    expect(sixth.ok).toBe(false);
    expect(sixth.text).toMatch(/already has 5 games/);
    await a.c.close();
  }, 60_000);

  it("rejects unknown sessions and non-initialize first requests", async () => {
    const post = (headers: Record<string, string>, body: unknown) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
    expect((await post({ "mcp-session-id": "nope" }, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);
    expect((await post({}, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(400);
  });
});
