/**
 * Backfill game_versions.players_min / players_max from each version's package (`[players]` in
 * dreamsy.toml, DREAMSY.MD §3.1). Idempotent: only rows whose values differ are updated.
 * Migration 0010 already backfills from the stored manifest; this re-derives from the blobs.
 *
 *   DATABASE_URL=... [STORAGE_DIR=/data/blobs | S3_BUCKET=...] npx tsx scripts/backfill-players.ts [--dry-run]
 */

import "../src/env.js";
import { and, eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { connectPostgres, schema } from "../src/db/client.js";
import { inspectPackage } from "../src/package.js";
import { playersOf } from "../src/services.js";
import { FsStorage, S3Storage, type Storage } from "../src/storage.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const dryRun = process.argv.includes("--dry-run");

// Same storage selection as src/index.ts.
const storage: Storage = process.env.S3_BUCKET
  ? S3Storage.fromEnv(process.env)
  : new FsStorage(process.env.STORAGE_DIR ?? fileURLToPath(new URL("../../../.data/blobs", import.meta.url)));

const db = await connectPostgres(url);
const { gameVersions } = schema;

const rows = await db.select({
  gameId: gameVersions.gameId,
  version: gameVersions.version,
  packageKey: gameVersions.packageKey,
  manifest: gameVersions.manifest,
  playersMin: gameVersions.playersMin,
  playersMax: gameVersions.playersMax,
}).from(gameVersions);

const byKey = new Map<string, { min: number; max: number }>(); // packages are content-addressed and shared
let updated = 0, unchanged = 0, fallback = 0, multiplayer = 0;
for (const r of rows) {
  let players = byKey.get(r.packageKey);
  if (!players) {
    try {
      const zip = await storage.get(r.packageKey);
      if (!zip) throw new Error("blob missing");
      players = playersOf(inspectPackage(zip).manifest);
    } catch (e) {
      // Unreadable / no-longer-valid package: fall back to the manifest stored at commit time.
      players = playersOf(r.manifest);
      fallback++;
      console.warn(`${r.gameId} v${r.version}: ${(e as Error).message}; using stored manifest`);
    }
    byKey.set(r.packageKey, players);
  }
  if (players.max > 1) multiplayer++;
  if (players.min === r.playersMin && players.max === r.playersMax) { unchanged++; continue; }
  console.log(`${r.gameId} v${r.version}: ${r.playersMin}-${r.playersMax} → ${players.min}-${players.max}`);
  if (!dryRun) {
    await db.update(gameVersions).set({ playersMin: players.min, playersMax: players.max })
      .where(and(eq(gameVersions.gameId, r.gameId), eq(gameVersions.version, r.version)));
  }
  updated++;
}
console.log(`${rows.length} versions: ${updated} ${dryRun ? "would update" : "updated"}, ${unchanged} unchanged, `
  + `${multiplayer} multiplayer, ${fallback} from stored manifest`);
process.exit(0);
