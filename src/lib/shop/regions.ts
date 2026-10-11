import { countryName } from '$lib/countries';

/**
 * Products that cannot reach some countries.
 *
 * An operator lists the countries on the product (`products.blockedCountries`).
 * The shop then hides it from people whose stored country is one of them
 * (`users.country`), and checkout refuses it for an address in one - the same
 * shape as $lib/shop/locked.ts, which hides the shop from people held to the
 * event.
 *
 * A person whose country is not known is shown the product, with a notice
 * naming where it cannot go. Unknown blocks nothing; checkout still checks the
 * address the order would actually ship to.
 */
export function regionBlocked(
	blockedCountries: readonly string[],
	country: string | null | undefined
): boolean {
	return !!country && blockedCountries.includes(country);
}

export function regionBlockedMessage(country: string): string {
	return `This item is not available in ${countryName(country)}.`;
}
