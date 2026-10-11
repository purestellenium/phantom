ALTER TYPE "public"."submission_state" ADD VALUE 'reverted';--> statement-breakpoint
DROP TABLE "ari_feed_events" CASCADE;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "kind" "project_kind";