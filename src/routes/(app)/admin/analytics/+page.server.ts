import type { PageServerLoad } from './$types';

import { requireCapability } from '$lib/server/auth/authorize';
import { plausibleDomain } from '$lib/server/env';
import { listGuides } from '$lib/server/guides';
import {
	type DateRange,
	type Item,
	breakdown,
	statsConfigured,
	totals,
	visitorsOverTime
} from '$lib/server/plausible-stats';

/**
 * Plausible's numbers, drawn by the console (see lib/server/plausible-stats.ts
 * for why not its dashboard). Aggregate counts only - nothing sent to
 * Plausible names anybody (lib/server/analytics.ts) - so the same oversight
 * capability as the funnel beside it.
 */

const RANGES: DateRange[] = ['7d', '30d', 'all'];

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * The way through the program, as the events lib/server/analytics.ts sends.
 * The page draws it as one row: how many people reached each step.
 */
const PATH = [
	{ goal: 'signin.completed', label: 'signed in' },
	{ goal: 'onboarding.finished', label: 'onboarded' },
	{ goal: 'project.created', label: 'started a project' },
	{ goal: 'project.shipped', label: 'shipped' },
	{ goal: 'order.placed', label: 'bought something' }
] as const;

/** A breakdown narrowed to one custom event. Plausible only knows an event by
 *  name once it is a goal in the site's settings; until then this is empty. */
const goal = (name: string) => [['is', 'event:goal', [name]]];

export type LinkedItem = Item & { href: string | null };

/** One guide, how many opened it and how many read it to the end - null when
 *  guide.finished is not a goal in Plausible, so nothing could be counted. */
export type GuideRow = {
	slug: string;
	title: string;
	href: string;
	opened: number;
	finished: number | null;
};

/** Pages, made openable. A path with a placeholder in it - `/orders/:id`, as
 *  lib/analytics/shared.ts scrubs it - names no one page, so it stays text. */
function linked(items: Item[] | null): LinkedItem[] | null {
	const origin = `https://${plausibleDomain()}`;
	return (
		items?.map((item) => ({
			...item,
			href: item.label.startsWith('/') && !item.label.includes(':') ? origin + item.label : null
		})) ?? null
	);
}

/** What each area of the site is called, by the first segment of its paths. */
const AREAS: Record<string, string> = {
	'': 'landing page',
	home: 'home',
	projects: 'projects',
	explore: 'explore',
	shop: 'shop',
	guides: 'guides',
	onboarding: 'onboarding',
	orders: 'orders',
	account: 'account',
	admin: 'console'
};

export type Area = { key: string; label: string; n: number; pages: LinkedItem[] };

/**
 * Pages grouped by the area they are in - every project page under projects,
 * every product under shop - so the popular parts of the site rank before
 * the popular pages inside them. Each area keeps its own top pages to open.
 */
function areas(pages: LinkedItem[] | null): Area[] | null {
	if (!pages) return null;
	const grouped = new Map<string, Area>();
	for (const page of pages) {
		const key = page.label.split('/')[1] ?? '';
		const area = grouped.get(key) ?? { key, label: AREAS[key] ?? key, n: 0, pages: [] };
		area.n += page.n;
		area.pages.push(page);
		grouped.set(key, area);
	}
	return [...grouped.values()]
		.map((area) => ({ ...area, pages: area.pages.slice(0, 10) }))
		.sort((a, b) => b.n - a.n);
}

/**
 * Every guide, read or not - a guide nobody opens is as worth knowing as the
 * one everybody does - with its opens from the page views and its finishes
 * from guide.finished. Most opened first, then by title.
 */
function guideRows(opened: Item[] | null, finished: Item[] | null): GuideRow[] | null {
	if (!opened) return null;
	const opens = new Map(opened.map((item) => [item.label.replace(/^\/guides\//, ''), item.n]));
	const ends =
		finished && finished.length > 0 ? new Map(finished.map((i) => [i.label, i.n])) : null;
	return listGuides()
		.map((guide) => ({
			slug: guide.slug,
			title: guide.title,
			href: `https://${plausibleDomain()}/guides/${guide.slug}`,
			opened: opens.get(guide.slug) ?? 0,
			finished: ends ? (ends.get(guide.slug) ?? 0) : null
		}))
		.sort((a, b) => b.opened - a.opened || a.title.localeCompare(b.title));
}

/**
 * Segment values in words. The segment (lib/analytics/shared.ts) is written
 * for filtering - 'none', 'anonymous', 'yes' - and read here by a person.
 * Values that mean the same thing for a reader are added together.
 */
const WORDS: Record<string, string> = {
	none: 'not signed in',
	anonymous: 'not signed in',
	direct: 'came directly',
	invite: 'a friend’s invite',
	yes: 'onboarded',
	no: 'not yet',
	participant: 'participants'
};

function worded(items: Item[] | null): Item[] | null {
	if (!items) return null;
	const merged = new Map<string, number>();
	for (const item of items) {
		const label = WORDS[item.label] ?? item.label;
		merged.set(label, (merged.get(label) ?? 0) + item.n);
	}
	return [...merged].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
}

export const load: PageServerLoad = async ({ url }) => {
	requireCapability('view_audit');
	if (!statsConfigured()) return { range: '7d' as DateRange, configured: false as const };

	/* A chosen range is kept. With none chosen the page opens on the week -
	   unless the week is empty, as it is in a site's first days, and then on
	   all time, so the first look at it is never a page of zeros. The week's
	   totals are cached, so asking twice costs nothing. */
	const requested = RANGES.find((r) => r === url.searchParams.get('range'));
	const range: DateRange = requested ?? ((await totals('7d'))?.visitors ? '7d' : 'all');

	const [
		summary,
		days,
		goals,
		events,
		pages,
		guides,
		guidesFinished,
		searches,
		sources,
		campaigns,
		countries,
		roles,
		arrivedVia,
		onboarded,
		devices,
		cohorts
	] = await Promise.all([
		totals(range),
		visitorsOverTime(range),
		breakdown(range, 'event:goal', { limit: 50 }),
		breakdown(range, 'event:goal', { metric: 'events', limit: 50 }),
		breakdown(range, 'event:page', { metric: 'pageviews', limit: 500 }),
		breakdown(range, 'event:page', {
			filters: [['contains', 'event:page', ['/guides/']]],
			limit: 100
		}),
		breakdown(range, 'event:props:guide', { filters: goal('guide.finished'), limit: 100 }),
		breakdown(range, 'event:props:q', { metric: 'events', filters: goal('filter'), limit: 8 }),
		breakdown(range, 'visit:source', { limit: 6 }),
		breakdown(range, 'visit:utm_source', { limit: 6 }),
		breakdown(range, 'visit:country', { limit: 250 }),
		breakdown(range, 'event:props:role'),
		breakdown(range, 'event:props:arrived_via'),
		breakdown(range, 'event:props:onboarded'),
		breakdown(range, 'visit:device'),
		breakdown(range, 'event:props:cohort', { limit: 6 })
	]);

	/* Each step of the path: people who reached it, or null when the event is
	   not a goal in Plausible yet and so cannot be counted at all. */
	const reached = new Map(goals?.map((g) => [g.label, g.n]));
	const path = PATH.map((step) => ({
		label: step.label,
		goal: step.goal,
		n: reached.get(step.goal) ?? null
	}));

	return {
		range,
		configured: true as const,
		summary,
		days,
		path,
		/* Everything counted that is not a step of the path, by times it happened. */
		otherEvents: events?.filter((e) => !PATH.some((step) => step.goal === e.label)) ?? null,
		areas: areas(linked(pages)),
		guides: guideRows(guides, guidesFinished),
		searches,
		/* An untagged visit is most of them, and says nothing about the links. */
		sources,
		campaigns: campaigns?.filter((c) => c.label !== '(none)' && c.label !== '(not set)') ?? null,
		/* Plausible names a country by its ISO code here; the map matches on it,
		   and the list beside it says the name. */
		countries:
			countries?.map((c) => ({
				code: c.label,
				label: regionNames.of(c.label) ?? c.label,
				n: c.n
			})) ?? null,
		who: [
			{ question: 'signed in as', items: worded(roles) },
			{ question: 'arrived through', items: worded(arrivedVia) },
			{ question: 'setup', items: worded(onboarded) },
			{ question: 'on a', items: devices }
		],
		cohorts: cohorts?.filter((c) => c.label !== 'none') ?? null
	};
};
