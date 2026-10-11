import { eq } from 'drizzle-orm';

import { normalizeCountry } from '$lib/countries';
import type { HcaAddress } from '$lib/server/auth/hca';
import { db } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';

/**
 * Which saved address to use.
 *
 * One rule, everywhere an address is chosen: the one asked for on this
 * request if it is real, else the person's default, else HCA's primary, else
 * the first. Read against the live list, so a default that has since been
 * deleted at Hack Club falls through rather than resolving to nothing.
 */
export function chooseAddress(
	list: HcaAddress[],
	preferred: { requestedId?: string | null; defaultId?: string | null }
): HcaAddress | undefined {
	return (
		list.find((address) => address.id === preferred.requestedId) ??
		list.find((address) => address.id === preferred.defaultId) ??
		list.find((address) => address.primary) ??
		list[0]
	);
}

/** Set (or clear) the person's default. The id is trusted only if it is in
 *  the list handed in, which the caller has just read from HCA. */
export async function setDefaultAddress(
	userId: string,
	list: HcaAddress[],
	addressId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (addressId !== null && !list.some((address) => address.id === addressId)) {
		return { ok: false, error: 'That address is not on your Hack Club account.' };
	}
	await db
		.update(users)
		.set({ defaultAddressId: addressId, updatedAt: new Date() })
		.where(eq(users.id, userId));
	/* A new default can be in a different country. */
	await rememberCountry(userId, list);
	return { ok: true };
}

/**
 * Store the country of the address Phantom would ship to, from a list just read.
 *
 * Called wherever the list is read anyway - every read from HCA, a change of
 * default, and once at sign-in - so `users.country` stays current without the
 * shop ever asking HCA itself. Same choice of address as everywhere else, minus
 * a per-request pick: the default, else HCA's primary, else the first. Written
 * only when it changed, so the usual read costs one select.
 */
export async function rememberCountry(userId: string, list: HcaAddress[]): Promise<void> {
	const [row] = await db
		.select({ defaultAddressId: users.defaultAddressId, country: users.country })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!row) return;

	const address = chooseAddress(list, { defaultId: row.defaultAddressId });
	/* The same two keys normalizeHcaAddress reads, without importing it - that
	   module imports this one. */
	const raw = address?.raw.country ?? address?.raw.country_code;
	const country = normalizeCountry(typeof raw === 'string' ? raw : null);
	if (country === row.country) return;

	await db.update(users).set({ country }).where(eq(users.id, userId));
}
