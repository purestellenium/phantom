-- Drop `move_money` from the capability enum. Postgres cannot remove a value
-- from an enum in place, so the column steps out to text[], loses the value,
-- and steps back into the rebuilt type. The default is dropped first: it
-- referenced the old type and would have blocked the DROP.
ALTER TABLE "users" ALTER COLUMN "capabilities" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "capabilities" SET DATA TYPE text[] USING "capabilities"::text[];--> statement-breakpoint
UPDATE "users" SET "capabilities" = array_remove("capabilities", 'move_money');--> statement-breakpoint
DROP TYPE "public"."capability";--> statement-breakpoint
CREATE TYPE "public"."capability" AS ENUM('manage_users', 'manage_catalog', 'manage_orders', 'manage_settings', 'view_audit', 'run_jobs', 'view_pii', 'adjust_ledger', 'review_submissions', 'approve_submissions', 'manage_fraud', 'fulfil_orders');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "capabilities" SET DATA TYPE "public"."capability"[] USING "capabilities"::"public"."capability"[];--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "capabilities" SET DEFAULT '{}'::"public"."capability"[];
