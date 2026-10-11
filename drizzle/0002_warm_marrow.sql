CREATE TYPE "public"."submission_state" AS ENUM('pending', 'first_passed', 'approved', 'rejected');--> statement-breakpoint
ALTER TYPE "public"."capability" ADD VALUE 'approve_submissions' BEFORE 'manage_fraud';--> statement-breakpoint
CREATE TABLE "project_showcase" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"screenshot_url" text,
	"demo_url" text,
	"author_name" text,
	"total_approved_seconds" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"repo_url" text,
	"demo_url" text,
	"screenshot_url" text,
	"hackatime_projects" text,
	"ai_declaration" text,
	"fraud_hold" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"from_state" "submission_state",
	"to_state" "submission_state" NOT NULL,
	"actor_id" uuid,
	"actor_role" "user_role",
	"reason" text NOT NULL,
	"internal_note" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"repo_url" text,
	"demo_url" text,
	"screenshot_url" text,
	"hackatime_projects" text,
	"ai_declaration" text,
	"claimed_seconds" bigint NOT NULL,
	"changelog" text,
	"state" "submission_state" DEFAULT 'pending' NOT NULL,
	"state_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewer_id" uuid,
	"approver_id" uuid,
	"awarded_seconds" bigint,
	"public_message" text,
	"justification" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submissions_claimed_non_negative" CHECK ("submissions"."claimed_seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "project_showcase" ADD CONSTRAINT "project_showcase_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_transitions" ADD CONSTRAINT "submission_transitions_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_transitions" ADD CONSTRAINT "submission_transitions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_user_idx" ON "projects" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "submission_transitions_idx" ON "submission_transitions" USING btree ("submission_id","created_at");--> statement-breakpoint
CREATE INDEX "submissions_project_idx" ON "submissions" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "submissions_user_idx" ON "submissions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "submissions_state_idx" ON "submissions" USING btree ("state","state_at");