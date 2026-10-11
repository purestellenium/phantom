import { and, asc, desc, eq, sql as raw } from 'drizzle-orm';

import { isCountryCode } from '$lib/countries';
import { isUuid } from '$lib/uuid';
import { recordAudit, type DbHandle } from '$lib/server/audit';
import { db } from '$lib/server/db/client';
import {
	productCategories,
	productRevisions,
	products,
	type Product,
	type ProductCategory,
	type ProductKind,
	type ProductRevision
} from '$lib/server/db/schema';
import { MAX_GALLERY } from '$lib/shop/gallery';
import { INVITE_SLUG } from '$lib/shop/invite';
import { REFERRAL_STICKERS_SLUG } from '$lib/referral';
import { parseOptionSchema, type ProductOption } from '$lib/shop/options';
import { cleanUrl } from '$lib/url';
import type { JsonValue } from '$lib/json';

/**
 * The catalog: reading it, and changing it without lying about the past.
 *
 * The one hard rule is that an economically relevant edit BUMPS THE VERSION AND
 * WRITES A REVISION. Price, name, kind, per-user limit, eligibility requirement
 * and option schema are all economically relevant, because an order's meaning
 * depends on them. Stock and the availability window are not: they describe
 * whether something can be bought right now, not what buying it means, and
 * versioning every restock would fill the revision table with rows no order
 * would ever point at.
 *
 * That split is why `updateProduct` and `setStock` are different functions
 * rather than one with a flag. A flag is a decision made at the call site, and
 * the call site is exactly where somebody would get it wrong.
 */

/* ── reading ─────────────────────────────────────────────────────────────── */

/** A product with its option schema already parsed, which is what every page
 *  actually wants. The unparsed column is JSON that has to be checked before
 *  it can be rendered, and doing that check in three page components is three
 *  chances to skip it. */
export type CatalogProduct = Product & {
	options: ProductOption[];
	/** Set when the stored schema does not parse. The product is then unbuyable
	 *  - see `purchasabilityOf` - and the console shows this string. */
	optionError: string | null;
};

function withOptions(product: Product): CatalogProduct {
	const parsed = parseOptionSchema(product.optionSchema);
	return {
		...product,
		options: parsed.ok ? parsed.options : [],
		optionError: parsed.ok ? null : parsed.error
	};
}

/** Everything, for the console. Newest first - an operator is usually looking
 *  for the thing they just made. */
export async function allProducts(): Promise<CatalogProduct[]> {
	const rows = await db.select().from(products).orderBy(desc(products.createdAt));
	return rows.map(withOptions);
}

/** A listed product with its shelf resolved, which is what the shop needs to
 *  both filter by category and print the name of one. Null on both when the
 *  product is unfiled. */
export type ShopProduct = CatalogProduct & {
	categorySlug: string | null;
	categoryName: string | null;
};

/**
 * What a participant may see.
 *
 * Active only, and ordered by price so the cheapest is first - which is the
 * order that matters when the question is "what can I afford", and which is
 * still the shop's default when nobody has asked for another. Availability
 * windows are NOT filtered here: a product that opens on Friday should be
 * visible on Thursday, saying when it opens. Hiding it makes the shop look
 * empty and the program look unprepared.
 *
 * The whole listed set comes back, unfiltered by kind or category, even when
 * the shop is about to show one shelf of it. That is deliberate: the filter row
 * has to name every shelf and kind the catalog HAS, including the ones the
 * current filter excludes, or choosing a filter would delete the way back out
 * of it. Filtering in SQL would mean a second query to rebuild that row from
 * the rows the first one just discarded. A listed catalog is tens of rows.
 */
export async function listedProducts(): Promise<ShopProduct[]> {
	const rows = await db
		.select({
			product: products,
			categorySlug: productCategories.slug,
			categoryName: productCategories.name
		})
		.from(products)
		/* Left join: an unfiled product is still for sale, and an inner join would
		   quietly empty the shop the moment somebody deleted a category. */
		.leftJoin(productCategories, eq(products.categoryId, productCategories.id))
		.where(eq(products.active, true))
		.orderBy(asc(products.price), asc(products.position), asc(products.name));

	return rows.map((row) => ({
		...withOptions(row.product),
		categorySlug: row.categorySlug,
		categoryName: row.categoryName
	}));
}

/* ── categories ──────────────────────────────────────────────────────────── */

/**
 * The shelves, in the order the shop puts them in.
 *
 * `position` first and name second, so the operator's ordering wins where they
 * have expressed one and the rest stay alphabetical instead of falling back to
 * insertion order - which looks arbitrary to everybody except whoever typed
 * them in.
 */
export async function allCategories(): Promise<ProductCategory[]> {
	return db
		.select()
		.from(productCategories)
		.orderBy(asc(productCategories.position), asc(productCategories.name));
}

/** The same list with the number of products filed on each shelf - what the
 *  console shows next to a delete button, because "delete wearables" and
 *  "delete wearables, unfiling 3 products" are different decisions. */
export async function categoriesWithCounts(): Promise<
	(ProductCategory & { productCount: number })[]
> {
	return db
		.select({
			id: productCategories.id,
			slug: productCategories.slug,
			name: productCategories.name,
			position: productCategories.position,
			createdAt: productCategories.createdAt,
			createdBy: productCategories.createdBy,
			/* Left join, so a shelf with nothing on it counts zero rather than
			   vanishing - an empty category is exactly the one an operator is most
			   likely to be looking for when they came here to delete something. */
			productCount: raw<number>`count(${products.id})::int`
		})
		.from(productCategories)
		.leftJoin(products, eq(products.categoryId, productCategories.id))
		.groupBy(productCategories.id)
		.orderBy(asc(productCategories.position), asc(productCategories.name));
}

/** A name turned into a URL segment, for when the operator did not type one.
 *  Same grammar `validateDraft` holds product slugs to, so the two kinds of
 *  slug in the catalog cannot drift into different alphabets. */
export function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.normalize('NFKD')
			/* Strip the combining marks NFKD just split off, so "café" slugs as "cafe"
			   rather than losing the e as well. Written as escapes because the range
			   is invisible characters, and a literal one is a character somebody
			   deletes by accident and cannot see they have. */
			.replace(/[\u0300-\u036f]/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
	);
}

export async function createCategory(
	name: string,
	slug: string,
	actorId: string
): Promise<ProductCategory> {
	const trimmed = name.trim();
	if (!trimmed) throw new CatalogError('A category needs a name.');
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
		throw new CatalogError('The slug must be lowercase letters, digits and single hyphens.');
	}

	return db.transaction(async (tx) => {
		/* New shelves go on the end. Defaulting to 0 would drop every category an
		   operator creates in front of the ones the seed ordered deliberately, so
		   adding one would silently reorder the shop's filter row. */
		const [{ next }] = await tx
			.select({ next: raw<number>`coalesce(max(${productCategories.position}), 0) + 1` })
			.from(productCategories);

		const [category] = await tx
			.insert(productCategories)
			.values({ slug, name: trimmed, position: next, createdBy: actorId })
			.returning();

		await recordAudit(
			{
				action: 'catalog.category_created',
				actorId,
				metadata: { categoryId: category.id, slug: category.slug, name: category.name }
			},
			tx
		);

		return category;
	});
}

/**
 * Remove a shelf. The products on it survive, unfiled.
 *
 * That is the `set null` on `products.category_id` doing the work rather than
 * anything here, and it is why this does not need to refuse when the category
 * is in use. The count is read first only so the audit row says how many
 * products were unfiled - after the delete there is no way to ask.
 */
export async function deleteCategory(categoryId: string, actorId: string): Promise<string> {
	if (!isUuid(categoryId)) throw new CatalogError('That category no longer exists.');

	return db.transaction(async (tx) => {
		const [category] = await tx
			.select()
			.from(productCategories)
			.where(eq(productCategories.id, categoryId))
			.limit(1);
		if (!category) throw new CatalogError('That category no longer exists.');

		const [{ count }] = await tx
			.select({ count: raw<number>`count(*)::int` })
			.from(products)
			.where(eq(products.categoryId, categoryId));

		await tx.delete(productCategories).where(eq(productCategories.id, categoryId));

		await recordAudit(
			{
				action: 'catalog.category_deleted',
				actorId,
				metadata: {
					categoryId,
					slug: category.slug,
					name: category.name,
					productsUnfiled: count
				}
			},
			tx
		);

		return category.name;
	});
}

/* ── products ────────────────────────────────────────────────────────────── */

export async function productBySlug(slug: string): Promise<CatalogProduct | null> {
	const [row] = await db.select().from(products).where(eq(products.slug, slug)).limit(1);
	return row ? withOptions(row) : null;
}

export async function productById(id: string): Promise<CatalogProduct | null> {
	if (!isUuid(id)) return null;
	const [row] = await db.select().from(products).where(eq(products.id, id)).limit(1);
	return row ? withOptions(row) : null;
}

/**
 * A specific frozen version.
 *
 * What an order page reads to say what it bought. The whole reason
 * `product_revisions` exists: without it an order records "version 3" and
 * nothing can say what version 3 was, which is the same amount of information
 * as recording nothing.
 */
export async function revisionFor(
	productId: string,
	version: number,
	/* The caller's transaction, when there is one.
     Without this the purchase path asked the POOL for a second connection while
     already holding one for its transaction - so ten concurrent buys held all
     ten slots, each waiting for an eleventh that could not exist, with a FOR
     UPDATE on the product row for the duration. The shop deadlocked itself at
     exactly `max`. Reading through the caller's handle also keeps the revision
     inside the transaction's snapshot, which is what the comment at the call
     site claims is happening. */
	handle: DbHandle = db
): Promise<ProductRevision | null> {
	const [row] = await handle
		.select()
		.from(productRevisions)
		.where(and(eq(productRevisions.productId, productId), eq(productRevisions.version, version)))
		.limit(1);
	return row ?? null;
}

/** Every version of one product, newest first. The price history, which is what
 *  an operator is asking for when they ask why an old order cost that. */
export async function revisionsFor(productId: string): Promise<ProductRevision[]> {
	return db
		.select()
		.from(productRevisions)
		.where(eq(productRevisions.productId, productId))
		.orderBy(desc(productRevisions.version));
}

/* ── whether it can be bought ────────────────────────────────────────────── */

/**
 * Every reason a product cannot be bought right now, in one place.
 *
 * Returned as a reason rather than a boolean because the shop has to say which
 * one, and a boolean means the copy is written from a second, parallel set of
 * conditions that can disagree with the check. This is presentation; the
 * purchase transaction re-derives all of it under the lock, because the catalog
 * is advisory until the server rechecks it.
 */
export type Unbuyable =
	| { reason: 'inactive' }
	| { reason: 'not_yet'; from: Date }
	| { reason: 'closed'; until: Date }
	| { reason: 'out_of_stock' }
	| { reason: 'misconfigured'; detail: string };

export function purchasabilityOf(product: CatalogProduct, now = new Date()): Unbuyable | null {
	if (product.optionError) {
		/* A product whose option schema does not parse cannot be sold, because the
       submitted values could not be checked against anything. Refusing is the
       only safe direction: the alternative is selling it with no options
       recorded, which produces an order nobody can fulfil. */
		return { reason: 'misconfigured', detail: product.optionError };
	}
	if (!product.active) return { reason: 'inactive' };
	if (product.availableFrom && product.availableFrom > now) {
		return { reason: 'not_yet', from: product.availableFrom };
	}
	if (product.availableUntil && product.availableUntil <= now) {
		return { reason: 'closed', until: product.availableUntil };
	}
	if (product.stock !== null && product.stock <= 0) {
		return { reason: 'out_of_stock' };
	}
	return null;
}

/* ── writing ─────────────────────────────────────────────────────────────── */

/** The fields an operator sets. Split from the row type because `version`,
 *  `stock` and the timestamps are not theirs to write directly. */
export type ProductDraft = {
	slug: string;
	name: string;
	description: string | null;
	imageUrl: string | null;
	/** Breathing room around the picture on a card, in CSS pixels. */
	imagePadding: number;
	/** Where it sits among products at the same price, low first. */
	position: number;
	/** The rest of the gallery, in the order it is shown. Empty for the ordinary
	 *  product with one photograph; stored as null in that case, so "no gallery"
	 *  is one value in the column rather than two. */
	images: string[];
	kind: ProductKind;
	/** The shelf, or null for unfiled. Checked against the table rather than
	 *  trusted, because a category can be deleted between this form rendering
	 *  and it being submitted - see `resolveCategory`. */
	categoryId: string | null;
	price: number;
	perUserLimit: number | null;
	requiresEligibility: boolean;
	optionSchema: JsonValue;
	availableFrom: Date | null;
	availableUntil: Date | null;
	/** ISO 3166-1 alpha-2 codes of the countries it cannot reach. Empty for
	 *  everywhere. See $lib/shop/regions.ts. */
	blockedCountries: string[];
	active: boolean;
	stock: number | null;
};

export class CatalogError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CatalogError';
	}
}

/**
 * The gallery as the column holds it: cleaned URLs, or null for none.
 *
 * Null rather than `[]`, so "this product has no gallery" is one value and not
 * two that every reader would have to treat alike. `cleanUrl` runs again here
 * even though `validateDraft` has already refused anything it would reject -
 * the write sites are what actually reach the column, and a second pass costs
 * nothing next to trusting a caller to have validated first.
 */
function galleryOf(draft: ProductDraft): string[] | null {
	const cleaned = draft.images.map(cleanUrl).filter((url): url is string => url !== null);
	return cleaned.length > 0 ? cleaned : null;
}

/** Checks that belong to the shape of a product rather than to the database.
 *  Run before either write, so the two cannot diverge in what they accept. */
function validateDraft(draft: ProductDraft): void {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug)) {
		throw new CatalogError('The slug must be lowercase letters, digits and single hyphens.');
	}
	if (!draft.name.trim()) throw new CatalogError('A product needs a name.');
	/* Said out loud rather than quietly dropped. The write sites run the same
	   `cleanUrl` and would store null for anything that is not http(s), which is
	   safe and silent - and silent is wrong on an operator form, where a picture
	   that simply never appears is a bug somebody spends an afternoon on. */
	if (draft.imageUrl?.trim() && !cleanUrl(draft.imageUrl)) {
		throw new CatalogError('The image URL must be an http or https link.');
	}
	/* The gallery, said out loud for the same reason the cover is: these are
	   typed into a box one per line, and a line that is not a URL becomes a
	   picture that never appears rather than an error anybody can act on. The
	   bound is the one the check constraint holds. */
	if (draft.images.length > MAX_GALLERY) {
		throw new CatalogError(`A product may have at most ${MAX_GALLERY} gallery pictures.`);
	}
	for (const image of draft.images) {
		if (!cleanUrl(image)) {
			throw new CatalogError(`"${image}" is not an http or https link.`);
		}
	}
	/* The same bounds the check constraint holds, said here so an operator gets a
	   sentence rather than a 500 from the driver. 64px is most of a card
	   thumbnail's height - past it there is no picture left to pad. */
	if (!Number.isInteger(draft.imagePadding) || draft.imagePadding < 0 || draft.imagePadding > 64) {
		throw new CatalogError('Image padding must be a whole number of pixels between 0 and 64.');
	}
	if (!Number.isInteger(draft.position) || draft.position < -9999 || draft.position > 9999) {
		throw new CatalogError('The position must be a whole number between -9999 and 9999.');
	}
	if (!Number.isInteger(draft.price) || draft.price <= 0) {
		throw new CatalogError('The price must be a whole number of seconds above zero.');
	}
	if (
		draft.perUserLimit !== null &&
		(!Number.isInteger(draft.perUserLimit) || draft.perUserLimit <= 0)
	) {
		throw new CatalogError('The per-person limit must be a whole number above zero, or blank.');
	}
	if (draft.stock !== null && (!Number.isInteger(draft.stock) || draft.stock < 0)) {
		throw new CatalogError('Stock must be a whole number of zero or more, or blank for unlimited.');
	}
	if (draft.availableFrom && draft.availableUntil && draft.availableFrom >= draft.availableUntil) {
		throw new CatalogError('The availability window opens after it closes.');
	}
	for (const code of draft.blockedCountries) {
		if (!isCountryCode(code)) throw new CatalogError(`"${code}" is not a country code.`);
	}

	const parsed = parseOptionSchema(draft.optionSchema);
	if (!parsed.ok) throw new CatalogError(parsed.error);
}

/**
 * The submitted category, confirmed to exist - inside the caller's transaction.
 *
 * Unfiled is the empty answer and needs no lookup. Anything else is checked,
 * because the alternative is handing an id straight to the insert and letting
 * the foreign key decide: a category deleted between this form rendering and
 * being submitted would then surface as a Postgres constraint name in a 500,
 * rather than as a sentence saying the shelf is gone. It is a small race and a
 * real one - the delete button is on the page the operator came from.
 */
async function resolveCategory(categoryId: string | null, tx: DbHandle): Promise<string | null> {
	if (!categoryId) return null;
	if (!isUuid(categoryId)) throw new CatalogError('That category no longer exists.');

	const [row] = await tx
		.select({ id: productCategories.id })
		.from(productCategories)
		.where(eq(productCategories.id, categoryId))
		.limit(1);
	if (!row)
		throw new CatalogError('That category no longer exists - it may have just been deleted.');
	return row.id;
}

/** Write a revision row. Called by both create and update, so version 1 has a
 *  revision exactly like every later version does - a product whose history
 *  starts at version 2 is one whose first orders point at nothing. */
async function writeRevision(product: Product, actorId: string, tx: DbHandle): Promise<void> {
	await tx.insert(productRevisions).values({
		productId: product.id,
		version: product.version,
		name: product.name,
		description: product.description,
		kind: product.kind,
		currency: product.currency,
		price: product.price,
		perUserLimit: product.perUserLimit,
		requiresEligibility: product.requiresEligibility,
		optionSchema: product.optionSchema,
		changedBy: actorId
	});
}

export async function createProduct(draft: ProductDraft, actorId: string): Promise<Product> {
	validateDraft(draft);

	return db.transaction(async (tx) => {
		const categoryId = await resolveCategory(draft.categoryId, tx);

		const [product] = await tx
			.insert(products)
			.values({
				slug: draft.slug,
				name: draft.name.trim(),
				description: draft.description?.trim() || null,
				imageUrl: cleanUrl(draft.imageUrl),
				imagePadding: draft.imagePadding,
				position: draft.position,
				images: galleryOf(draft),
				kind: draft.kind,
				categoryId,
				currency: 'seconds',
				price: draft.price,
				stock: draft.stock,
				perUserLimit: draft.perUserLimit,
				requiresEligibility: draft.requiresEligibility,
				optionSchema: draft.optionSchema ?? null,
				availableFrom: draft.availableFrom,
				availableUntil: draft.availableUntil,
				blockedCountries: [...new Set(draft.blockedCountries)].sort(),
				active: draft.active,
				version: 1,
				updatedBy: actorId
			})
			.returning();

		await writeRevision(product, actorId, tx);

		await recordAudit(
			{
				action: 'catalog.created',
				actorId,
				metadata: {
					productId: product.id,
					slug: product.slug,
					price: product.price,
					kind: product.kind,
					active: product.active
				}
			},
			tx
		);

		return product;
	});
}

/**
 * Change a product.
 *
 * The version bumps only when something an order's meaning depends on has
 * changed. That comparison is done against the row as it is right now, inside
 * the transaction, so two operators editing at once cannot both decide nothing
 * material changed and skip the revision.
 *
 * Stock is written here too, but never causes a bump - see the note at the top
 * of the file.
 */
export async function updateProduct(
	productId: string,
	draft: ProductDraft,
	actorId: string
): Promise<Product> {
	validateDraft(draft);

	/* Checked before the id reaches a uuid column. A malformed one is 22P02 from
	   the driver - a 500 on a route parameter anyone holding `manage_catalog` can
	   edit - where every other reader in this file answers "no such row". Same
	   guard, same reason, as `productById`. */
	if (!isUuid(productId)) throw new CatalogError('That product no longer exists.');

	return db.transaction(async (tx) => {
		const [current] = await tx
			.select()
			.from(products)
			.where(eq(products.id, productId))
			.for('update')
			.limit(1);

		if (!current) throw new CatalogError('That product no longer exists.');

		/**
		 * The invite's slug is the one string in this table that code depends on.
		 *
		 * The shop finds the pinned card by it and the dashboard decides whether
		 * the goal is met by it (see lib/shop/invite.ts), and neither has any way
		 * to notice it was renamed - the card would simply stop being pinned and
		 * the meter would stop knowing the invite had been bought, both silently,
		 * both looking like something else. Everything else about the product is
		 * an operator's to change, including the name they see on the card.
		 */
		if (current.slug === INVITE_SLUG && draft.slug !== current.slug) {
			throw new CatalogError(
				`The invite's slug is fixed at "${INVITE_SLUG}" - the shop and the home page find it by that. Everything else about it can be edited.`
			);
		}
		if (current.slug === REFERRAL_STICKERS_SLUG && draft.slug !== current.slug) {
			throw new CatalogError(
				`The referral stickers' slug is fixed at "${REFERRAL_STICKERS_SLUG}" - the invite card and the free claim find them by that.`
			);
		}

		const categoryId = await resolveCategory(draft.categoryId, tx);

		/* Note what is NOT in this list: the category, and the countries it is
		   blocked in. Neither is an economically relevant edit - an order's
		   meaning does not depend on which shelf the shop had the thing on, or on
		   where else it could have shipped - so both write through without
		   bumping the version, exactly as stock and the availability window do. */
		const material =
			current.name !== draft.name.trim() ||
			current.description !== (draft.description?.trim() || null) ||
			current.kind !== draft.kind ||
			current.price !== draft.price ||
			current.perUserLimit !== draft.perUserLimit ||
			current.requiresEligibility !== draft.requiresEligibility ||
			JSON.stringify(current.optionSchema ?? null) !== JSON.stringify(draft.optionSchema ?? null);

		const version = material ? current.version + 1 : current.version;

		const [updated] = await tx
			.update(products)
			.set({
				slug: draft.slug,
				name: draft.name.trim(),
				description: draft.description?.trim() || null,
				imageUrl: cleanUrl(draft.imageUrl),
				imagePadding: draft.imagePadding,
				position: draft.position,
				images: galleryOf(draft),
				kind: draft.kind,
				categoryId,
				price: draft.price,
				stock: draft.stock,
				perUserLimit: draft.perUserLimit,
				requiresEligibility: draft.requiresEligibility,
				optionSchema: draft.optionSchema ?? null,
				availableFrom: draft.availableFrom,
				availableUntil: draft.availableUntil,
				blockedCountries: [...new Set(draft.blockedCountries)].sort(),
				active: draft.active,
				version,
				updatedAt: new Date(),
				updatedBy: actorId
			})
			.where(eq(products.id, productId))
			.returning();

		if (material) await writeRevision(updated, actorId, tx);

		await recordAudit(
			{
				action: 'catalog.updated',
				actorId,
				metadata: {
					productId,
					slug: updated.slug,
					version,
					versioned: material,
					/* The before/after that matters most, named rather than diffed, so
             the audit row answers the question people actually ask of it. */
					priceFrom: current.price,
					priceTo: updated.price,
					activeFrom: current.active,
					activeTo: updated.active,
					stockFrom: current.stock,
					stockTo: updated.stock,
					blockedCountriesFrom: current.blockedCountries,
					blockedCountriesTo: updated.blockedCountries
				}
			},
			tx
		);

		return updated;
	});
}

/**
 * Put units back, or take them away, without touching the version.
 *
 * Its own function because restocking a rejected order is an explicit action -
 * the platform baseline says stock restoration must be separate from the refund
 * - and because a guarded relative update is the only correct way to do it
 * concurrently. `stock + delta` computed in SQL, so two restocks landing at once
 * add two units rather than one of them reading a stale number and writing it
 * back.
 *
 * Refuses to write on a product with unlimited stock rather than silently doing
 * nothing: a caller trying to restock something that has no stock has made a
 * mistake worth seeing.
 */
export async function adjustStock(
	productId: string,
	delta: number,
	handle: DbHandle = db
): Promise<number | null> {
	if (delta === 0) return null;

	const [updated] = await handle
		.update(products)
		.set({
			stock: raw`greatest(0, ${products.stock} + ${delta})`,
			updatedAt: new Date()
		})
		.where(and(eq(products.id, productId), raw`${products.stock} is not null`))
		.returning({ stock: products.stock });

	return updated?.stock ?? null;
}
