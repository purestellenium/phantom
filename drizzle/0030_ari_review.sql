CREATE TABLE "ari_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"ari_id" text,
	"external_id" text,
	"submission_id" uuid,
	"outcome" text NOT NULL,
	"detail" text,
	"body" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ari_ships" (
	"ari_id" text PRIMARY KEY NOT NULL,
	"submission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ari_deliveries" ADD CONSTRAINT "ari_deliveries_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ari_ships" ADD CONSTRAINT "ari_ships_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ari_deliveries_outcome_idx" ON "ari_deliveries" USING btree ("outcome","received_at");--> statement-breakpoint
CREATE INDEX "ari_deliveries_submission_idx" ON "ari_deliveries" USING btree ("submission_id","received_at");--> statement-breakpoint
CREATE INDEX "ari_ships_submission_idx" ON "ari_ships" USING btree ("submission_id","created_at");