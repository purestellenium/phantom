import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { requireCapability } from '$lib/server/auth/authorize';
import { isUniqueViolation } from '$lib/server/db/errors';
import { CatalogError, allCategories, createProduct } from '$lib/server/shop/catalog';

import { PRODUCT_KINDS, readDraft } from '../draft';

export const load: PageServerLoad = async () => {
	requireCapability('manage_catalog');
	const categories = await allCategories();
	return {
		kinds: PRODUCT_KINDS,
		categories: categories.map((category) => ({ id: category.id, name: category.name }))
	};
};

export const actions: Actions = {
	create: async ({ request }) => {
		const actor = requireCapability('manage_catalog');

		const parsed = readDraft(await request.formData());
		if (!parsed.ok) return fail(400, { error: parsed.error });
		const draft = parsed.draft;

		let productId: string;
		try {
			const product = await createProduct(draft, actor.id);
			productId = product.id;
		} catch (error) {
			if (error instanceof CatalogError) return fail(400, { error: error.message });
			/* A unique violation on the slug is the only other expected failure, and
			   its raw message names a Postgres constraint rather than the thing an
			   operator typed. */
			if (isUniqueViolation(error)) {
				return fail(400, { error: `The slug "${draft.slug}" is already taken.` });
			}
			throw error;
		}

		redirect(303, `/admin/catalog/${productId}`);
	}
};
