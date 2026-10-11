DROP INDEX "submission_comments_idx";--> statement-breakpoint
ALTER TABLE "submission_comments" ALTER COLUMN "submission_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_comments" ADD COLUMN "project_id" uuid;--> statement-breakpoint
-- Comments made before this belong to their submission's project.
UPDATE "submission_comments" SET "project_id" = "submissions"."project_id" FROM "submissions" WHERE "submissions"."id" = "submission_comments"."submission_id";--> statement-breakpoint
ALTER TABLE "submission_comments" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_comments" ADD CONSTRAINT "submission_comments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "submission_comments_idx" ON "submission_comments" USING btree ("project_id","created_at");