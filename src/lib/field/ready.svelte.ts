/**
 * Whether the field has drawn its first real frame.
 *
 * Set once, by whichever Field.svelte is mounted (there is only ever one at a
 * time), and read by the loader (Loader.svelte) so it knows the ground behind it is
 * actually painted and not merely a mounted, still-black canvas - the same
 * distinction $lib/field/field's own `onFirstFrame` callback exists to draw.
 */
let ready = $state(false);

export const fieldReady = {
	get value() {
		return ready;
	},
	set() {
		ready = true;
	}
};
