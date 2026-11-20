// The Dreamsy MCP server over stdio (npx dreamsy-mcp, Claude Code, Cursor…): games are folders under
// DREAMSY_GAMES_DIR (default: the working directory). The hosted version is http.ts (dreamsy.dev/mcp).
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
