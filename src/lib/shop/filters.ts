import type { ProductKind } from '$lib/server/db/schema';

/**
 * How the shop is narrowed down, as a thing the URL can hold.
 *
 * The state lives in the query string rather than in a component, and that is
 * the whole design. A filtered shop is then a link somebody can send, a back
 * button that goes back one filter rather than off the page, and a reload that
 * lands where it left. It also means the filtering happens in the load, so the
 * page renders already narrowed instead of flashing the whole catalog and then
 * dropping most of it.
 *
 * Everything here is pure, and the shop page's component imports half of it -
 * which is why the one reference to `$lib/server` is `import type`. A type is
 * erased before Vite sees the module, so it cannot drag the schema (and the
 * database client behind it) into the browser bundle; a value import of the
 * same name would, and SvelteKit would refuse the build. The same reason
 * `readFilters` is handed the list of kinds rather than reading the enum
 * itself: the one caller is a server load, which has it.
 */

/** Absent from the URL, because it is what you get without asking. */
export const DEFAULT_SORT = 'cheapest';

export const SORTS = [
	{ key: 'cheapest', label: 'cheapest' },
	{ key: 'priciest', label: 'priciest' },
	{ key: 'a-z', label: 'a–z' },
	{ key: 'z-a', label: 'z–a' }
] as const;

export type SortKey = (typeof SORTS)[number]['key'];

/**
 * What `?category=` says for "the ones on no shelf at all".
 *
 * A reserved word rather than an empty value, because an empty value is what an
 * absent filter already looks like and the two mean opposite things: `?category=`
 * dropped entirely is every product, and this is the small pile that nobody has
 * filed. `product_categories.slug` is checked against the same
 * lowercase-hyphen grammar products use, so a real category could be called
 * `unfiled` and collide - which is why this is not that word.
 */
export const UNFILED = 'none';

export type Filters = {
	/** Null for every kind. */
	kind: ProductKind | null;
	/** A category slug, `UNFILED`, or null for every shelf. */
	category: string | null;
	sort: SortKey;
};

export const NO_FILTERS: Filters = { kind: null, category: null, sort: DEFAULT_SORT };

/**
 * Read the filters out of a URL, ignoring anything that is not one.
 *
 * Unrecognised values fall back rather than erroring. A query string is
 * something people edit, truncate and copy badly, and a shop that 500s on
 * `?sort=chepaest` is worse than one that shows you the cheapest first. Nothing
 * here is load-bearing: the same products are being listed either way, and the
 * URL is the only thing that would have been wrong.
 */
export function readFilters(params: URLSearchParams, kinds: readonly ProductKind[]): Filters {
	const kind = params.get('kind');
	const category = params.get('category');
	const sort = params.get('sort');

	return {
		kind: kinds.find((known) => known === kind) ?? null,
		category: category?.trim() || null,
		sort: SORTS.find((known) => known.key === sort)?.key ?? DEFAULT_SORT
	};
}

/**
 * The query string for a set of filters - `''` when none of them are set.
 *
 * Defaults are omitted rather than spelled out, so the unfiltered shop is
 * `/shop` and not `/shop?kind=&category=&sort=cheapest`. That matters because
 * the unfiltered URL is the one that gets linked to from everywhere else, and
 * two spellings of the same page is two cache entries and two things to keep
 * in step.
 */
export function filterQuery(filters: Filters): string {
	const params = new URLSearchParams();
	if (filters.kind) params.set('kind', filters.kind);
	if (filters.category) params.set('category', filters.category);
	if (filters.sort !== DEFAULT_SORT) params.set('sort', filters.sort);

	const query = params.toString();
	return query ? `?${query}` : '';
}

/** True when anything is narrowing the list. Sort is excluded on purpose: it
 *  reorders the shop but never hides anything, so "clear the filters" should
 *  not appear merely because somebody asked for a–z. */
export function isNarrowed(filters: Filters): boolean {
	return filters.kind !== null || filters.category !== null;
}

/** What a product needs to be sortable and filterable. Structural rather than
 *  the full row, so this file stays pure and the test for it does not need a
 *  database. */
export type Filterable = {
	name: string;
	price: number;
	/** The operator's order among products at the same price. */
	position: number;
	kind: ProductKind;
	categorySlug: string | null;
};

export function matches(product: Filterable, filters: Filters): boolean {
	if (filters.kind && product.kind !== filters.kind) return false;
	if (filters.category === UNFILED) return product.categorySlug === null;
	if (filters.category && product.categorySlug !== filters.category) return false;
	return true;
}

/**
 * Sort a copy, never the array handed in.
 *
 * Both price orders break ties on the operator's position and then on name,
 * and both name orders break ties on price, so every ordering here is total.
 * Without that, two products at the same price sit in whatever order the query
 * happened to return them, and the shop appears to reshuffle itself between
 * loads for no reason anybody can see.
 *
 * Position runs low-first under "priciest" too, rather than flipping with the
 * price. It says which of two equals an operator wants seen first, and that
 * answer does not change because the reader turned the price order around.
 */
export function sorted<T extends Filterable>(items: readonly T[], sort: SortKey): T[] {
	const byName = (a: T, b: T) => a.name.localeCompare(b.name);
	const byPrice = (a: T, b: T) => a.price - b.price;
	const byPosition = (a: T, b: T) => a.position - b.position;

	const compare: Record<SortKey, (a: T, b: T) => number> = {
		cheapest: (a, b) => byPrice(a, b) || byPosition(a, b) || byName(a, b),
		priciest: (a, b) => byPrice(b, a) || byPosition(a, b) || byName(a, b),
		'a-z': (a, b) => byName(a, b) || byPrice(a, b),
		'z-a': (a, b) => byName(b, a) || byPrice(a, b)
	};

	return [...items].sort(compare[sort]);
}
