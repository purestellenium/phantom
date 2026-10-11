import type { ProjectKind } from '$lib/server/db/schema';

/**
 * How explore is narrowed down and ordered, as a thing the URL can hold - the
 * shop's pattern (lib/shop/filters.ts), for the same reasons: a filtered
 * gallery is a link somebody can send, the back button walks back through
 * filters, and the page renders already filtered. Pure, and the one reference
 * to `$lib/server` is a type, so the page's component can import it.
 */

export const KINDS = [
	{ key: null, label: 'all types' },
	{ key: 'software', label: 'software' },
	{ key: 'hardware', label: 'hardware' }
] as const satisfies readonly { key: ProjectKind | null; label: string }[];

/** Absent from the URL, because it is what you get without asking. */
export const DEFAULT_SORT = 'recent';

export const SORTS = [
	{ key: 'recent', label: 'newest' },
	{ key: 'hours', label: 'most hours' },
	{ key: 'upvotes', label: 'most upvoted' }
] as const;

export type ExploreSort = (typeof SORTS)[number]['key'];

export type ExploreFilters = {
	/** Null for every type. */
	kind: ProjectKind | null;
	sort: ExploreSort;
	/** What was typed in the search box, trimmed; null for nothing. */
	q: string | null;
	/** Only hyper-chroma projects - where the "featured projects" panel's
	 *  "all hyper-chroma projects" link goes. Not one of the dropdowns: it is
	 *  reached from the panel, and said above the grid while it is on. */
	hyperChroma: boolean;
};

export const NO_FILTERS: ExploreFilters = {
	kind: null,
	sort: DEFAULT_SORT,
	q: null,
	hyperChroma: false
};

/** Long enough for any project name; short enough not to be a payload. */
const QUERY_MAX = 100;

/** Read the filters out of a URL. Anything unrecognised falls back to the
 *  default rather than erroring - a hand-edited query string is not worth a
 *  broken page. */
export function readExploreFilters(params: URLSearchParams): ExploreFilters {
	const kind = params.get('kind');
	const sort = params.get('sort');
	const q = params.get('q')?.trim().slice(0, QUERY_MAX) || null;
	return {
		kind: kind === 'software' || kind === 'hardware' ? kind : null,
		sort: SORTS.find((known) => known.key === sort)?.key ?? DEFAULT_SORT,
		q,
		hyperChroma: params.get('hc') === '1'
	};
}

/** The query string for a set of filters, `''` when none are set. Defaults are
 *  left out, so the plain gallery is plain `/explore`. */
export function exploreQuery(filters: ExploreFilters): string {
	const params = new URLSearchParams();
	if (filters.q) params.set('q', filters.q);
	if (filters.kind) params.set('kind', filters.kind);
	if (filters.sort !== DEFAULT_SORT) params.set('sort', filters.sort);
	if (filters.hyperChroma) params.set('hc', '1');
	const query = params.toString();
	return query ? `?${query}` : '';
}

/** Whether anything narrows the gallery - the sort only reorders it. */
export function isNarrowed(filters: ExploreFilters): boolean {
	return filters.kind !== null || filters.q !== null || filters.hyperChroma;
}
