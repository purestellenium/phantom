import { ISO_NUMERIC } from '$lib/iso-numeric';

/**
 * Countries, by ISO 3166-1 alpha-2 code, with their English names.
 *
 * The codes are the ones $lib/iso-numeric.ts already lists for the analytics
 * map, so there is one list of countries in the repo rather than two that
 * disagree. Names come from the runtime's own `Intl.DisplayNames` - on the
 * server and in the browser alike - instead of a table typed out here.
 */

const names = new Intl.DisplayNames(['en'], { type: 'region' });

export type Country = { code: string; name: string };

/** Every country, sorted by name, for a picker. */
export const COUNTRIES: readonly Country[] = Object.keys(ISO_NUMERIC)
	.map((code) => ({ code, name: names.of(code) ?? code }))
	.sort((a, b) => a.name.localeCompare(b.name));

const byCode = new Map(COUNTRIES.map((country) => [country.code, country.name]));
const byName = new Map(COUNTRIES.map((country) => [country.name.toLowerCase(), country.code]));

export function isCountryCode(value: string): boolean {
	return byCode.has(value);
}

/** The English name for a code, or the code itself if it is not one we know. */
export function countryName(code: string): string {
	return byCode.get(code) ?? code;
}

/**
 * A country as an address states it, as a code - or null.
 *
 * HCA sends a code (`US`), but an address typed elsewhere may spell the name
 * out, so a name we recognise is accepted too. Anything else is null rather
 * than a guess: an unknown country blocks nothing, and a wrong one would.
 */
export function normalizeCountry(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	const upper = trimmed.toUpperCase();
	if (byCode.has(upper)) return upper;
	return byName.get(trimmed.toLowerCase()) ?? null;
}

/** Names for a list of codes, joined for a sentence: "Brazil, India and Nigeria". */
export function countryList(codes: readonly string[]): string {
	const list = codes.map(countryName);
	if (list.length <= 1) return list.join('');
	return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}
