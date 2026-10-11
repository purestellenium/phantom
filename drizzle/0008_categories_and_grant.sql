CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
/*
 * `benefit` becomes `grant`, in place.
 *
 * HAND-WRITTEN, replacing what drizzle-kit generated here. It cannot see a
 * rename — it sees one value gone and another arrived — so it emitted the only
 * thing it can emit for that: cast all three columns to text, DROP TYPE,
 * recreate the enum, cast back. On an empty database that happens to work. On
 * one with a `benefit` product it destroys the type, then fails on the way back
 * with `invalid input value for enum product_kind: "benefit"` — a migration
 * that stops halfway, which is the worst available outcome.
 *
 * A rename is one statement, touches no rows, and updates every column of the
 * type at once, including `orders.product_kind` and `product_revisions.kind`.
 * Those two are the frozen record of what past orders bought, and they are
 * exactly what the generated version would have thrown away.
 */
ALTER TYPE "public"."product_kind" RENAME VALUE 'benefit' TO 'grant';--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_slug_idx" ON "product_categories" USING btree ("slug");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");
