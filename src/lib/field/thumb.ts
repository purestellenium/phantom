import type { Action } from 'svelte/action';

import { startThumb } from './field';

/** `use:thumbField={seed}` on a canvas: the field, cut to the canvas, seeded
 *  by a name. The placeholder for anything with no picture that is not a
 *  person - people get dither-kit's avatar. */
export const thumbField: Action<HTMLCanvasElement, string> = (canvas, seed) => {
	let stop = startThumb(canvas, seed);
	return {
		update(next) {
			stop();
			stop = startThumb(canvas, next);
		},
		destroy() {
			stop();
		}
	};
};
