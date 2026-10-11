import { eq, sql as raw } from 'drizzle-orm';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { requireCapability } from '$lib/server/auth/authorize';
import { db } from '$lib/server/db/client';
import { isUniqueViolation } from '$lib/server/db/errors';
import { orders } from '$lib/server/db/schema';
import {
	CatalogError,
	allCategories,
	productById,
	revisionsFor,
	updateProduct
} from '$lib/server/shop/catalog';

import {
	PRODUCT_KINDS,
	forDateTimeInput,
	galleryText,
	readDraft,
	schemaText,
	type FormProduct
} from '../draft';

/**
 * One product: the form that changes it, and the history of what it has been.
 *
 * The revision list is the point of the page. It answers "why did that order
 * cost that" without archaeology, and it is the thing that makes the frozen
 * version number on an order mean something - a version that no row describes
 * is the same amount of information as no version at all.
 *
 * Note which edits appear here and which do not. Price, name, kind, limit,
 * eligibility and the option schema all bump the version, because an order's
 * meaning depends on them. Stock and the availability window do not: they say
 * whether something can be bought right now, not what buying it means, and
 * versioning every restock would fill this list with rows no order points at.
 */
export const load: PageServerLoad = async ({ params }) => {
	requireCapability('manage_catalog');

	const product = await productById(params.id);
	if (!product) error(404);

	const [revisions, categories, sold] = await Promise.all([
		revisionsFor(product.id),
		allCategories(),
		db
			.select({
				orders: raw<number>`count(*)::int`,
				units: raw<number>`coalesce(sum(${orders.quantity}), 0)::int`
			})
			.from(orders)
			.where(eq(orders.productId, product.id))
	]);

	const form: FormProduct = {
		name: product.name,
		slug: product.slug,
		description: product.description ?? '',
		imageUrl: product.imageUrl ?? '',
		imagePadding: product.imagePadding,
		position: product.position,
		images: galleryText(product.images),
		kind: product.kind,
		categoryId: product.categoryId ?? '',
		price: product.price,
		stock: product.stock ?? '',
		perUserLimit: product.perUserLimit ?? '',
		availableFrom: forDateTimeInput(product.availableFrom),
		availableUntil: forDateTimeInput(product.availableUntil),
		blockedCountries: product.blockedCountries,
		active: product.active,
		requiresEligibility: product.requiresEligibility,
		optionSchema: schemaText(product.optionSchema)
	};

	return {
		name: product.name,
		slug: product.slug,
		version: product.version,
		active: product.active,
		optionError: product.optionError,
		sold: { orders: sold[0]?.orders ?? 0, units: sold[0]?.units ?? 0 },
		form,
		kinds: PRODUCT_KINDS,
		categories: categories.map((category) => ({ id: category.id, name: category.name })),
		revisions
	};
};

export const actions: Actions = {
	update: async ({ params, request }) => {
		const actor = requireCapability('manage_catalog');

		const parsed = readDraft(await request.formData());
		if (!parsed.ok) return fail(400, { error: parsed.error });
		const draft = parsed.draft;

		try {
			await updateProduct(params.id, draft, actor.id);
		} catch (error) {
			if (error instanceof CatalogError) return fail(400, { error: error.message });
			if (isUniqueViolation(error)) {
				return fail(400, { error: `The slug "${draft.slug}" is already taken.` });
			}
			throw error;
		}

		redirect(303, `/admin/catalog/${params.id}`);
	}
};
