ALTER TABLE "products" ADD COLUMN "images" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_images_sane" CHECK ("products"."images" is null or (
				jsonb_typeof("products"."images") = 'array' and jsonb_array_length("products"."images") <= 8
			));