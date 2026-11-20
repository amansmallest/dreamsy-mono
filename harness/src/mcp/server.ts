// MCP over stdio (npx dreamsy-mcp). The hosted version is http.ts.
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { linkedGame, linkGame, localCloud } from "../cloud.js";
import { loadEnv } from "../env.js";
import { createServer } from "./tools.js";

loadEnv();

const root = resolve(process.env.DREAMSY_GAMES_DIR ?? process.cwd());
const server = createServer({ root, cloud: () => localCloud(), links: { get: linkedGame, set: linkGame } });
await server.connect(new StdioServerTransport());
console.error(`dreamsy mcp: games in ${root}`);
