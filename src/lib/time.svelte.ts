/**
 * Whether a timestamp may be drawn in the reader's own time zone yet.
 *
 * Every date on this platform is rendered on the server first, and the server
 * has no idea where the reader is - there is no request header that carries a
 * time zone. So a stamp is written in UTC for the server's pass and rewritten
 * in local time once the browser is running, and this flag is which of the two
 * is currently true.
 *
 * It is a rune rather than a check of `browser` from $app/environment, and the
 * difference is the whole reason this module exists. `browser` is already true
 * during hydration, so formatting on it would make the client's first render
 * disagree with the HTML it is hydrating - and Svelte trusts the server's text
 * nodes, so the disagreement does not resolve into local time. It stays UTC,
 * silently, which is the bug this looks like it would fix. Flipping a piece of
 * reactive state AFTER hydration is a change rather than a disagreement, and
 * every `{day(...)}` and `{stamp(...)}` in the tree re-runs because reading
 * this function inside them registers the dependency.
 *
 * The cost is one extra render of the timestamps on load. The formats are the
 * same width in both phases (see status.ts), so nothing moves under the
 * reader's eye - the digits just become theirs.
 */
let local = $state(false);

/** Whether to format in the reader's zone. Read from inside `day` and `stamp`,
 *  which is what subscribes their call sites to the flip below. */
export function inLocalTime(): boolean {
	return local;
}

/** Called once, from the root layout, after the first hydration. */
export function startLocalTime(): void {
	local = true;
}
