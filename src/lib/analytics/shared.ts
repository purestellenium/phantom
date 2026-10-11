/**
 * What the browser and server halves of analytics agree on: the segment every
 * event carries, and how a URL is cleaned before it leaves for Plausible.
 *
 * Pure and import-free, so both lib/analytics/client.ts and
 * lib/server/analytics.ts can use it - the tracker package touches `window`
 * and cannot be imported on the server.
 */

/**
 * The kind of person behind an event, never the person.
 *
 * Attached to every pageview and every custom event, so any chart in Plausible
 * can be split by it: who reads the guides (participants who have onboarded, or
 * people still in setup?), whether invited people ship more than partner
 * arrivals, which signup week explores the most. Each value is a small, closed
 * set - a role, a yes/no, an ISO week - so no combination of them narrows to
 * one account in a way an id would.
 */
export type Segment = {
	signed_in: 'yes' | 'no';
	/** The users.role column, or 'anonymous'. Lets staff traffic be filtered out. */
	role: string;
	onboarded: 'yes' | 'no';
	/** The stored eligibility decision: eligible, ineligible, undetermined. */
	eligibility: string;
	/** How the account arrived: 'invite' (a participant's code), a partner key
	 *  from lib/referral.ts, or 'direct'. */
	arrived_via: string;
	/** The ISO week the account was created, e.g. '2026-W41'. */
	cohort: string;
};

export const ANONYMOUS: Segment = {
	signed_in: 'no',
	role: 'anonymous',
	onboarded: 'no',
	eligibility: 'none',
	arrived_via: 'none',
	cohort: 'none'
};

/** What the root layout hands the browser: where to send, and who is sending. */
export type AnalyticsConfig = {
	domain: string;
	endpoint: string;
	segment: Segment;
};

/** ISO 8601 week, '2026-W41'. Thursday decides the year, as the standard says. */
export function isoWeek(date: Date): string {
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
	const start = Date.UTC(d.getUTCFullYear(), 0, 1);
	const week = Math.ceil(((d.getTime() - start) / 86_400_000 + 1) / 7);
	return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi;

/**
 * A URL as Plausible may see it.
 *
 * - Order and user UUIDs in the path become `:id`, so /orders/<uuid> is one
 *   page on the dashboard rather than one page per order, and no id leaves.
 *   Project numbers stay: they are on explore for anybody to see, and "which
 *   projects get looked at" is a question worth answering.
 * - The query string is dropped except for `utm_*`. That takes out the OAuth
 *   `code` and `state`, the landing page's `?email=` hint, and everything else
 *   nobody vetted.
 * - A participant's invite code (`?ref=`) is a pseudonym for its owner, so it
 *   is not sent; the visit is credited to `utm_source=invite` instead, which
 *   puts invite traffic in Plausible's Sources report as one line. Who invited
 *   whom is in the console (/admin/referrals), not in a third party.
 */
export function scrubUrl(href: string): string {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return href;
	}
	const kept = new URLSearchParams();
	for (const [key, value] of url.searchParams) {
		if (key.startsWith('utm_')) kept.set(key, value);
	}
	if (url.searchParams.has('ref') && !kept.has('utm_source')) {
		kept.set('utm_source', 'invite');
		kept.set('utm_medium', 'referral');
	}
	const query = kept.toString();
	return `${url.origin}${url.pathname.replace(UUID_SEGMENT, '/:id')}${query ? `?${query}` : ''}`;
}

/** Plausible's props are strings; everything is stated as one, and empty
 *  values are left out rather than sent as 'null'. */
export function stringProps(
	properties: Record<string, string | number | boolean | null | undefined>
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(properties)) {
		if (value === null || value === undefined) continue;
		out[key] = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
	}
	return out;
}
