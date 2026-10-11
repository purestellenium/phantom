import { dev } from '$app/environment';
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { chooseAddress, setDefaultAddress } from '$lib/server/address';
import { recordEvent } from '$lib/server/analytics';
import { getLinkedHackatime } from '$lib/server/auth/hackatime';
import { addressLines, fetchHcaAddresses, hcaAddressPortalUrl } from '$lib/server/auth/hca';
import { requireUser } from '$lib/server/auth/session';
import { providerConfigured } from '$lib/server/env';

/**
 * The one step with work on it: link Hackatime, and choose where things ship.
 *
 * Hackatime is the requirement - it is what counts the hours, and an account
 * that finishes without it looks ready and can earn nothing, so `finish` on the
 * next step refuses to complete without it. The address is the softer half:
 * prompted here, needed only to actually ship a project, and skippable now.
 */
export const load: PageServerLoad = async ({ url }) => {
	const user = requireUser();
	const preview = dev && url.searchParams.has('preview');

	if (user.onboardedAt && !preview) redirect(303, '/home');

	/* The addresses on the Hack Club account, for choosing a default. Read live -
	   Phantom holds none of its own - and defensively, so a Hack Club outage
	   leaves the address half unavailable rather than taking the step down. */
	let addresses: { id: string; primary: boolean; label: string; lines: string[] }[] = [];
	let addressError = false;
	try {
		const list = await fetchHcaAddresses(user.id);
		if (list === null) addressError = true;
		else
			addresses = list.map((address) => ({
				id: address.id,
				primary: address.primary,
				label: address.label,
				lines: addressLines(address.raw)
			}));
	} catch {
		addressError = true;
	}

	const chosen = chooseAddress(
		addresses.map((a) => ({ ...a, raw: {} })),
		{ defaultId: user.defaultAddressId }
	);

	return {
		preview,
		hackatime: await getLinkedHackatime(user.id),
		hackatimeConfigured: providerConfigured('hackatime'),
		addresses,
		addressError,
		defaultAddressId: chosen?.id ?? null,
		addressPortalUrl: hcaAddressPortalUrl()
	};
};

/**
 * Choosing a default address. The same mutation the account page owns, offered
 * here so it can be done during setup rather than only after - and, like there,
 * the id is trusted only if it is in the list we just read from Hack Club.
 */
export const actions: Actions = {
	saveAddress: async ({ request }) => {
		const user = requireUser();
		const form = await request.formData();
		const addressId = String(form.get('address_id') ?? '') || null;

		let list;
		try {
			list = await fetchHcaAddresses(user.id, { fresh: true });
		} catch {
			return fail(400, { error: 'Could not reach Hack Club to read your addresses. Try again.' });
		}
		if (list === null) {
			return fail(400, {
				error: 'Reconnect your Hack Club account so we can read your addresses.'
			});
		}

		const result = await setDefaultAddress(user.id, list, addressId);
		if (!result.ok) return fail(400, { error: result.error });
		recordEvent('address.chosen', { where: 'onboarding', cleared: addressId === null });

		return { savedAddress: true };
	}
};
