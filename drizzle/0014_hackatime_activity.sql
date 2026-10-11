CREATE TABLE "hackatime_activity" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"active" boolean NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hackatime_activity" ADD CONSTRAINT "hackatime_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hackatime_activity_user_day_idx" ON "hackatime_activity" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "hackatime_activity_day_idx" ON "hackatime_activity" USING btree ("day");