ALTER TABLE "submissions" ADD COLUMN "claimed_by" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;