import { plausibleApiKey, plausibleDomain } from '$lib/server/env';

/**
 * Reading Plausible's numbers back, for the console's analytics page.
 *
 * Plausible serves its own dashboard with `frame-ancestors 'self'`, so it
 * cannot be framed here; instead the page asks the Stats API (v2,
 * POST /api/v2/query) for the same figures and draws them with the console's
 * own charts. The writing half - what is sent, and what may never be - is
 * lib/server/analytics.ts.
 *
 * Every answer is kept for a minute. The API allows 600 requests an hour per
 * key, the page asks about a dozen questions, and a few operators reloading
 * the console would otherwise spend that in an afternoon.
 */

const ENDPOINT = 'https://plausible.io/api/v2/query';
const FRESH_MS = 60_000;

export type DateRange = '7d' | '30d' | 'all';

/** The zone the site is set to in Plausible, which its dates are counted in. */
const SITE_TIME_ZONE = 'America/New_York';

/**
 * A range as the API is asked for it.
 *
 * Plausible's own '7d' and '30d' end YESTERDAY - the last whole days - so on a
 * launch day they read zero while the dashboard shows people on the site. The
 * console means "up to now", so those are sent as explicit dates ending today,
 * in the site's zone. 'all' already runs to today.
 */
function apiRange(range: DateRange): string | [string, string] {
	if (range === 'all') return 'all';
	const today = new Intl.DateTimeFormat('en-CA', { timeZone: SITE_TIME_ZONE }).format(new Date());
	const [y, m, d] = today.split('-').map(Number);
	const days = range === '7d' ? 7 : 30;
	const start = new Date(Date.UTC(y, m - 1, d - (days - 1))).toISOString().slice(0, 10);
	return [start, today];
}

type Row = { dimensions: string[]; metrics: number[] };
type Query = {
	metrics: string[];
	date_range: DateRange;
	dimensions?: string[];
	filters?: unknown[];
	order_by?: [string, 'asc' | 'desc'][];
	pagination?: { limit: number };
};

const cache = new Map<string, { at: number; answer: Promise<unknown> }>();

/** False when no key is set, which the page shows rather than an error. */
export function statsConfigured(): boolean {
	return plausibleApiKey() !== null;
}

/**
 * One answer from Plausible, kept for a minute under `key`, or null when it
 * would not give one - an outage, a bad key, a dimension the site has not
 * enabled. Never throws: one panel going blank is better than the page
 * failing. A refusal is not kept: the next load asks again.
 */
async function remember<T>(key: string, ask: () => Promise<T>): Promise<T | null> {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < FRESH_MS) {
		return (hit.answer as Promise<T>).catch(() => null);
	}
	const answer = ask();
	cache.set(key, { at: Date.now(), answer });
	try {
		return await answer;
	} catch (error) {
		cache.delete(key);
		console.error('plausible stats:', error instanceof Error ? error.message : error);
		return null;
	}
}

async function refused(response: Response): Promise<never> {
	throw new Error(`plausible ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

/** One Stats API query. */
async function query(body: Query): Promise<Row[] | null> {
	const key = plausibleApiKey();
	if (!key) return null;
	const payload = JSON.stringify({
		site_id: plausibleDomain(),
		...body,
		date_range: apiRange(body.date_range)
	});

	return remember(payload, async () => {
		const response = await fetch(ENDPOINT, {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: payload,
			signal: AbortSignal.timeout(8000)
		});
		if (!response.ok) {
			/* Narrowed to an event nobody has made a goal of yet. Not a failure:
			   nothing can have been counted under it, which is an empty answer,
			   kept for the minute like any other. */
			if (
				response.status === 400 &&
				/goal .* is not configured/.test(await response.clone().text())
			) {
				return [];
			}
			return refused(response);
		}
		return ((await response.json()) as { results: Row[] }).results;
	});
}

export type Totals = {
	visitors: number;
	visits: number;
	pageviews: number;
	bounceRate: number;
	visitDuration: number;
};

export async function totals(range: DateRange): Promise<Totals | null> {
	const rows = await query({
		metrics: ['visitors', 'visits', 'pageviews', 'bounce_rate', 'visit_duration'],
		date_range: range
	});
	const m = rows?.[0]?.metrics;
	if (!m) return null;
	return {
		visitors: m[0],
		visits: m[1],
		pageviews: m[2],
		bounceRate: m[3],
		visitDuration: m[4]
	};
}

/** Visitors per day, as the console's DayChart takes them. For 'all', per
 *  week, so a long history stays a readable number of columns. */
export async function visitorsOverTime(
	range: DateRange
): Promise<{ day: string; n: number }[] | null> {
	const rows = await query({
		metrics: ['visitors'],
		date_range: range,
		dimensions: [range === 'all' ? 'time:week' : 'time:day']
	});
	return rows?.map((row) => ({ day: row.dimensions[0], n: row.metrics[0] })) ?? null;
}

export type Item = { label: string; n: number };

/**
 * The top values of one dimension - `event:page`, `visit:source`,
 * `event:goal`, `event:props:role` - counted by `metric`.
 */
export async function breakdown(
	range: DateRange,
	dimension: string,
	options: { metric?: string; limit?: number; filters?: unknown[] } = {}
): Promise<Item[] | null> {
	const metric = options.metric ?? 'visitors';
	const rows = await query({
		metrics: [metric],
		date_range: range,
		dimensions: [dimension],
		filters: options.filters,
		order_by: [[metric, 'desc']],
		pagination: { limit: options.limit ?? 10 }
	});
	return rows?.map((row) => ({ label: row.dimensions[0] || '(none)', n: row.metrics[0] })) ?? null;
}

/* ── journeys ────────────────────────────────────────────────────────────── */

/**
 * One step of a journey as Plausible's exploration speaks it: a page
 * (`name: 'pageview'` with its path, or a whole section with
 * `includes_subpaths`), an event by name, or `__journey_end__` - leaving.
 */
export type JourneyStep = {
	name: string;
	pathname: string;
	label: string;
	includes_subpaths: boolean;
	subpaths_count: number;
	is_goal: boolean;
};

export type Journey = {
	/** What people did next (or, backwards, just before), most common first. */
	next: { step: JourneyStep; visitors: number }[];
	/** How many people made each step of the journey so far, in order. */
	funnel: {
		step: JourneyStep;
		visitors: number;
		conversion_rate: string;
		dropoff: number;
		dropoff_percentage: string;
	}[];
};

export const JOURNEY_END = '__journey_end__';

/**
 * The next column of a journey, and the funnel along the steps chosen so far.
 *
 * This is NOT the documented Stats API. The Stats API has no journeys, so this
 * asks the endpoint Plausible's own dashboard asks - /exploration/next-with-funnel
 * - which answers without a key because this site's dashboard is public. It is
 * internal to Plausible and can change without notice; when it does, this
 * returns null and the journeys panel says so, and nothing else on the page
 * depends on it. If the dashboard is ever made private, it needs a shared
 * link's auth sent as X-Shared-Link-Auth.
 */
export async function journey(
	range: DateRange,
	steps: JourneyStep[],
	direction: 'forward' | 'backward',
	search = ''
): Promise<Journey | null> {
	const dates = apiRange(range);
	const body = JSON.stringify({
		...(Array.isArray(dates)
			? { period: 'custom', from: dates[0], to: dates[1] }
			: { period: 'all' }),
		journey: JSON.stringify(
			steps.map(({ name, pathname, includes_subpaths, subpaths_count, is_goal }) => ({
				name,
				pathname,
				includes_subpaths,
				subpaths_count,
				is_goal
			}))
		),
		search_term: search,
		direction,
		include_funnel: steps.length > 0
	});
	const url = `https://plausible.io/api/stats/${encodeURIComponent(plausibleDomain())}/exploration/next-with-funnel/`;

	return remember(`journey:${body}`, async () => {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body,
			signal: AbortSignal.timeout(8000)
		});
		if (!response.ok) return refused(response);
		return (await response.json()) as Journey;
	});
}
