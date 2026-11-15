CREATE TABLE "email_codes" (
	"email" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"sends_in_window" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone NOT NULL
);
