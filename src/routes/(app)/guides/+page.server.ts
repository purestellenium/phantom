import type { PageServerLoad } from './$types';

import { requireUser } from '$lib/server/auth/session';
import { listGuides } from '$lib/server/guides';

/** Every guide, in order. Only a session is needed: a guide is as useful
 *  before onboarding as after it. */
export const load: PageServerLoad = () => {
	requireUser();
	return { guides: listGuides() };
};
