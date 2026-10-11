CREATE TYPE "public"."project_kind" AS ENUM('software', 'hardware');--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "kind" "project_kind";