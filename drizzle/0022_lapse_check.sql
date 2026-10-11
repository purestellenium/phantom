ALTER TABLE "submissions" ADD COLUMN "lapse_check" jsonb;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "lapse_checked_at" timestamp with time zone;