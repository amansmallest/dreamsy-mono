CREATE TABLE "play_passes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"game_id" text NOT NULL,
	"version" integer NOT NULL,
	"price" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger" ADD COLUMN "pass_id" text;--> statement-breakpoint
ALTER TABLE "play_passes" ADD CONSTRAINT "play_passes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_passes" ADD CONSTRAINT "play_passes_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "play_passes_user_game_idx" ON "play_passes" USING btree ("user_id","game_id","expires_at");--> statement-breakpoint
-- Platform ledger account: receives the 10% fee on plays and store sales (docs/platform.md §11.6).
INSERT INTO "users" ("id", "handle", "bio") VALUES ('u_platform', '__platform__', 'Dreamsy platform account') ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "wallets" ("user_id", "balance") VALUES ('u_platform', 0) ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Top every existing wallet up to the 1,000,000-coin starter balance, recorded as "grant" entries.
INSERT INTO "ledger" ("user_id", "delta", "balance_after", "kind")
  SELECT "user_id", 1000000 - "balance", 1000000, 'grant' FROM "wallets"
  WHERE "balance" < 1000000 AND "user_id" <> 'u_platform';--> statement-breakpoint
UPDATE "wallets" SET "balance" = 1000000 WHERE "balance" < 1000000 AND "user_id" <> 'u_platform';
