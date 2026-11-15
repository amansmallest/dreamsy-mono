// WebSocket front of the room server: GET /health, WS /rooms. Auth = the API's HS256 user token in the first
// message ({t:"hello", token}); size + rate limits per connection; heartbeat pings.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { jwtVerify } from "jose";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { LIMITS, type ServerMsg } from "@dreamsy/engine/net";
import { RoomManager, type Peer } from "./rooms.js";
import { parseClientMsg, sanitizeName } from "./validate.js";

export interface GameServerOptions {
  port?: number;
  host?: string;
  /** Same secret as services/api (JWT_SECRET). */
  jwtSecret: string;
  /** services/api base URL: players who don't send a name in hello are named by GET /v1/me (handle). */
  apiUrl?: string;
  /** ms before an unauthenticated socket is closed. */
  helloTimeoutMs?: number;
  heartbeatMs?: number;
  log?: (msg: string) => void;
}

export interface GameServer {
  server: Server;
  rooms: RoomManager;
  port: number;
  close(): Promise<void>;
}

/** Close codes (4000–4999 = application). */
export const CLOSE = { unauthorized: 4001, rateLimited: 4008, tooLarge: 1009 } as const;

export async function startGameServer(opts: GameServerOptions): Promise<GameServer> {
  const log = opts.log ?? ((m: string) => console.log(`[gameserver] ${m}`));
  const key = new TextEncoder().encode(opts.jwtSecret);
  const rooms = new RoomManager();
  rooms.onResult.push((room, r) => log(`match ${room.code}#${r.match} ${room.game}: ${r.draw ? "draw" : r.winner ?? r.team} (${r.reason})`));
  const names = new Map<string, { name: string; at: number }>();
  let seq = 0;

  const server = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/rooms/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: rooms.rooms.size, players: rooms.playerCount }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes * 2 });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/rooms" && path !== "/rooms/") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws));
  });

  async function resolveName(token: string, userId: string, fallback: string): Promise<string> {
    // a display name typed in the lobby wins (family play: "Mom", not "dreamer_x1y2"); cosmetic only
    if (fallback) return fallback;
    const cached = names.get(userId);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.name;
    if (opts.apiUrl) {
      try {
        const res = await fetch(`${opts.apiUrl.replace(/\/$/, "")}/v1/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2500) });
        if (res.ok) {
          const d = (await res.json()) as { user?: { handle?: string } };
          const n = sanitizeName(d.user?.handle);
          if (n) { names.set(userId, { name: n, at: Date.now() }); return n; }
        }
      } catch { /* API down: use the client's name */ }
    }
    return "Player";
  }

  function onSocket(ws: WebSocket) {
    let peer: Peer | null = null;
    let authing = false;
    let alive = true;
    // token bucket
    let tokens: number = LIMITS.msgsBurst, last = Date.now(), drops = 0, lastWarn = 0;
    const send = (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    const helloTimer = setTimeout(() => { if (!peer) ws.close(CLOSE.unauthorized, "no hello"); }, opts.helloTimeoutMs ?? 5000);
    ws.on("pong", () => { alive = true; });
    const beat = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }, opts.heartbeatMs ?? 20_000);

    ws.on("message", async (data: RawData, isBinary: boolean) => {
      const size = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : (data as Buffer).byteLength;
      if (isBinary) { send({ t: "error", code: "bad_message", message: "text JSON only" }); return; }
      if (size > LIMITS.maxMessageBytes) { send({ t: "error", code: "too_large", message: `message > ${LIMITS.maxMessageBytes} bytes` }); return; }
      const now = Date.now();
      tokens = Math.min(LIMITS.msgsBurst, tokens + ((now - last) / 1000) * LIMITS.msgsPerSecond);
      last = now;
      if (tokens < 1) {
        drops++;
        if (drops > LIMITS.maxDrops) { ws.close(CLOSE.rateLimited, "rate limited"); return; }
        if (now - lastWarn > 1000) { lastWarn = now; send({ t: "error", code: "rate_limited", message: `max ${LIMITS.msgsPerSecond} messages/s` }); }
        return;
      }
      tokens -= 1;
      const msg = parseClientMsg(data.toString());
      if (!msg) { send({ t: "error", code: "bad_message", message: "unknown or malformed message" }); return; }
      if (!peer) {
        if (msg.t !== "hello" || authing) { if (!authing) { send({ t: "error", code: "unauthorized", message: "send {t:\"hello\", token} first" }); ws.close(CLOSE.unauthorized, "unauthorized"); } return; }
        authing = true;
        let userId: string;
        try {
          const { payload } = await jwtVerify(msg.token, key, { algorithms: ["HS256"] });
          if (!payload.sub) throw new Error("no sub");
          userId = payload.sub;
        } catch {
          send({ t: "error", code: "unauthorized", message: "invalid token" });
          ws.close(CLOSE.unauthorized, "unauthorized");
          return;
        }
        const name = await resolveName(msg.token, userId, sanitizeName(msg.name));
        if (ws.readyState !== ws.OPEN) return;
        clearTimeout(helloTimer);
        const id = `p_${(++seq).toString(36)}${randomBytes(3).toString("hex")}`;
        peer = { id, userId, name, send };
        send({ t: "welcome", id, userId, name });
        return;
      }
      if (msg.t === "hello") return;
      rooms.handle(peer, msg);
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      clearInterval(beat);
      if (peer) rooms.disconnect(peer);
    });
    ws.on("error", () => { /* close follows */ });
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 8790, opts.host ?? "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server, rooms, port,
    close: () => new Promise<void>((resolve) => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close(() => resolve());
    }),
  };
}
