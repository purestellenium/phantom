import { and, eq, gte, inArray, isNotNull, ne, sql as raw } from 'drizzle-orm';

import {
	fetchHackatimeDay,
	HACKATIME_COUNTS_FROM,
	type HackatimeDay
} from '$lib/server/auth/hackatime';
import { db } from '$lib/server/db/client';
import { hackatimeActivity, projects, providerAccounts, users } from '$lib/server/db/schema';
import { parseProjectNames } from '$lib/server/projects/projects';
import { staging } from '$lib/server/staging';
import type { JobResult } from '$lib/server/jobs';

/**
 * Daily active users: people who logged a Hackatime heartbeat, on a given UTC
 * day, in a Hackatime project linked to any of their Phantom projects.
 *
 * Hackatime has no endpoint that answers this for everyone at once, so it is
 * asked one user and one day at a time, and each answer is kept in
 * `hackatime_activity`. The job below does the asking on a schedule, and the
 * console reads the table; nobody waits on Hackatime to see a chart.
 *
 * The same job is the backfill. Every day from HACKATIME_COUNTS_FROM to today
 * that has no settled row is work, taken newest first so the right-hand end of
 * the chart fills in before the history does, and bounded by a time budget so a
 * first run over weeks of history is spread across as many runs as it takes.
 */

const DAY_MS = 86_400_000;

/** The first day counted, the same instant Hackatime time starts counting. */
const FIRST_DAY = HACKATIME_COUNTS_FROM.slice(0, 10);

/**
 * How long after a day ends it is asked about one final time.
 *
 * Heartbeats are not always live: an editor that was offline sends its queue
 * when it reconnects, stamped with when the work happened. A day asked about at
 * 23:59 can gain activity afterwards, so it stays open until it has been asked
 * about this long after midnight.
 */
const SETTLE_AFTER_MS = 6 * 60 * 60 * 1000;

/** Stop starting new requests after this long, so a run stays well inside a
 *  function's time limit however much backfill is left. */
const BUDGET_MS = 40_000;

/** Requests in flight at once. Enough to get through a backfill in a few runs,
 *  few enough not to look like a flood to one provider. */
const CONCURRENCY = 6;

function dayOf(time: number): string {
	return new Date(time).toISOString().slice(0, 10);
}

/** Every UTC day from FIRST_DAY through today, newest first. */
function countedDays(now: number): string[] {
	const out: string[] = [];
	const first = Date.parse(`${FIRST_DAY}T00:00:00Z`);
	for (let t = Date.parse(`${dayOf(now)}T00:00:00Z`); t >= first; t -= DAY_MS) {
		out.push(dayOf(t));
	}
	return out;
}

/** Whether a row can stop being asked about. */
function settled(day: string, checkedAt: Date): boolean {
	return checkedAt.getTime() >= Date.parse(`${day}T00:00:00Z`) + DAY_MS + SETTLE_AFTER_MS;
}

/**
 * Each user with at least one Phantom project linked to Hackatime, and the
 * union of the Hackatime names across all their projects, drafts included.
 *
 * Outside staging, only users with a Hackatime account: a user whose account is
 * gone would be a request per day that comes back null.
 */
async function linkedUsers(): Promise<Map<string, string[]>> {
	const rows = await db
		.select({ userId: projects.userId, hackatimeProjects: projects.hackatimeProjects })
		.from(projects)
		.where(and(isNotNull(projects.hackatimeProjects), ne(projects.hackatimeProjects, '')));

	const names = new Map<string, Set<string>>();
	for (const row of rows) {
		const set = names.get(row.userId) ?? new Set<string>();
		for (const name of parseProjectNames(row.hackatimeProjects)) set.add(name);
		if (set.size > 0) names.set(row.userId, set);
	}

	if (!staging && names.size > 0) {
		const linked = await db
			.select({ userId: providerAccounts.userId })
			.from(providerAccounts)
			.where(
				and(
					eq(providerAccounts.provider, 'hackatime'),
					inArray(providerAccounts.userId, [...names.keys()])
				)
			);
		const keep = new Set(linked.map((row) => row.userId));
		for (const userId of names.keys()) if (!keep.has(userId)) names.delete(userId);
	}

	return new Map([...names].map(([userId, set]) => [userId, [...set]]));
}

type Work = { userId: string; day: string };

/**
 * Ask Hackatime about every unsettled (user, day) it has time for.
 *
 * A user whose token is refused is dropped for the rest of the run rather than
 * asked about every remaining day, and counted, since that user is invisible
 * to DAU until they relink. A request that fails outright is counted and left
 * unwritten, so the next run tries it again.
 */
export async function recordActivity(): Promise<JobResult> {
	const started = Date.now();
	const users = await linkedUsers();
	const days = countedDays(started);

	const existing =
		users.size === 0
			? []
			: await db
					.select({
						userId: hackatimeActivity.userId,
						day: hackatimeActivity.day,
						checkedAt: hackatimeActivity.checkedAt
					})
					.from(hackatimeActivity)
					.where(
						and(
							gte(hackatimeActivity.day, FIRST_DAY),
							inArray(hackatimeActivity.userId, [...users.keys()])
						)
					);

	const done = new Set(
		existing
			.filter((row) => settled(row.day, row.checkedAt))
			.map((row) => `${row.userId}:${row.day}`)
	);

	/* Day-major, newest first: today for everybody, then yesterday for
	   everybody, and so on back. */
	const queue: Work[] = [];
	for (const day of days) {
		for (const userId of users.keys()) {
			if (!done.has(`${userId}:${day}`)) queue.push({ userId, day });
		}
	}

	const refused = new Set<string>();
	let checked = 0;
	let active = 0;
	let failed = 0;
	let next = 0;

	async function worker() {
		while (next < queue.length && Date.now() - started < BUDGET_MS) {
			const work = queue[next++];
			if (refused.has(work.userId)) continue;

			let answer: HackatimeDay | null;
			try {
				answer = await fetchHackatimeDay(work.userId, users.get(work.userId) ?? [], work.day);
			} catch {
				failed += 1;
				continue;
			}
			if (answer === null) {
				refused.add(work.userId);
				continue;
			}

			const checkedAt = new Date();
			await db
				.insert(hackatimeActivity)
				.values({ ...work, ...answer, checkedAt })
				.onConflictDoUpdate({
					target: [hackatimeActivity.userId, hackatimeActivity.day],
					set: { active: answer.active, seconds: answer.seconds, checkedAt }
				});
			checked += 1;
			if (answer.active) active += 1;
		}
	}

	await Promise.all(Array.from({ length: CONCURRENCY }, worker));

	return {
		counts: {
			users: users.size,
			checked,
			active,
			failed,
			refused: refused.size,
			/* What is still owed, backfill included. Falls to roughly one row per
			   user per open day once the history is in. */
			remaining: queue.slice(next).filter((work) => !refused.has(work.userId)).length
		},
		needsAttention: failed > 0
	};
}

/* ── reading it ──────────────────────────────────────────────────────────── */

export type ActivityGlance = {
	/** Active so far today. The day is not over, so this only rises. */
	today: number;
	yesterday: number;
	/** Distinct users active in the last 7 and 30 days, today included. */
	week: number;
	month: number;
	/** Daily actives, oldest first, zeros filled in. */
	days: number[];
};

export async function activityGlance(days = 30): Promise<ActivityGlance> {
	const now = Date.now();
	const from = dayOf(now - (days - 1) * DAY_MS);
	const weekFrom = dayOf(now - 6 * DAY_MS);

	const [series, totals] = await Promise.all([
		db.execute<{ day: string; n: number }>(raw`
			select day::text as day, count(*)::int as n
			from ${hackatimeActivity}
			where active and day >= ${from}
			group by 1
		`),
		db.execute<{ week: number; month: number }>(raw`
			select
				count(distinct user_id) filter (where day >= ${weekFrom})::int as week,
				count(distinct user_id)::int as month
			from ${hackatimeActivity}
			where active and day >= ${from}
		`)
	]);

	const by = new Map(series.map((row) => [row.day, Number(row.n)]));
	const filled: number[] = [];
	for (let i = days - 1; i >= 0; i--) filled.push(by.get(dayOf(now - i * DAY_MS)) ?? 0);

	return {
		today: filled[filled.length - 1] ?? 0,
		yesterday: filled[filled.length - 2] ?? 0,
		week: Number(totals[0]?.week ?? 0),
		month: Number(totals[0]?.month ?? 0),
		days: filled
	};
}

/* ── the page ────────────────────────────────────────────────────────────── */

export type ActivityDay = {
	day: string;
	/** People active that day. */
	active: number;
	/** Of those, the ones whose first active day this was. */
	fresh: number;
	/** Hackatime time across everyone active, in seconds. */
	seconds: number;
	/** People the job has asked about for that day, active or not. Short of
	 *  everyone linked while a backfill is still working through the history. */
	checked: number;
};

export type ActivityRange = {
	/** Every day from `from` through today, oldest first, zeros filled in. */
	days: ActivityDay[];
	/** Distinct people active on any day in the range. */
	distinct: number;
};

/** The first day there is anything to count, for a range that asks for all. */
export const ACTIVITY_FIRST_DAY = FIRST_DAY;

/**
 * Day by day from `from` to today. "Fresh" is read against a person's whole
 * history, not the range, so it means the same thing whatever range is open.
 */
export async function activityRange(from: string): Promise<ActivityRange> {
	const now = Date.now();
	const start = from < FIRST_DAY ? FIRST_DAY : from;

	const [series, firsts, totals] = await Promise.all([
		db.execute<{ day: string; checked: number; active: number; seconds: number }>(raw`
			select
				day::text as day,
				count(*)::int as checked,
				count(*) filter (where active)::int as active,
				coalesce(sum(seconds) filter (where active), 0)::bigint as seconds
			from ${hackatimeActivity}
			where day >= ${start}
			group by 1
		`),
		db.execute<{ day: string; n: number }>(raw`
			select first_day::text as day, count(*)::int as n
			from (
				select min(day) as first_day
				from ${hackatimeActivity}
				where active
				group by user_id
			) as firsts
			where first_day >= ${start}
			group by 1
		`),
		db.execute<{ n: number }>(raw`
			select count(distinct user_id)::int as n
			from ${hackatimeActivity}
			where active and day >= ${start}
		`)
	]);

	const by = new Map(series.map((row) => [row.day, row]));
	const fresh = new Map(firsts.map((row) => [row.day, Number(row.n)]));
	const days: ActivityDay[] = [];
	const first = Date.parse(`${start}T00:00:00Z`);
	for (let t = first; t <= now; t += DAY_MS) {
		const day = dayOf(t);
		const row = by.get(day);
		days.push({
			day,
			active: Number(row?.active ?? 0),
			fresh: fresh.get(day) ?? 0,
			seconds: Number(row?.seconds ?? 0),
			checked: Number(row?.checked ?? 0)
		});
	}

	return { days, distinct: Number(totals[0]?.n ?? 0) };
}

export type ActivePerson = {
	id: string;
	name: string;
	avatarUrl: string | null;
	seconds: number;
	/** Whether this was their first active day. */
	fresh: boolean;
};

/** Who was active on one day, most time first. */
export async function activeOn(day: string): Promise<ActivePerson[]> {
	const rows = await db.execute<{
		id: string;
		name: string;
		avatar_url: string | null;
		seconds: number;
		fresh: boolean;
	}>(raw`
		select
			u.id,
			coalesce(u.display_name, u.email) as name,
			u.avatar_url,
			a.seconds,
			not exists (
				select 1 from ${hackatimeActivity} as earlier
				where earlier.user_id = a.user_id and earlier.active and earlier.day < a.day
			) as fresh
		from ${hackatimeActivity} as a
		join ${users} as u on u.id = a.user_id
		where a.active and a.day = ${day}
		order by a.seconds desc, name
	`);

	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		avatarUrl: row.avatar_url,
		seconds: Number(row.seconds),
		fresh: Boolean(row.fresh)
	}));
}
