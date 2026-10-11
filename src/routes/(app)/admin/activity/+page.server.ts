import type { PageServerLoad } from './$types';

import { can, requireCapability } from '$lib/server/auth/authorize';
import { ACTIVITY_FIRST_DAY, activeOn, activityGlance, activityRange } from '$lib/server/activity';

/**
 * Daily active users, read closely: the whole series at a chosen range, and
 * one day of it opened up.
 *
 * `view_audit`, like the card on the console's front page, because the chart
 * and the day's figures are aggregate counts. Who was active on the day is
 * people rather than counts, so that list is only drawn for a reader who could
 * open those people anyway.
 */

const RANGES = { '30': 30, '90': 90, all: null } as const;
type Range = keyof typeof RANGES;

const DAY_MS = 86_400_000;

function isRange(value: string | null): value is Range {
	return value !== null && value in RANGES;
}

export const load: PageServerLoad = async ({ url }) => {
	const user = requireCapability('view_audit');

	const requested = url.searchParams.get('range');
	const range: Range = isRange(requested) ? requested : '90';
	const span = RANGES[range];
	const from =
		span === null
			? ACTIVITY_FIRST_DAY
			: new Date(Date.now() - (span - 1) * DAY_MS).toISOString().slice(0, 10);

	const [glance, series] = await Promise.all([activityGlance(), activityRange(from)]);

	/* A day off the chart, or no day at all, opens the latest one. */
	const asked = url.searchParams.get('day');
	const day = series.days.some((d) => d.day === asked)
		? (asked as string)
		: (series.days.at(-1)?.day ?? null);

	const canSeePeople = can(user, 'manage_users');
	const people = day !== null && canSeePeople ? await activeOn(day) : null;

	return { range, day, glance, series, people };
};
