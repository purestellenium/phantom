import type { Action } from 'svelte/action';

import { withScheme } from '$lib/url';

/**
 * `use:autoScheme` on a link field: "github.com/you/project" becomes
 * "https://github.com/you/project" instead of an error.
 *
 * A `type="url"` field refuses a link without its scheme, in the browser's
 * words, the moment its form is submitted - which is telling somebody off for
 * leaving out the one part of a link nobody types. So the scheme is filled in
 * as they leave the field, and on Enter. Both come before the browser's own
 * check: leaving a field to press a submit button blurs it before the click
 * lands, and Enter's keydown fires before it submits the form.
 *
 * The value is set through the element and announced with an `input` event,
 * so a `bind:value` on the same field hears about it the way it hears about
 * typing. The server makes the same repair (cleanUrl), so a form posted by
 * anything else is treated alike.
 */
export const autoScheme: Action<HTMLInputElement> = (node) => {
	const repair = () => {
		const fixed = withScheme(node.value);
		if (fixed === node.value) return;
		node.value = fixed;
		node.dispatchEvent(new Event('input', { bubbles: true }));
	};
	const onKey = (event: KeyboardEvent) => {
		if (event.key === 'Enter') repair();
	};

	node.addEventListener('blur', repair);
	node.addEventListener('keydown', onKey);
	return {
		destroy() {
			node.removeEventListener('blur', repair);
			node.removeEventListener('keydown', onKey);
		}
	};
};
