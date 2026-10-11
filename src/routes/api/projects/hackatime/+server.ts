import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import {
	getLinkedHackatime,
	listHackatimeProjects,
	type HackatimeChoices
} from '$lib/server/auth/hackatime';
import { requireUser } from '$lib/server/auth/session';
import { hackatimeNamesInUse } from '$lib/server/projects/projects';

/**
 * The Hackatime picker for a project that does not exist yet - the new-project
 * flow's links screen.
 *
 * `requireUser`, not `requireOnboarded`: the same screens make the first
 * project at the end of onboarding, before the account is marked onboarded.
 * It reads nothing but the caller's own Hackatime and their own projects.
 *
 * An endpoint rather than part of the projects page's load because it is a
 * call out to Hackatime, and most visits to that page never open the flow; the
 * flow asks for it when it opens instead.
 *
 * `disabled` marks a name already claimed by one of this user's projects, the
 * same greying the project page's picker does. There is no project to exclude
 * from that yet, so it is asked about an id nothing has - the same move
 * createProject makes before its insert - which leaves every existing project
 * counted. The picker is a drawing of the rule; createProject is the rule.
 *
 * Not linked and "linked, but the list failed" stay apart, as on the project
 * page: the first can be fixed by linking, the second only by waiting. A token
 * Hackatime refuses reads as unlinked, since relinking is the fix.
 */
export const GET: RequestHandler = async () => {
	const user = requireUser();

	if (!(await getLinkedHackatime(user.id))) return json({ state: 'unlinked' } as HackatimeChoices);

	try {
		const list = await listHackatimeProjects(user.id);
		if (!list) return json({ state: 'unlinked' } as HackatimeChoices);
		const inUse = await hackatimeNamesInUse(user.id, crypto.randomUUID());
		const projects = list
			.map((entry) => ({ ...entry, disabled: inUse.has(entry.name) }))
			.sort((a, b) => b.totalSeconds - a.totalSeconds);
		return json({ state: 'ok', projects } as HackatimeChoices);
	} catch {
		return json({ state: 'error' } as HackatimeChoices);
	}
};
