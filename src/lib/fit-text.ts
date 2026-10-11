import type { Action } from 'svelte/action';

/**
 * `use:fitText` on a one-line control: if its text would wrap, it is set a
 * little smaller instead, a pixel at a time, until it fits on one line or
 * reaches the floor. Text that fits is left exactly as the stylesheet sets
 * it - this only ever steps down, and only for the element that needs it.
 *
 * Re-measured whenever the element changes size (a narrower grid column, a
 * price that changes), from the stylesheet's own size each time, so a card
 * that grows wider gets its full-size text back.
 */
export const fitText: Action<HTMLElement, { min?: number } | undefined> = (node, options) => {
	let min = options?.min ?? 12;
	node.style.whiteSpace = 'nowrap';

	const fit = () => {
		node.style.fontSize = '';
		let size = parseFloat(getComputedStyle(node).fontSize);
		while (node.scrollWidth > node.clientWidth && size > min) {
			size -= 1;
			node.style.fontSize = `${size}px`;
		}
	};

	const observer = new ResizeObserver(fit);
	observer.observe(node);
	/* The text itself changing - a running count - does not resize the box,
	   so it is watched too. */
	const mutations = new MutationObserver(fit);
	mutations.observe(node, { childList: true, subtree: true, characterData: true });
	fit();

	return {
		update(next) {
			min = next?.min ?? 12;
			fit();
		},
		destroy() {
			observer.disconnect();
			mutations.disconnect();
		}
	};
};
