// Dreamsy room server (multiplayer v1). Env: JWT_SECRET (same as services/api), GAMESERVER_PORT (8790), HOST, API_URL (player names),
// WORKER_TOKEN (x-internal-token for GET /internal/presence, called by services/api).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startGameServer } from "./server.js";

// local dev: share services/api/.env (JWT_SECRET) when it isn't in the environment
const apiEnv = fileURLToPath(new URL("../../api/.env", import.meta.url));
if (!process.env.JWT_SECRET && existsSync(apiEnv)) process.loadEnvFile(apiEnv);

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) throw new Error("JWT_SECRET must be set (≥ 32 chars, same as services/api)");
const gs = await startGameServer({
  jwtSecret,
  port: Number(process.env.GAMESERVER_PORT ?? 8790),
  host: process.env.HOST ?? "0.0.0.0",
  apiUrl: process.env.API_URL || undefined,
  internalToken: process.env.WORKER_TOKEN || undefined,
});
if (!process.env.WORKER_TOKEN) console.warn("[gameserver] WORKER_TOKEN is not set: /internal/presence is disabled");
console.log(`[gameserver] listening on :${gs.port} (WS /rooms, GET /health)`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void gs.close().then(() => process.exit(0)); });
