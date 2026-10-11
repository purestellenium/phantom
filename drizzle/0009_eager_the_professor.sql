/*
 * `grant` leaves product_kind, and the one product still holding it becomes
 * `digital`.
 *
 * PARTLY HAND-WRITTEN, for the reason 0008 gives at length — arriving this time
 * from the other side. 0008 renamed `benefit` to `grant` and refused the
 * generated form of that change, describing what it would do to a database with
 * rows in it. What follows the updates is that generated form: cast all three
 * columns to text, DROP TYPE, recreate the enum without `grant`, cast back.
 *
 * Removing a value is the one case where the dance is unavoidable — Postgres has
 * no `ALTER TYPE ... DROP VALUE`, so the type genuinely has to be rebuilt. But
 * the cast back still fails with `invalid input value for enum product_kind:
 * "grant"` for every row that holds the value being removed, and it fails after
 * the DROP: the type is gone, the columns are text, and the migration has
 * stopped halfway. That is the outcome 0008 called the worst available.
 *
 * So the rows move first, while `grant` is still a legal value and the update is
 * an ordinary one touching no types. `grant` is a category now rather than a
 * kind, and the product that carried it is the flight, which ships nothing —
 * `digital` is the kind for a thing that does not ship, which is the same call
 * seed-demo.ts makes for the same product.
 *
 * orders.product_kind and product_revisions.kind are the frozen record of what
 * past orders bought, and 0008 is emphatic that they are not to be thrown away.
 * They are not: they are carried across to the kind that still exists, which is
 * the most faithful reading available once the label they held is gone.
 */
UPDATE "products" SET "kind" = 'digital' WHERE "kind" = 'grant';--> statement-breakpoint
UPDATE "product_revisions" SET "kind" = 'digital' WHERE "kind" = 'grant';--> statement-breakpoint
UPDATE "orders" SET "product_kind" = 'digital' WHERE "product_kind" = 'grant';--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_shipping_only_physical";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "product_kind" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "product_revisions" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."product_kind";--> statement-breakpoint
CREATE TYPE "public"."product_kind" AS ENUM('physical', 'digital');--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "product_kind" SET DATA TYPE "public"."product_kind" USING "product_kind"::"public"."product_kind";--> statement-breakpoint
ALTER TABLE "product_revisions" ALTER COLUMN "kind" SET DATA TYPE "public"."product_kind" USING "kind"::"public"."product_kind";--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "kind" SET DATA TYPE "public"."product_kind" USING "kind"::"public"."product_kind";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shipping_only_physical" CHECK ("orders"."product_kind" = 'physical' or "orders"."shipping_encrypted" is null);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "image_padding" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_image_padding_sane" CHECK ("products"."image_padding" >= 0 and "products"."image_padding" <= 64);
