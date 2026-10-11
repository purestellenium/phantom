ALTER TABLE "submissions" ADD COLUMN "hyper_chroma" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "hyper_chroma_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "hyper_chroma_by" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_hyper_chroma_by_users_id_fk" FOREIGN KEY ("hyper_chroma_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;