ALTER TABLE "projects" ADD COLUMN "number" serial NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_number_idx" ON "projects" USING btree ("number");