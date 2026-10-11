import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { requireCapability } from '$lib/server/auth/authorize';
import { isUniqueViolation } from '$lib/server/db/errors';
import {
	CatalogError,
	allProducts,
	categoriesWithCounts,
	createCategory,
	deleteCategory,
	purchasabilityOf,
	slugify
} from '$lib/server/shop/catalog';

/**
 * Every product, including the retired ones - and the shelves they sit on.
 *
 * Retired rather than deleted, always: a deleted product is one an old order
 * points at, and `orders.product_id` is a restrict foreign key precisely so
 * nobody can try. Turning `active` off is how something leaves the shop.
 *
 * Categories are the opposite case and are genuinely deletable, because nothing
 * points at one in a way that matters - see the note on `products.category_id`.
 * They live on this page rather than on one of their own because creating a
 * shelf is something an operator does in the middle of filing a product, and a
 * separate page would mean leaving a half-filled form to get there.
 *
 * A misconfigured option schema is called out here rather than only when
 * somebody tries to buy. It makes the product unsellable - the purchase path
 * refuses rather than recording unchecked options - and that is worth knowing
 * before a participant discovers it.
 */
export const load: PageServerLoad = async () => {
	requireCapability('manage_catalog');
	const [products, categories] = await Promise.all([allProducts(), categoriesWithCounts()]);

	return {
		categories,
		/* Products with no shelf, counted once here rather than derived in the
		   component from a list that has already been trimmed for display. */
		unfiled: products.filter((product) => product.categoryId === null).length,
		products: products.map((product) => {
			const blocked = purchasabilityOf(product);
			return {
				id: product.id,
				name: product.name,
				slug: product.slug,
				version: product.version,
				kind: product.kind,
				stock: product.stock,
				price: product.price,
				categoryId: product.categoryId,
				optionError: product.optionError,
				blockedReason: blocked?.reason.replace(/_/g, ' ') ?? null
			};
		})
	};
};

export const actions: Actions = {
	createCategory: async ({ request }) => {
		const actor = requireCapability('manage_catalog');

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		/* The slug is optional and derived from the name when it is blank, because
		   an operator adding a shelf mid-flow is thinking about the word, not the
		   URL. Typed explicitly it is taken as typed - a derived slug is a
		   convenience, not a rule about what a slug may be. */
		const typed = String(form.get('slug') ?? '').trim();
		const slug = typed || slugify(name);

		if (!slug) {
			return fail(400, {
				categoryError: 'That name has no letters or digits in it to make a slug from.',
				categoryName: name
			});
		}

		try {
			await createCategory(name, slug, actor.id);
		} catch (error) {
			if (error instanceof CatalogError) {
				return fail(400, { categoryError: error.message, categoryName: name });
			}
			if (isUniqueViolation(error)) {
				return fail(400, {
					categoryError: `The slug "${slug}" is already taken by another category.`,
					categoryName: name
				});
			}
			throw error;
		}

		return { categoryCreated: name };
	},

	deleteCategory: async ({ request }) => {
		const actor = requireCapability('manage_catalog');

		const form = await request.formData();
		const id = String(form.get('id') ?? '');

		try {
			const name = await deleteCategory(id, actor.id);
			return { categoryDeleted: name };
		} catch (error) {
			if (error instanceof CatalogError) return fail(400, { categoryError: error.message });
			throw error;
		}
	}
};
