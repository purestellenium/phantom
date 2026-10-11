import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { chooseAddress, setDefaultAddress } from '$lib/server/address';
import { recordEvent } from '$lib/server/analytics';
import { recordAudit } from '$lib/server/audit';
import { addressLines, fetchHcaAddresses, hcaAddressPortalUrl } from '$lib/server/auth/hca';
import { getLinkedHackatime } from '$lib/server/auth/hackatime';
import {
	getSession,
	listActiveSessions,
	requireOnboarded,
	revokeOtherSessions
} from '$lib/server/auth/session';
import { providerConfigured } from '$lib/server/env';

export const load: PageServerLoad = async () => {
	const user = requireOnboarded();
	const [hackatime, sessions] = await Promise.all([
		getLinkedHackatime(user.id),
		listActiveSessions(user.id)
	]);

	/* The addresses on the Hack Club account, for choosing which one phantom
	   ships to. Read live; edited at Hack Club. */
	let addresses: { id: string; primary: boolean; label: string; lines: string[] }[] = [];
	let addressError = false;
	try {
		const list = await fetchHcaAddresses(user.id);
		addresses = (list ?? []).map((address) => ({
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
		user: {
			avatarUrl: user.avatarUrl,
			displayName: user.displayName,
			email: user.email,
			slackId: user.slackId
		},
		addresses,
		addressError,
		defaultAddressId: chosen?.id ?? null,
		addressPortalUrl: hcaAddressPortalUrl(),
		hackatime,
		hackatimeConfigured: providerConfigured('hackatime'),
		currentSessionId: getSession()?.sessionId ?? null,
		sessions
	};
};

/**
 * Signing out everywhere else.
 *
 * The one account mutation a participant has. Everything else on the account
 * page belongs to Hack Club's own record and is read-only here for the reason
 * the page states: a form that appeared to change it would be editing a cache of
 * somebody else's row.
 *
 * It keeps the CURRENT session and revokes the rest. A version that signed you
 * out too would be a version nobody presses, because the reason to press it is
 * usually that you are on the one device you trust.
 *
 * It reads the session itself rather than taking a user id, so there is no
 * parameter that could name somebody else.
 */
export const actions: Actions = {
	defaultAddress: async ({ request }) => {
		const user = requireOnboarded();
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
		await recordAudit({
			action: 'account.default_address',
			actorId: user.id,
			subjectId: user.id,
			metadata: { addressId }
		});
		recordEvent('address.chosen', { where: 'account', cleared: addressId === null });
		return { savedAddress: true };
	},

	signOutOthers: async () => {
		const session = getSession();
		if (!session) redirect(303, '/');

		const revoked = await revokeOtherSessions(session.user.id, session.sessionId);

		/* Recorded even when it revoked nothing. "I pressed it and nothing was
		   signed out" is a real support conversation, and the answer to it is in
		   this row. */
		await recordAudit({
			action: 'session.revoked_others',
			actorId: session.user.id,
			subjectId: session.user.id,
			metadata: { revoked, keptSessionId: session.sessionId }
		});
		recordEvent('sessions.revoked_others', { revoked });

		redirect(303, '/account');
	}
};
