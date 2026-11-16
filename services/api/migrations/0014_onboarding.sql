ALTER TABLE "users" ADD COLUMN "onboarded_at" timestamp with time zone;--> statement-breakpoint
-- Existing accounts skip the guided first experience; only accounts created after this migration get it.
UPDATE "users" SET "onboarded_at" = now() WHERE "onboarded_at" IS NULL;