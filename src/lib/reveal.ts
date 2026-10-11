/**
 * Run something once the page is actually on screen.
 *
 * On a first load the page sits behind the loader (`is-loading` on <html>,
 * see Loader.svelte), and anything that animates on mount plays out unseen
 * behind the cover - a count-up that has finished by the time anybody can
 * look at it is just a number. So this waits for the loader to take the
 * class off, and runs straight away when it already has (every client-side
 * navigation after the first).
 *
 * Returns a cancel, for a component that unmounts while still waiting.
 */
export function whenRevealed(run: () => void): () => void {
	const root = document.documentElement;
	if (!root.classList.contains('is-loading')) {
		run();
		return () => {};
	}
	const observer = new MutationObserver(() => {
		if (root.classList.contains('is-loading')) return;
		observer.disconnect();
		run();
	});
	observer.observe(root, { attributes: true, attributeFilter: ['class'] });
	return () => observer.disconnect();
}

/** Whether motion is wanted. False on the server, where nothing moves. */
export function motionOk(): boolean {
	return (
		typeof window !== 'undefined' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}
