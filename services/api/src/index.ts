import "./env.js";
import { serve } from "@hono/node-server";
import { jwksIdentityVerifier } from "./auth.js";
import { createApp } from "./app.js";
import type { Config } from "./context.js";
import { connectPostgres } from "./db/client.js";
import { FsStorage, S3Storage, type Storage } from "./storage.js";
import { fileURLToPath } from "node:url";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const config: Config = {
  jwtSecret: required("JWT_SECRET"),
  workerToken: required("WORKER_TOKEN"),
  dailyGenerationQuota: Number(process.env.DAILY_GENERATION_QUOTA ?? 50),
  leaseSeconds: Number(process.env.WORKER_LEASE_SECONDS ?? 120),
  maxAttempts: Number(process.env.GENERATION_MAX_ATTEMPTS ?? 3),
  ssePollMs: Number(process.env.SSE_POLL_MS ?? 500),
  starterStars: Number(process.env.STARTER_STARS ?? 500),
  creatorShare: Number(process.env.CREATOR_SHARE ?? 0.5),
};
if (config.jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");

const list = (name: string) => (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const identity = jwksIdentityVerifier(
  { apple: list("APPLE_AUDIENCES"), google: list("GOOGLE_AUDIENCES") },
  process.env.SUPABASE_URL
    ? { url: process.env.SUPABASE_URL, jwtSecret: process.env.SUPABASE_JWT_SECRET || undefined }
    : undefined,
);

// S3 when S3_BUCKET is set (production); otherwise files on disk (dev).
const storage: Storage = process.env.S3_BUCKET
  ? S3Storage.fromEnv(process.env)
  : new FsStorage(process.env.STORAGE_DIR ?? fileURLToPath(new URL("../../../.data/blobs", import.meta.url)));

const app = createApp(
  { db: await connectPostgres(required("DATABASE_URL")), storage, config, identity },
  { log: true, corsOrigins: (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean) },
);

const port = Number(process.env.PORT ?? 8787);
// All interfaces by default so phones on the LAN (Expo Go, the engine WebView) can reach it.
const hostname = process.env.HOST ?? "0.0.0.0";
serve({ fetch: app.fetch, port, hostname }, () => console.log(`dreamsy api on ${hostname}:${port}`));
