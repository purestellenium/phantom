CREATE TABLE "ari_feed_events" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"type" text NOT NULL,
	"ship" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ari_feed_events_revision_positive" CHECK ("ari_feed_events"."revision" >= 1),
	CONSTRAINT "ari_feed_events_type" CHECK (("ari_feed_events"."type" = 'ship.upsert' and "ari_feed_events"."ship" is not null) or ("ari_feed_events"."type" = 'ship.withdraw' and "ari_feed_events"."ship" is null))
);
--> statement-breakpoint
ALTER TABLE "ari_feed_events" ADD CONSTRAINT "ari_feed_events_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ari_feed_events_event_idx" ON "ari_feed_events" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ari_feed_events_revision_idx" ON "ari_feed_events" USING btree ("submission_id","revision");