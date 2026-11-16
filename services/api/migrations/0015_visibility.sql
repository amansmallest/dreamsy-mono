ALTER TABLE "games" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
-- Existing games keep what they had: live games stay public, everything else becomes private
-- (nothing currently unpublished gets exposed; old drafts are not auto-published).
UPDATE "games" SET "visibility" = CASE WHEN "status" = 'published' THEN 'public' ELSE 'private' END;
