// Hosted MCP over Streamable HTTP (dreamsy.dev/mcp). Each session gets a private workspace and an anonymous
// cloud save key; the limits below keep abuse cheap. Spec: docs/harness.md §5.4.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_CLOUD_URL, type CloudConfig } from "../cloud.js";
import { loadEnv } from "../env.js";
import { repoPath } from "../paths.js";
import { createServer } from "./tools.js";

loadEnv();

const PORT = Number(process.env.DREAMSY_MCP_PORT ?? 8090);
const HOST = process.env.DREAMSY_MCP_HOST ?? "127.0.0.1";
const DIR = resolve(process.env.DREAMSY_MCP_DIR ?? repoPath(".data/mcp"));
const CLOUD_URL = process.env.DREAMSY_CLOUD === "0" ? null : (process.env.DREAMSY_CLOUD_URL?.trim() || DEFAULT_CLOUD_URL).replace(/\/$/, "");

const MAX_SESSIONS = Number(process.env.DREAMSY_MCP_MAX_SESSIONS ?? 40);
const MAX_NEW_PER_IP_HOUR = 8;
const MAX_IN_FLIGHT = 8;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_GAMES = 5;
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;

interface Session { transport: StreamableHTTPServerTransport; server: McpServer; root: string; ip: string; lastUsed: number }

const sessions = new Map<string, Session>();
const newByIp = new Map<string, number[]>();
let inFlight = 0;

mkdirSync(DIR, { recursive: true });

function clientIp(req: IncomingMessage): string {
  const h = (n: string) => (req.headers[n] as string | undefined)?.split(",")[0]?.trim();
  return h("fly-client-ip") || h("x-forwarded-for") || req.socket.remoteAddress || "?";
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (res: ServerResponse, status: number, message: string, headers?: Record<string, string>) =>
  send(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("request too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("body is not JSON"), { status: 400 });
  }
}

function admit(ip: string): string | null {
  if (sessions.size >= MAX_SESSIONS) return "Dreamsy MCP is at capacity; try again in a few minutes.";
  const now = Date.now();
  const recent = (newByIp.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= MAX_NEW_PER_IP_HOUR) return "Too many new connections from your network this hour; reuse your connection or try later.";
  recent.push(now);
  newByIp.set(ip, recent);
  return null;
}

async function openSession(ip: string): Promise<StreamableHTTPServerTransport> {
  const id = randomUUID();
  const root = join(DIR, id);
  mkdirSync(root, { recursive: true });
  const cloud: CloudConfig | null = CLOUD_URL ? { url: CLOUD_URL, saveKey: randomBytes(32).toString("base64url") } : null;
  const links = new Map<string, string>();
  const server = createServer({
    root,
    cloud: () => cloud,
    links: { get: (dir) => links.get(dir) ?? null, set: (dir, gameId) => void links.set(dir, gameId) },
    remote: { maxGames: MAX_GAMES },
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
    enableJsonResponse: true,
    onsessioninitialized: (sid) => void sessions.set(sid, { transport, server, root, ip, lastUsed: Date.now() }),
  });
  transport.onclose = () => void closeSession(id);
  await server.connect(transport);
  return transport;
}

async function closeSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  await s.server.close().catch(() => undefined);
  await rm(s.root, { recursive: true, force: true }).catch(() => undefined);
}

/** Also deletes workspaces left over from a restart. */
async function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastUsed > SESSION_IDLE_MS) await closeSession(id);
  for (const name of await readdir(DIR).catch(() => [] as string[])) {
    if (sessions.has(name)) continue;
    const st = await stat(join(DIR, name)).catch(() => null);
    if (st && now - st.mtimeMs > SESSION_IDLE_MS) await rm(join(DIR, name), { recursive: true, force: true }).catch(() => undefined);
  }
  for (const [ip, times] of newByIp) if (!times.some((t) => now - t < 3600_000)) newByIp.delete(ip);
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "mcp-session-id",
};

/** No bodies or IPs in the log. */
function logRequest(req: IncomingMessage, res: ServerResponse, rpc: string) {
  const start = Date.now();
  res.on("finish", () => {
    const sid = (req.headers["mcp-session-id"] as string | undefined)?.slice(0, 8) ?? "-";
    const ua = (req.headers["user-agent"] ?? "-").slice(0, 60);
    console.log(`mcp ${req.method} ${req.url} ${rpc || "-"} -> ${res.statusCode} ${Date.now() - start}ms sid=${sid} accept="${req.headers.accept ?? ""}" ua="${ua}"`);
  });
}

const rpcMethods = (body: unknown) =>
  (Array.isArray(body) ? body : [body]).map((m) => (m && typeof m === "object" && "method" in m ? String((m as { method: unknown }).method) : "")).filter(Boolean).join(",");

export async function handle(req: IncomingMessage, res: ServerResponse) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  const path = new URL(req.url ?? "/", "http://x").pathname.replace(/\/$/, "");
  if (req.method !== "POST") logRequest(req, res, "");
  // No sign-in, so no OAuth metadata.
  if (path.startsWith("/.well-known/")) return send(res, 404, { error: "not_found", error_description: "Dreamsy MCP needs no authentication" });
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (path === "/mcp/health") return send(res, 200, { ok: true, sessions: sessions.size });
  if (path !== "/mcp") return send(res, 404, { error: "not found" });
  if (req.method === "GET" && !req.headers["mcp-session-id"] && !(req.headers.accept ?? "").includes("text/event-stream")) {
    return send(res, 200, { name: "dreamsy", endpoint: "Streamable HTTP MCP. Add this URL as a remote MCP server / custom connector.", docs: "https://dreamsy.dev/docs#mcp" });
  }

  // The event stream stays open, so it isn't counted as in flight.
  if (req.method === "GET") {
    const s = sessions.get((req.headers["mcp-session-id"] as string | undefined) ?? "");
    if (!s) return rpcError(res, s === undefined && req.headers["mcp-session-id"] ? 404 : 400, "Start with an initialize request (POST).");
    s.lastUsed = Date.now();
    await s.transport.handleRequest(req, res);
    return;
  }
  if (inFlight >= MAX_IN_FLIGHT) return rpcError(res, 503, "Dreamsy MCP is busy; retry in a moment.", { "retry-after": "5" });
  inFlight++;
  try {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const body = req.method === "POST" ? await readBody(req) : undefined;
    if (req.method === "POST") logRequest(req, res, rpcMethods(body));
    const existing = sid ? sessions.get(sid) : undefined;
    if (existing) {
      existing.lastUsed = Date.now();
      await existing.transport.handleRequest(req, res, body);
      return;
    }
    if (sid) return rpcError(res, 404, "Session expired or unknown; reconnect to start a new one.");
    if (req.method !== "POST" || !isInitializeRequest(body)) return rpcError(res, 400, "Start with an initialize request (no mcp-session-id yet).");
    const refused = admit(clientIp(req));
    if (refused) return rpcError(res, 429, refused, { "retry-after": "600" });
    const transport = await openSession(clientIp(req));
    await transport.handleRequest(req, res, body);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    if (!res.headersSent) rpcError(res, status, status === 500 ? "internal error" : (e as Error).message);
    if (status === 500) console.error("dreamsy mcp:", e);
  } finally {
    inFlight--;
  }
}

export async function closeAll() {
  for (const id of [...sessions.keys()]) await closeSession(id);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  setInterval(() => void sweep(), SWEEP_MS).unref();
  void sweep();
  httpServer((req, res) => void handle(req, res)).listen(PORT, HOST, () => {
    console.error(`dreamsy mcp (http): http://${HOST}:${PORT}/mcp, workspaces in ${DIR}`);
  });
}
