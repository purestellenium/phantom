/**
 * Where a person came from, when a partner sent them: a link carrying
 * `?utm_source=stardance` (or `?utm_medium=email`, for our own mail) is
 * remembered in a cookie on
 * the first visit, and written onto the account when it is created - see
 * hooks.server.ts and the HCA callback. The console's funnel filters by it.
 *
 * An allowlist, deliberately. A free-text source is a column anybody can
 * write junk into by editing a link, and a funnel split by a thousand typos
 * says nothing. A new partner is a line here.
 */
export const REFERRAL_SOURCES = {
	stardance: 'Stardance',
	toolbox: 'Toolbox',
	/* Not a partner: anything we send by email, named by `utm_medium` rather
	   than `utm_source` - see referralFrom. */
	email: 'an email'
} as const;
export type ReferralSource = keyof typeof REFERRAL_SOURCES;

/** The cookie that carries a source from the first visit to the signup. */
export const REFERRAL_COOKIE = 'phantom_ref';
/** How long an arrival counts: long enough to sign up next week, not a
 *  source credited for a visit months ago. */
export const REFERRAL_MAX_AGE = 30 * 24 * 60 * 60;

export function isReferralSource(value: string | null | undefined): value is ReferralSource {
	return !!value && Object.hasOwn(REFERRAL_SOURCES, value);
}

/** The known source a URL names, if any: `utm_source`, matched
 *  case-insensitively against the allowlist, or else `email` for a link
 *  carrying `utm_medium=email`. A partner wins over the medium, so a partner's
 *  own newsletter is still credited to the partner. `ref` used to name a
 *  partner too; it is a participant's invite code now - see INVITE_PARAM. */
export function referralFrom(url: URL): ReferralSource | null {
	const value = url.searchParams.get('utm_source')?.trim().toLowerCase();
	if (isReferralSource(value)) return value;
	const medium = url.searchParams.get('utm_medium')?.trim().toLowerCase();
	return medium === 'email' ? 'email' : null;
}

/* ── personal invites ────────────────────────────────────────────────────── */

/**
 * A participant's own invite link: `?ref=<code>`. Kept apart from
 * `utm_source`, which names a partner from the allowlist above - a code is
 * one person, and mixing the two would let a typo in a partner link credit a
 * stranger.
 */
export const INVITE_PARAM = 'ref';
/** The cookie that carries a code to the signup - the latest one followed,
 *  unlike a partner source (see hooks.server.ts). The same thirty days. */
export const INVITE_COOKIE = 'phantom_invite';

const INVITE_CODE = /^[A-Za-z0-9]{5}$/;

export function isInviteCode(value: string | null | undefined): value is string {
	return !!value && INVITE_CODE.test(value);
}

/** The well-formed invite code a URL carries, if any. Case matters - `aB3xY`
 *  and `ab3xy` are different people. Whether it names a real person is only
 *  known at signup, when the account is written. */
export function inviteCodeFrom(url: URL): string | null {
	const value = url.searchParams.get(INVITE_PARAM)?.trim();
	return isInviteCode(value) ? value : null;
}

/**
 * What inviting friends earns, by how many of them qualified - finished
 * onboarding and were found eligible. Each pays once, when it is reached.
 *
 * `seconds: null` is the stickers: not hours, but a free order of the product
 * at REFERRAL_STICKERS_SLUG, claimed through the shop so it gets an address
 * and a place in the fulfilment list like anything else.
 */
export const REFERRAL_MILESTONES = [
	{ count: 1, seconds: null },
	{ count: 3, seconds: 30 * 60 },
	{ count: 5, seconds: 60 * 60 },
	{ count: 15, seconds: 3 * 60 * 60 }
] as const satisfies readonly { count: number; seconds: number | null }[];

/** The reserved slug of the stickers the first referral earns. Like the
 *  invite's, fixed so the shop and the purchase can find the row. */
export const REFERRAL_STICKERS_SLUG = 'referral-stickers';
