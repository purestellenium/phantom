ALTER TABLE "submissions" ADD COLUMN "ai_coding_check" jsonb;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "ai_coding_checked_at" timestamp with time zone;