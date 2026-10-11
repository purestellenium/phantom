CREATE TABLE "commit_snapshots" (
	"submission_id" uuid PRIMARY KEY NOT NULL,
	"result" jsonb NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commit_snapshots" ADD CONSTRAINT "commit_snapshots_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;