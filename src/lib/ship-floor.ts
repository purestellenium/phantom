/**
 * The floor on shipping, in one place for the two ends that ask about it:
 * `shipProject`, which refuses, and the project page, which greys out "ship it"
 * before anyone presses it. Two copies of this rule would drift.
 */

/** One hour. */
export const SHIP_MIN_SECONDS = 3600;

/**
 * How far short of the floor a ship would be, in seconds; 0 when it clears it.
 *
 * Always an hour in total. An update ship - one with an approved ship behind
 * it - also needs an hour of new time since that ship (see
 * projects/window.ts); `sinceLastShip` is that figure,
 * and null when there is no approved ship to count from. After a rejection the
 * new-time part is waived, because the fix is to the same work rather than
 * more of it.
 */
export function shipShortfall(
	claimedSeconds: number,
	sinceLastShip: number | null,
	afterRejection: boolean
): number {
	const total = SHIP_MIN_SECONDS - claimedSeconds;
	const fresh = afterRejection || sinceLastShip === null ? 0 : SHIP_MIN_SECONDS - sinceLastShip;
	return Math.max(0, total, fresh);
}
