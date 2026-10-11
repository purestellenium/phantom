import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { allCategories, listedProducts, purchasabilityOf } from '$lib/server/shop/catalog';
import type { ShopProduct, Unbuyable } from '$lib/server/shop/catalog';
import { shopWindow } from '$lib/server/shop/window';
import { INVITE_SLUG } from '$lib/shop/invite';
import { priceRange } from '$lib/shop/options';
import { hoursValue } from '$lib/status';

/**
 * The catalog, for anyone.
 *
 * The one endpoint here that answers without a session, which is the whole
 * point of it: the shop is what the program is offering, and that is a question
 * people ask before they have an account rather than after. Every other /api
 * route serves rows a signed-in page serves and is gated to match; this one
 * serves what an unauthenticated visitor could already read by signing up, so
 * the gate would only be asking them to do that first.
 *
 * What it answers with is exactly `listedProducts()` - the function whose own
 * comment is "what a participant may see" - so there is no second idea of
 * visibility here to drift away from the shop's. A product goes public when it
 * is made active and not before; nothing else in this file decides that.
 *
 * Deliberately absent, because they are about a person rather than a product:
 * whether the caller can afford anything, whether they are eligible, whether
 * they already hold the invite, and how many they have bought. Those need a
 * session and this has none.
 */

/* Every field below is one the signed-in shop already prints on a card or a
   product page - stock and the per-person cap included, which the detail page
   lists under "stock" and "N per person". This is the same catalog with the
   viewer removed, not a wider one. */
/**
 * An option as a buyer meets it, with the surcharge in hours.
 *
 * Not `ShopProduct['options']` passed straight through, because that carries
 * `extraSeconds` - and the stored schema is AUTHORED as `extraHours` and
 * converted to seconds on parse, so seconds is the internal half of a unit
 * split that has hours on both ends. Serving the internal half would be the one
 * place the split leaked.
 */
type PublicOption =
	| {
			type: 'select';
			key: string;
			label: string;
			required: boolean;
			choices: {
				value: string;
				label: string;
				image: string | null;
				extraHours: number;
			}[];
	  }
	| { type: 'text'; key: string; label: string; required: boolean; maxLength: number };

function publicOption(option: ShopProduct['options'][number]): PublicOption {
	if (option.type === 'text') {
		return {
			type: 'text',
			key: option.key,
			label: option.label,
			required: option.required,
			maxLength: option.maxLength
		};
	}
	return {
		type: 'select',
		key: option.key,
		label: option.label,
		required: option.required,
		choices: option.choices.map((choice) => ({
			value: choice.value,
			label: choice.label,
			image: choice.image,
			extraHours: hoursValue(choice.extraSeconds)
		}))
	};
}

type PublicProduct = {
	slug: string;
	name: string;
	description: string | null;
	kind: string;
	category: { slug: string; name: string } | null;
	/**
	 * Hours, everywhere, and the unit is in every field's NAME rather than in a
	 * `currency` beside them.
	 *
	 * The ledger stores seconds because that is what Hackatime counts, and no
	 * part of that is a consumer's problem: nobody thinks in seconds, the one
	 * `currency` the schema has is the literal string "seconds", and a number
	 * called `price` sitting next to it is a unit somebody has to look up and
	 * can get wrong exactly once. The stored schema already names its authored
	 * key `extraHours` for this reason; this is the same trick.
	 */
	priceHours: number;
	/** What the options can add, also in hours. `varies` is why a card says
	 *  "from N hours". */
	priceRangeHours: { min: number; max: number; varies: boolean };
	imageUrl: string | null;
	images: string[];
	stock: number | null;
	perUserLimit: number | null;
	requiresEligibility: boolean;
	/**
	 * The invite, which the shop pins above the catalog rather than filing on a
	 * shelf - its own words are "it is not on the shelves at all, and no filter
	 * can remove it from the page because no filter has ever seen it".
	 *
	 * Carried as a flag rather than by leaving it out or by splitting the list,
	 * because both of those make a consumer wrong in a different direction: left
	 * out, a client that wants everything a participant sees is missing the one
	 * card at the top of the page; split off, every client has to handle two
	 * shapes to render one grid. A flag says what the shop knows, and a client
	 * that does not care may ignore it and still be right.
	 */
	pinned: boolean;
	options: PublicOption[];
	availableFrom: string | null;
	availableUntil: string | null;
	/** Buyable right now, as far as the catalog can tell. Advisory, exactly as
	 *  it is for the shop page - the purchase transaction re-derives all of it
	 *  under a lock, and this is a listing, not a promise. */
	available: boolean;
	/** Why not, when not. The reason only - `misconfigured` carries a detail
	 *  string that is a schema error for the console, and the shop is already
	 *  deliberately vague about it to participants. */
	unavailableReason: Unbuyable['reason'] | null;
};

function hoursRange(range: { min: number; max: number; varies: boolean }) {
	return { min: hoursValue(range.min), max: hoursValue(range.max), varies: range.varies };
}

function publicProduct(product: ShopProduct, now: Date): PublicProduct {
	const blocked = purchasabilityOf(product, now);
	return {
		slug: product.slug,
		name: product.name,
		description: product.description,
		kind: product.kind,
		category:
			product.categorySlug && product.categoryName
				? { slug: product.categorySlug, name: product.categoryName }
				: null,
		priceHours: hoursValue(product.price),
		priceRangeHours: hoursRange(priceRange(product.price, product.options)),
		imageUrl: product.imageUrl,
		images: product.images ?? [],
		stock: product.stock,
		perUserLimit: product.perUserLimit,
		requiresEligibility: product.requiresEligibility,
		pinned: product.slug === INVITE_SLUG,
		options: product.options.map(publicOption),
		availableFrom: product.availableFrom?.toISOString() ?? null,
		availableUntil: product.availableUntil?.toISOString() ?? null,
		available: blocked === null,
		unavailableReason: blocked?.reason ?? null
	};
}

export const GET: RequestHandler = async ({ setHeaders }) => {
	const now = new Date();
	const [window, listed, categories] = await Promise.all([
		shopWindow(),
		listedProducts(),
		allCategories()
	]);

	/* A minute. The catalog changes when an operator changes it, which is rarely
	   and never urgently, and the one field that moves on its own - stock - is
	   advisory here anyway. Long enough that a link doing the rounds does not
	   land on the database once per reader; short enough that a restock shows up
	   while somebody is still looking. */
	setHeaders({ 'cache-control': 'public, max-age=60' });

	return json({
		/* Whether anything can be bought at all, which is not a property of any
		   product and so cannot be read off the list. A closed shop still lists
		   its catalog, the same way the page does. */
		shop: window.open
			? { open: true, closesAt: window.closesAt?.toISOString() ?? null }
			: { open: false, closedAt: window.closedAt?.toISOString() ?? null },
		/* The shelves as the shop orders them, including empty ones - a consumer
		   grouping by category gets the operator's ordering rather than having to
		   invent one from the products. */
		categories: categories.map((category) => ({ slug: category.slug, name: category.name })),
		count: listed.length,
		products: listed.map((product) => publicProduct(product, now))
	});
};
