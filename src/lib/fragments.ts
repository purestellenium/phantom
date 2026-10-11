/**
 * Fragments: what the shop is priced in, and what a balance holds.
 *
 * One fragment is six minutes - a tenth of an hour - so an hour of approved work
 * is ten fragments. The ledger still stores seconds (Hackatime counts them, Ari
 * grants minutes, every price and every past entry is in them), and this is
 * the one place seconds become fragments, for the reason status.ts gives for
 * hours: a second conversion somewhere else is how two pages end up
 * disagreeing about what the same number means.
 *
 * Fragments are whole. An approval is recorded at exactly Ari's minutes, but
 * what it credits is that rounded down to a whole fragment (`payoutSeconds`), so
 * every entry minted from here on is a whole number of fragments. Older entries
 * were minted in exact minutes, so a balance can still carry a remainder;
 * shown, it rounds toward zero, which never shows a fragment that cannot be
 * spent.
 */

/** Seconds in one fragment. */
export const FRAGMENT_SECONDS = 360;

/** Whole fragments in an amount of seconds, rounded toward zero - so a credit
 *  never shows more than it holds, and a debit never more than it took. */
export function toFragments(seconds: number): number {
	return Math.trunc(seconds / FRAGMENT_SECONDS);
}

/** The seconds a grant credits: rounded down to a whole fragment. */
export function payoutSeconds(seconds: number): number {
	return Math.max(0, Math.floor(seconds / FRAGMENT_SECONDS)) * FRAGMENT_SECONDS;
}

/** "1 fragment", "42 fragments" - for text that is read rather than looked at. */
export function fragments(seconds: number): string {
	const count = toFragments(seconds);
	return `${count.toLocaleString('en-US')} ${Math.abs(count) === 1 ? 'fragment' : 'fragments'}`;
}

/** The same, signed, for a ledger row where the direction is the point. */
export function signedFragments(seconds: number): string {
	const rendered = fragments(Math.abs(seconds));
	return seconds < 0 ? `−${rendered}` : `+${rendered}`;
}
