/**
 * Is this string shaped like a uuid?
 *
 * Postgres refuses a malformed uuid with 22P02, and that refusal arrives as a
 * thrown driver error rather than as a value a caller can branch on - so
 * `orderById("")` was a 500 rather than the null every call site was written to
 * handle. Any onboarded participant could reach one by omitting a form field.
 *
 * Checked at the readers rather than at each action, because "an id that cannot
 * name a row" and "an id that names no row" are the same answer to the caller,
 * and there is one of these functions per table but eight call sites.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
	return UUID.test(value);
}
