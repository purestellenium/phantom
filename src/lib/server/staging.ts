import { dev } from '$app/environment';
import { env as runtime } from '$env/dynamic/private';

import type { HackatimeProjectSummary } from '$lib/server/auth/hackatime';
import type { HcaAddress } from '$lib/server/auth/hca';
import type { IdentitySignals } from '$lib/server/auth/eligibility';
import { providerConfigured } from '$lib/server/env';

/**
 * Staging mode: the app with no identity providers behind it, for developing
 * against without registering an HCA program or a Hackatime application.
 *
 * On under `vite dev` with `STAGING=1`, and also by default there when HCA has
 * no credentials - a checkout with nothing configured has no other way in.
 * `STAGING=0` turns it off. Never outside `vite dev`: the `dev` flag is baked
 * in at build time, so a production build cannot be put into this mode by any
 * environment it is given - which matters, because what follows is a sign-in
 * that asks nobody.
 *
 * What changes, and nothing else does:
 *
 * - Signing in. Any page in the signed-in shell, and the log-in button, sign
 *   the browser in as one local developer account (created on first use) with
 *   a real session row and cookie, so sign-out, the sessions list and every
 *   audit write behave as they do for anyone. Its role comes from
 *   `STAGING_ROLE` (default `owner`) and follows the variable on every request.
 * - Hackatime. Everybody is linked, and the projects list is the fixed one
 *   below, so the project form, the hours and the review panel have something
 *   to show.
 * - HCA after sign-in. Every re-check observes a verified, youth-eligible
 *   identity, and everybody has the one address below to ship to.
 * - Screenshots, when there is no CDN_API_KEY: the upload returns a
 *   placeholder picture (lib/server/cdn.ts), since shipping requires one.
 *
 * Slack and Airtable already settle as deferred when their variables are
 * unset, so they need nothing here.
 *
 * The fakes are here, with nothing but type imports, so the provider modules
 * can read them without a cycle; the sign-in is in auth/staging-session.ts.
 */
const requested = runtime.STAGING?.trim();
export const staging = dev && (requested === '1' || (!requested && !providerConfigured('hca')));

if (staging) {
	console.warn(
		`[staging] ${requested === '1' ? 'STAGING=1' : 'no HCA credentials'}: sign-in, Hackatime ` +
			'and HCA checks are faked for development. Set STAGING=0 to turn this off.'
	);
}

/* ── the fakes ───────────────────────────────────────────────────────────── */

/** What every HCA re-check observes: verified, and youth-eligible. */
export const STAGING_SIGNALS: IdentitySignals = {
	verificationStatus: 'verified',
	yswsEligibleClaim: true,
	identityCheckResult: 'verified_eligible',
	birthdate: null
};

/** The Hackatime account everybody is linked to. */
export function stagingHackatimeLink(): {
	accountId: string;
	scope: string | null;
	linkedAt: Date;
} {
	return {
		accountId: 'staging',
		scope: 'profile read',
		linkedAt: new Date('2026-08-06T00:00:00Z')
	};
}

/** Everybody's Hackatime projects, with totals since the cutoff. Fixed, so a
 *  second ship of the same project has no new time to claim unless another
 *  project is added to it. */
export const STAGING_HACKATIME_PROJECTS: HackatimeProjectSummary[] = [
	{ name: 'phantom-tracker', totalSeconds: 14 * 3600 + 25 * 60 },
	{ name: 'phantom tracker', totalSeconds: 2 * 3600 + 10 * 60 },
	{ name: 'pixel-garden', totalSeconds: 8 * 3600 + 5 * 60 },
	{ name: 'dotfiles', totalSeconds: 45 * 60 }
];

/** Everybody's one saved address, in HCA's field names so every reader of a
 *  real address reads this one the same way. */
export const STAGING_ADDRESSES: HcaAddress[] = [
	{
		id: 'staging-address',
		primary: true,
		label: 'Staging Developer, 15 Falls Rd, Shelburne, VT, US',
		raw: {
			id: 'staging-address',
			primary: true,
			first_name: 'Staging',
			last_name: 'Developer',
			line_1: '15 Falls Rd',
			city: 'Shelburne',
			state: 'VT',
			postal_code: '05482',
			country: 'US'
		}
	}
];
