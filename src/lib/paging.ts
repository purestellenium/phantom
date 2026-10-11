/**
 * Loading a long grid a screen at a time.
 *
 * Both card grids that can run long - explore and your own projects - used to
 * send every row on the first render. The queries behind them were never the
 * problem: each is one or two statements whatever the count, and against a
 * database a long way off the round trip dominates so completely that fetching
 * sixty rows costs what fetching eighteen does. What it cost was everything
 * after the query: sixty cards serialised into the document, and sixty
 * screenshots the browser starts fetching at once, almost all of them for rows
 * nobody has scrolled to.
 *
 * So the first page is what fits on a screen or two and the rest arrives as it
 * is needed. Nothing here is server-only - no `$lib/server` import, no database
 * - because the component imports it.
 */

/**
 * Rows per page.
 *
 * Eighteen because the grid is `repeat(auto-fill, minmax(258px, 1fr))`: three
 * across on a normal window, four on a wide one, two on a narrow one. Eighteen
 * divides by all three, so the last row of a page is always full and the seam
 * between one page and the next never shows up as a half-empty row.
 */
export const PAGE_SIZE = 18;

/**
 * Ask the server for one more row than the page needs.
 *
 * That extra row IS the "is there more" answer, and it costs nothing: the
 * alternative is a second `count(*)` query - a whole extra round trip, ~175ms
 * against the real database - to learn a single boolean the first query could
 * already have told us. The caller slices it back off before rendering.
 *
 * `size` is for the callers that are not the card grid. The console's lists are
 * rows rather than cards, so eighteen of them is a short page with a lot of
 * empty screen under it; the shape of the trick is the same at any size, and
 * the size belongs to the surface rather than to the technique.
 */
export function pageWindow(offset: number, size = PAGE_SIZE): { limit: number; offset: number } {
	return { limit: size + 1, offset: Math.max(0, offset) };
}

/** Split a `size + 1` result into the page and whether another exists. Pass the
 *  same `size` the window was built with, or the extra row renders as content
 *  and every page quietly shows one row of the next. */
export function splitPage<T>(rows: readonly T[], size = PAGE_SIZE): { rows: T[]; more: boolean } {
	return { rows: rows.slice(0, size), more: rows.length > size };
}

/**
 * Run `onVisible` whenever the node is scrolled into view.
 *
 * A Svelte action rather than a scroll listener, because IntersectionObserver
 * is told once what to watch for and reports only when it happens - a scroll
 * handler runs on every frame of every scroll and then does the same arithmetic
 * by hand, badly. `rootMargin` fires it a screen early, so the next page is
 * usually already in by the time the reader reaches the bottom and the grid
 * simply continues instead of stopping to load.
 *
 * The callback is read through a getter rather than captured, so a component
 * that swaps it - `loadMore` becoming a no-op once everything is in - does not
 * need the observer torn down and rebuilt to make that take effect.
 */
export function onVisible(node: HTMLElement, onIntersect: () => void) {
	let callback = onIntersect;

	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) if (entry.isIntersecting) callback();
		},
		{ rootMargin: '600px 0px' }
	);
	observer.observe(node);

	return {
		update(next: () => void) {
			callback = next;
		},
		destroy() {
			observer.disconnect();
		}
	};
}
