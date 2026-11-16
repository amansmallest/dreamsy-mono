CREATE TABLE "friendships" (
	"user_a" text NOT NULL,
	"user_b" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "friendships_user_a_user_b_pk" PRIMARY KEY("user_a","user_b")
);
--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_a_users_id_fk" FOREIGN KEY ("user_a") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_b_users_id_fk" FOREIGN KEY ("user_b") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "friendships_user_b_idx" ON "friendships" USING btree ("user_b");