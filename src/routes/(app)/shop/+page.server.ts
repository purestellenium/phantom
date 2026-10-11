import type { PageServerLoad } from './$types';

import { priceRange } from '$lib/shop/options';

import { eligibilityAllows } from '$lib/server/auth/eligibility';
import { requireOnboarded } from '$lib/server/auth/session';
import { lockedOut } from '$lib/shop/locked';
import { regionBlocked } from '$lib/shop/regions';
import { productKind } from '$lib/server/db/schema';
import { cachedBalance } from '$lib/server/ledger';
import { listedProducts, purchasabilityOf } from '$lib/server/shop/catalog';
import { hasInvite } from '$lib/server/shop/invite';
import { shopWindow } from '$lib/server/shop/window';
import { matches, readFilters, sorted, type Filterable } from '$lib/shop/filters';
import { INVITE_SLUG } from '$lib/shop/invite';
import { REFERRAL_STICKERS_SLUG } from '$lib/referral';

/**
 * The catalog.
 *
 * Everything on this page is advisory and the page says nothing that implies
 * otherwise. Price, stock and eligibility are all rechecked inside the purchase
 * transaction, and the consequence for the UI is that it may show what it likes
 * as long as nothing here is load-bearing. The filters are the same kind of
 * thing: narrowing the list changes what is shown and nothing about what may be
 * bought.
 *
 * Products outside their availability window are still listed, saying when they
 * open. Hiding them makes the shop look empty and the program look unprepared,
 * and a participant who saw something on Tuesday and cannot find it on
 * Wednesday assumes it sold out.
 */

/** One line saying why something cannot be bought. The shape it reads comes
 *  from $lib/server/shop/catalog.ts, so a new reason is a type error here
 *  rather than a blank row. */
function unbuyableHint(blocked: NonNullable<ReturnType<typeof purchasabilityOf>>): string {
	switch (blocked.reason) {
		case 'inactive':
			return 'not for sale';
		case 'not_yet':
			return `opens ${blocked.from.toISOString().slice(0, 10)}`;
		case 'closed':
			return `closed ${blocked.until.toISOString().slice(0, 10)}`;
		case 'out_of_stock':
			return 'sold out';
		case 'misconfigured':
			/* Deliberately vague to the participant. The detail is a schema error
			   that belongs in the console, not on a shop page. */
			return 'unavailable';
	}
}

export const load: PageServerLoad = async ({ url }) => {
	const user = requireOnboarded();
	const [window, listed, balance, invited] = await Promise.all([
		shopWindow(),
		listedProducts(),
		cachedBalance(user.id),
		hasInvite(user.id)
	]);

	/* Hidden where it cannot ship, by the country stored for this person (see
	   $lib/shop/regions.ts) - before anything else, so a blocked product is in
	   none of the counts or filters below either. */
	const reachable = listed.filter(
		(product) => !regionBlocked(product.blockedCountries, user.country)
	);

	/**
	 * The invite comes out of the catalog before anything else happens to it.
	 *
	 * Every line below this - the kind chips, the shelf chips, the "3 of 13"
	 * count, the sort, the grid - is built from `products`, so the invite is in
	 * none of them. That is the whole of "pinned": it is not a product that
	 * happens to sort first, it is not on the shelves at all, and no filter can
	 * remove it from the page because no filter has ever seen it.
	 *
	 * Null when nobody has created it (see lib/shop/invite.ts). The page then
	 * draws no card and is otherwise exactly the shop it was.
	 */
	const invite = reachable.find((product) => product.slug === INVITE_SLUG) ?? null;
	/* The referral stickers are off the grid too: they are free, only to people
	   who have earned them, and the home page's invite card is the way in. */
	/* Held to the event (see $lib/shop/locked.ts): the grid is only what they
	   can still buy, so nothing on it is a button that would refuse them. */
	const products = reachable.filter(
		(product) =>
			product.slug !== INVITE_SLUG &&
			product.slug !== REFERRAL_STICKERS_SLUG &&
			!lockedOut(user.shopLocked, product.slug)
	);

	const filters = readFilters(url.searchParams, productKind.enumValues);

	/**
	 * The filter row is built from the WHOLE listed catalog, before anything is
	 * narrowed - so it offers every kind and shelf the shop has, not only the
	 * ones that survive the current filter. Deriving it from the narrowed list
	 * instead would mean picking "digital" leaves "digital" as the only kind on
	 * offer, and the only way back is the browser's back button.
	 *
	 * Kinds and categories that nothing is listed under are left off, though.
	 * Those are not a way back to anywhere: they are chips that lead to an empty
	 * shop, and a filter that is always a dead end is worse than no filter.
	 */
	const kinds = productKind.enumValues.filter((kind) =>
		products.some((product) => product.kind === kind)
	);

	const categories: { slug: string; name: string }[] = [];
	for (const product of products) {
		if (!product.categorySlug || !product.categoryName) continue;
		if (categories.some((seen) => seen.slug === product.categorySlug)) continue;
		categories.push({ slug: product.categorySlug, name: product.categoryName });
	}

	const filterable = (product: (typeof products)[number]): Filterable => ({
		name: product.name,
		price: product.price,
		position: product.position,
		kind: product.kind,
		categorySlug: product.categorySlug
	});

	const shown = sorted(
		products.filter((product) => matches(filterable(product), filters)),
		filters.sort
	);

	return {
		window: {
			open: window.open,
			message: window.open ? null : window.message,
			closedAt: !window.open && window.why === 'deadline_passed' ? window.closedAt : null
		},
		eligible: eligibilityAllows(user.eligibility),
		shopLocked: user.shopLocked,
		balance,
		/**
		 * The pinned card, or null. `owned` is what turns "buy for 50h" into a
		 * card that says it is already theirs - the purchase itself is still
		 * refused by the per-user limit inside the transaction, and this only
		 * decides what the page says about it beforehand.
		 */
		invite: invite
			? {
					slug: invite.slug,
					name: invite.name,
					description: invite.description,
					imageUrl: invite.imageUrl,
					imagePadding: invite.imagePadding,
					price: invite.price,
					owned: invited,
					hint: (() => {
						const blocked = purchasabilityOf(invite);
						return blocked ? unbuyableHint(blocked) : null;
					})()
				}
			: null,
		filters,
		kinds,
		categories,
		/* Whether anything is unfiled, so the row can offer "everything else"
		   only when there is an "everything else" to offer. */
		hasUnfiled: products.some((product) => product.categorySlug === null),
		/* The unnarrowed total, for the "3 of 13" line. Counted here because the
		   component only ever sees the narrowed list. */
		total: products.length,
		products: shown.map((product) => {
			const blocked = purchasabilityOf(product);
			return {
				id: product.id,
				slug: product.slug,
				name: product.name,
				description: product.description,
				imageUrl: product.imageUrl,
				imagePadding: product.imagePadding,
				price: product.price,
				/* Whether some configuration of it costs more than that. The card
				   says "from" when it does, so a price on the grid is never one the
				   product page then contradicts. */
				priceVaries: priceRange(product.price, product.options).varies,
				categoryName: product.categoryName,
				hint: blocked
					? unbuyableHint(blocked)
					: product.stock !== null
						? `${product.stock} left`
						: null
			};
		})
	};
};
