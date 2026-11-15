ALTER TABLE "game_versions" ADD COLUMN "players_min" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "game_versions" ADD COLUMN "players_max" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Backfill from the stored (validated) manifest; scripts/backfill-players.ts re-derives from the package blobs.
UPDATE "game_versions" SET
  "players_min" = CASE WHEN jsonb_typeof("manifest"->'players'->'min') = 'number' THEN ("manifest"->'players'->>'min')::int ELSE 1 END,
  "players_max" = CASE WHEN jsonb_typeof("manifest"->'players'->'max') = 'number' THEN ("manifest"->'players'->>'max')::int ELSE 1 END;
