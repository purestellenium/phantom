import { fetchHackatimeSecondsSince } from '$lib/server/auth/hackatime';

/**
 * "Time since your last ship": what an update ship has added.
 *
 * Not measured against a running total. Each of the ship's linked Hackatime
 * projects is counted only from the moment of the previous ship - every
 * project, a newly linked one included, so a project added on an update brings
 * none of its earlier time with it. Counting from the moment rather than the
 * start of that day keeps time already inside the last ship from counting
 * again. What gets PAID is still Ari's figure, as decided; see
 * projects/decisions.ts.
 *
 * `lastShipAt` is when that ship was SHIPPED, not when it was approved: the
 * hours it claimed were read from Hackatime then, so anything after is new.
 */

/**
 * Seconds across the named projects since `lastShipAt`. Null when Hackatime
 * cannot be asked; a transport failure throws.
 */
export async function newTimeSince(
	userId: string,
	projectNames: string[],
	lastShipAt: Date
): Promise<number | null> {
	const perProject = await fetchHackatimeSecondsSince(userId, projectNames, lastShipAt);
	if (perProject === null) return null;
	let total = 0;
	for (const seconds of perProject.values()) total += seconds;
	return total;
}

/**
 * The same window for every project on the account, by name - for the ship
 * panel, which adds up whichever ones are ticked. Null when Hackatime cannot
 * be asked; a transport failure throws.
 */
export async function newTimeByProject(
	userId: string,
	lastShipAt: Date
): Promise<Record<string, number> | null> {
	const perProject = await fetchHackatimeSecondsSince(userId, null, lastShipAt);
	return perProject === null ? null : Object.fromEntries(perProject);
}
