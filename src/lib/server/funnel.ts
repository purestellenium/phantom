import { sql as raw } from 'drizzle-orm';

import { db } from '$lib/server/db/client';

/**
 * Where people get to, counted off the tables that already record it.
 *
 * Not an event stream. Each step here is a fact a row already states - an
 * account exists, a Hackatime link exists, `onboarded_at` is set, a project
 * exists, a submission exists, an approved one does, an order does - so the
 * funnel is derivable for every person who has ever signed up, including the
 * ones who did so before anybody thought to count. What it cannot see is
 * anything that happened without leaving a row: a sign-in that was abandoned
 * at the consent screen is not here, because nothing wrote it down.
 *
 * Steps are people, not things. Somebody with four projects is one person who
 * created a project, and the question the funnel answers is how many people
 * got that far.
 */

export type FunnelStep = { key: string; label: string; n: number };

/**
 * The source that means "signed up through another participant's invite code"
 * rather than through a partner. Not a partner key, so it is not on the
 * allowlist in lib/referral.ts: it is read off `referred_by_user_id`, which
 * the HCA callback writes only when the code named a real person.
 */
export const INVITED_SOURCE = 'invited';

/** `days` bounds the cohort by signup date; null is everyone. `source`
 *  narrows it to the people a partner sent (lib/referral.ts), or with
 *  INVITED_SOURCE to the people a participant invited; null is everyone,
 *  whoever sent them. */
export async function onboardingFunnel(
	days: number | null,
	source: string | null = null
): Promise<FunnelStep[]> {
	const invited = source === INVITED_SOURCE;
	const partner = invited ? null : source;
	const [row] = await db.execute<Record<string, number | string>>(raw`
		with cohort as (
			select id
			from users
			where (${days}::int is null or created_at >= now() - make_interval(days => ${days}::int))
				and (${partner}::text is null or referral_source = ${partner}::text)
				and (not ${invited}::boolean or referred_by_user_id is not null)
		)
		select
			(select count(*) from cohort)::int as signed_up,
			(
				select count(distinct c.id) from cohort c
				join provider_accounts pa on pa.user_id = c.id and pa.provider = 'hackatime'
			)::int as linked,
			(
				select count(*) from cohort c
				join users u on u.id = c.id and u.onboarded_at is not null
			)::int as onboarded,
			(select count(distinct p.user_id) from cohort c join projects p on p.user_id = c.id)::int as created,
			(select count(distinct s.user_id) from cohort c join submissions s on s.user_id = c.id)::int as shipped,
			(
				select count(distinct s.user_id) from cohort c
				join submissions s on s.user_id = c.id and s.state = 'approved'
			)::int as approved,
			(select count(distinct o.user_id) from cohort c join orders o on o.user_id = c.id)::int as ordered
	`);
	const n = (key: string) => Number(row?.[key] ?? 0);
	return [
		{ key: 'signed_up', label: 'signed up', n: n('signed_up') },
		{ key: 'linked', label: 'linked hackatime', n: n('linked') },
		{ key: 'onboarded', label: 'finished setup', n: n('onboarded') },
		{ key: 'created', label: 'made a project', n: n('created') },
		{ key: 'shipped', label: 'shipped one', n: n('shipped') },
		{ key: 'approved', label: 'had one approved', n: n('approved') },
		{ key: 'ordered', label: 'bought something', n: n('ordered') }
	];
}

/**
 * Of the people who linked Hackatime, how much they have logged.
 *
 * Time is the sum of `hackatime_activity` - Hackatime's daily totals for the
 * projects linked to their Phantom projects, from HACKATIME_COUNTS_FROM on - so
 * it is only as complete as the `hackatime.activity` backfill, and time in a
 * Hackatime project nobody linked is not in it. Someone linked with no rows yet
 * counts as nothing logged.
 *
 * `linked` is the base. `under_1h` is the ones who have not reached an hour;
 * the rest are thresholds, each a subset of the one before.
 */
export async function hoursFunnel(
	days: number | null,
	source: string | null = null
): Promise<{ linked: number; steps: FunnelStep[] }> {
	const invited = source === INVITED_SOURCE;
	const partner = invited ? null : source;
	const [row] = await db.execute<Record<string, number | string>>(raw`
		with cohort as (
			select id
			from users
			where (${days}::int is null or created_at >= now() - make_interval(days => ${days}::int))
				and (${partner}::text is null or referral_source = ${partner}::text)
				and (not ${invited}::boolean or referred_by_user_id is not null)
		),
		linked as (
			select c.id, coalesce((
				select sum(a.seconds) from hackatime_activity a where a.user_id = c.id
			), 0) as seconds
			from cohort c
			where exists (
				select 1 from provider_accounts pa
				where pa.user_id = c.id and pa.provider = 'hackatime'
			)
		)
		select
			count(*)::int as linked,
			count(*) filter (where seconds < 3600)::int as under_1h,
			count(*) filter (where seconds >= 3600)::int as at_least_1h,
			count(*) filter (where seconds >= 5 * 3600)::int as at_least_5h,
			count(*) filter (where seconds >= 10 * 3600)::int as at_least_10h,
			count(*) filter (where seconds > 20 * 3600)::int as over_20h
		from linked
	`);
	const n = (key: string) => Number(row?.[key] ?? 0);
	return {
		linked: n('linked'),
		steps: [
			{ key: 'under_1h', label: 'under 1 hour', n: n('under_1h') },
			{ key: 'at_least_1h', label: '1+ hours', n: n('at_least_1h') },
			{ key: 'at_least_5h', label: '5+ hours', n: n('at_least_5h') },
			{ key: 'at_least_10h', label: '10+ hours', n: n('at_least_10h') },
			{ key: 'over_20h', label: 'over 20 hours', n: n('over_20h') }
		]
	};
}

/** The windows the page offers. */
export const FUNNEL_WINDOWS = { all: null, month: 30, week: 7 } as const;
export type FunnelWindow = keyof typeof FUNNEL_WINDOWS;

export function funnelWindowFrom(value: string | null): FunnelWindow {
	return value === 'month' || value === 'week' ? value : 'all';
}
