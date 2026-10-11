ALTER TABLE "products" ADD COLUMN "blocked_countries" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "country" text;