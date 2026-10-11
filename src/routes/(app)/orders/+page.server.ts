import type { PageServerLoad } from './$types';

import { inArray } from 'drizzle-orm';

import { requireOnboarded } from '$lib/server/auth/session';
import { db } from '$lib/server/db/client';
import { products } from '$lib/server/db/schema';
import { ordersFor } from '$lib/server/shop/orders';
import { REFERRAL_STICKERS_SLUG } from '$lib/referral';

/**
 * What you have bought.
 *
 * Every row reads from the order's own frozen columns - the name and the price
 * it was sold at - rather than joining the catalog. That is the point of
 * freezing them: a product renamed or repriced tomorrow does not change what
 * this page says you bought today.
 */
export const load: PageServerLoad = async () => {
	const user = requireOnboarded();
	const orders = await ordersFor(user.id);

	/* The picture is the one thing read live from the catalog: it is
	   presentation, and the product as it is now is the right one to show. */
	const ids = [...new Set(orders.map((order) => order.productId))];
	const pictures = ids.length
		? await db
				.select({ id: products.id, imageUrl: products.imageUrl, slug: products.slug })
				.from(products)
				.where(inArray(products.id, ids))
		: [];
	const imageFor = new Map(pictures.map((row) => [row.id, row.imageUrl]));
	/* The referral stickers carry the smallest price a product can have and
	   are credited straight back as they are claimed - free, and said so
	   rather than as the one fragment on the order. */
	const stickers = new Set(
		pictures.filter((row) => row.slug === REFERRAL_STICKERS_SLUG).map((row) => row.id)
	);

	return {
		orders: orders.map((order) => ({
			...order,
			imageUrl: imageFor.get(order.productId) ?? null,
			free: stickers.has(order.productId)
		}))
	};
};
