import { sql as raw } from 'drizzle-orm';
import { resolve } from '$app/paths';
import type { PageServerLoad } from './$types';

import { CONSOLE_CAPABILITIES, can, requireAnyCapability } from '$lib/server/auth/authorize';
import { db } from '$lib/server/db/client';
import {
	auditEvents,
	ledgerEntries,
	products,
	users,
	type Capability
} from '$lib/server/db/schema';
import { activityGlance } from '$lib/server/activity';
import { ariAttentionCount } from '$lib/server/ari-console';
import { lastRunPerJob, quietCount } from '$lib/server/jobs';
import { launchSettings } from '$lib/server/launch';
import { outboxCounts } from '$lib/server/outbox';
import { onboardingFunnel } from '$lib/server/funnel';
import { projectStatusCounts } from '$lib/server/projects/projects';
import { reviewerGlance } from '$lib/server/projects/reviewers';
import { referralGlance } from '$lib/server/referrals';
import { orderCounts } from '$lib/server/shop/orders';

/**
 * The console's front page: one card per section, each drawn only if the
 * reader holds the capability that page requires, and each carrying a
 * glimpse of what is behind it - a figure, a small series, a few lines - so
 * the state of the program is read here and the pages are for acting on it.
 */

export type SectionKey =
	| 'users'
	| 'activity'
	| 'catalog'
	| 'orders'
	| 'projects'
	| 'referrals'
	| 'reviewers'
	| 'funnel'
	| 'analytics'
	| 'ledger'
	| 'reconcile'
	| 'outbox'
	| 'ari'
	| 'jobs'
	| 'audit'
	| 'settings';

/* `href` is null for a card that is only a glance, with no page behind it. */
type Section = { key: SectionKey; href: string | null; label: string; needs: Capability };

/* The fulfilment page, when it exists, is one more entry here:
     { key: 'fulfilment', href: resolve('/admin/fulfilment'), label: 'fulfilment',
       needs: 'fulfil_orders' }
   and its +page.server.ts opens with requireCapability('fulfil_orders'). */
const SECTIONS: Section[] = [
	{ key: 'users', href: resolve('/admin/users'), label: 'people', needs: 'manage_users' },
	/* Aggregate counts only, so the same oversight capability as projects. */
	{
		key: 'activity',
		href: resolve('/admin/activity'),
		label: 'daily active',
		needs: 'view_audit'
	},
	{ key: 'catalog', href: resolve('/admin/catalog'), label: 'catalog', needs: 'manage_catalog' },
	{ key: 'orders', href: resolve('/admin/orders'), label: 'orders', needs: 'manage_orders' },
	/* `view_audit`: a read-only oversight surface, and the only place a
	   never-shipped draft is visible in aggregate. */
	{ key: 'projects', href: resolve('/admin/projects'), label: 'projects', needs: 'view_audit' },
	/* Counts only on the card; who invited whom is on the page behind it. */
	{
		key: 'referrals',
		href: resolve('/admin/referrals'),
		label: 'referrals',
		needs: 'view_audit'
	},
	/* First passes credited for ships sent to Airtable. */
	{
		key: 'reviewers',
		href: resolve('/admin/reviewers'),
		label: 'reviewers',
		needs: 'view_audit'
	},
	{ key: 'funnel', href: resolve('/admin/funnel'), label: 'funnel', needs: 'view_audit' },
	/* Plausible's dashboard: aggregate traffic and events, no one named. */
	{
		key: 'analytics',
		href: resolve('/admin/analytics'),
		label: 'analytics',
		needs: 'view_audit'
	},
	{ key: 'ledger', href: resolve('/admin/ledger'), label: 'ledger', needs: 'adjust_ledger' },
	{ key: 'reconcile', href: resolve('/admin/reconcile'), label: 'reconcile', needs: 'view_audit' },
	{ key: 'outbox', href: resolve('/admin/outbox'), label: 'outbox', needs: 'run_jobs' },
	{ key: 'ari', href: resolve('/admin/ari'), label: 'ari', needs: 'run_jobs' },
	{ key: 'jobs', href: resolve('/admin/jobs'), label: 'jobs', needs: 'run_jobs' },
	{ key: 'audit', href: resolve('/admin/audit'), label: 'audit', needs: 'view_audit' },
	{ key: 'settings', href: resolve('/admin/settings'), label: 'settings', needs: 'manage_settings' }
];

/** Counts per day for the last `days` days, oldest first, zeros filled in. */
async function perDay(table: 'users' | 'audit_events' | 'ledger_entries', days: number) {
	const rows = await db.execute<{ day: string; n: number }>(raw`
		select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, count(*)::int as n
		from ${raw.identifier(table)}
		where created_at >= now() - make_interval(days => ${days})
		group by 1
	`);
	const by = new Map(rows.map((row) => [row.day, Number(row.n)]));
	const out: number[] = [];
	for (let i = days - 1; i >= 0; i--) {
		const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
		out.push(by.get(d) ?? 0);
	}
	return out;
}

export const load: PageServerLoad = async () => {
	const user = requireAnyCapability(CONSOLE_CAPABILITIES);
	const sections = SECTIONS.filter((section) => can(user, section.needs));
	const has = (key: SectionKey) => sections.some((section) => section.key === key);

	const [
		orderByState,
		outbox,
		runs,
		settings,
		totals,
		signups,
		audits,
		ledgerDays,
		catalog,
		recentAudit,
		minted,
		reviewers,
		projectCounts,
		activity,
		referrals,
		funnel,
		ariAttention
	] = await Promise.all([
		orderCounts(),
		outboxCounts(),
		lastRunPerJob(),
		launchSettings(),
		db
			.select({
				people: raw<number>`(select count(*)::int from ${users})`,
				outstanding: raw<number>`coalesce((select sum(amount) from ${ledgerEntries}), 0)::bigint`
			})
			.from(raw`(select 1) as one`),
		has('users') ? perDay('users', 56) : Promise.resolve([]),
		has('audit') ? perDay('audit_events', 14) : Promise.resolve([]),
		has('ledger') ? perDay('ledger_entries', 14) : Promise.resolve([]),
		has('catalog')
			? db
					.select({
						name: products.name,
						active: products.active,
						stock: products.stock
					})
					.from(products)
					.orderBy(products.createdAt)
			: Promise.resolve([]),
		has('audit')
			? db
					/* The id comes too, because the list is keyed on it. Action and
					   timestamp together are not unique and never were: `recordAudits`
					   writes a batch in ONE statement, and `now()` is fixed for a whole
					   transaction, so two rows sharing an action come out with byte-
					   identical timestamps. A clean-up that deleted three projects at
					   once produced three `project.deleted` rows a millisecond apart on
					   paper and identical in fact, and Svelte refused the duplicate key
					   hard enough to take hydration down with it. */
					.select({
						id: auditEvents.id,
						action: auditEvents.action,
						createdAt: auditEvents.createdAt
					})
					.from(auditEvents)
					.orderBy(raw`${auditEvents.createdAt} desc`)
					.limit(3)
			: Promise.resolve([]),
		has('ledger')
			? db
					.select({
						awarded: raw<number>`coalesce(sum(amount) filter (where entry_type = 'submission_award'), 0)::bigint`,
						spent: raw<number>`coalesce(-sum(amount) filter (where entry_type = 'order_debit'), 0)::bigint`
					})
					.from(ledgerEntries)
			: Promise.resolve([{ awarded: 0, spent: 0 }]),
		has('reviewers') ? reviewerGlance() : Promise.resolve({ week: 0, credited: 0, top: [] }),
		has('projects')
			? projectStatusCounts()
			: Promise.resolve({ all: 0, draft: 0, review: 0, approved: 0, rejected: 0 }),
		has('activity')
			? activityGlance()
			: Promise.resolve({ today: 0, yesterday: 0, week: 0, month: 0, days: [] }),
		has('referrals')
			? referralGlance()
			: Promise.resolve({
					joined: 0,
					qualified: 0,
					joinedWeek: 0,
					inviters: 0,
					paidSeconds: 0,
					stickers: 0,
					days: []
				}),
		has('funnel') ? onboardingFunnel(null) : Promise.resolve([]),
		has('ari') ? ariAttentionCount() : Promise.resolve(0)
	]);

	/* Eight weekly buckets from the daily signups. */
	const weekly: number[] = [];
	for (let i = 0; i < signups.length; i += 7) {
		weekly.push(signups.slice(i, i + 7).reduce((a, b) => a + b, 0));
	}

	return {
		launched: settings.launched,
		shopOpen: settings.shopOpen,
		canRunJobs: can(user, 'run_jobs'),
		stuck: (outbox['failed'] ?? 0) + (outbox['ambiguous'] ?? 0),
		sections: sections.map(({ key, href, label }) => ({ key, href, label })),
		people: totals[0]?.people ?? 0,
		weekly,
		catalog: {
			active: catalog.filter((p) => p.active).length,
			total: catalog.length,
			soldOut: catalog.filter((p) => p.stock === 0).length,
			names: catalog
				.filter((p) => p.active)
				.slice(0, 4)
				.map((p) => p.name)
		},
		orders: {
			placed: orderByState['placed'] ?? 0,
			on_hold: orderByState['on_hold'] ?? 0,
			fulfilled: orderByState['fulfilled'] ?? 0,
			rejected: orderByState['rejected'] ?? 0,
			cancelled: orderByState['cancelled'] ?? 0,
			unfulfilled: orderByState['unfulfilled'] ?? 0
		},
		ledger: {
			outstanding: Number(totals[0]?.outstanding ?? 0),
			awarded: Number(minted[0]?.awarded ?? 0),
			spent: Number(minted[0]?.spent ?? 0),
			days: ledgerDays
		},
		outbox: {
			pending: outbox['pending'] ?? 0,
			delivered: outbox['delivered'] ?? 0,
			retryable: outbox['retryable'] ?? 0,
			failed: outbox['failed'] ?? 0,
			ambiguous: outbox['ambiguous'] ?? 0
		},
		quiet: quietCount(runs),
		runs: [...runs.values()].map((run) => ({
			id: run.id,
			name: run.name,
			status: run.status,
			startedAt: run.startedAt
		})),
		audit: { days: audits, recent: recentAudit },
		reviewers,
		projects: projectCounts,
		activity,
		referrals,
		funnel,
		ariAttention
	};
};
