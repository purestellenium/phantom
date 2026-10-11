import type { PageServerLoad } from './$types';

import { requireCapability } from '$lib/server/auth/authorize';
import {
	FUNNEL_WINDOWS,
	INVITED_SOURCE,
	funnelWindowFrom,
	hoursFunnel,
	onboardingFunnel
} from '$lib/server/funnel';
import { REFERRAL_SOURCES, isReferralSource } from '$lib/referral';

/**
 * How far people get. Aggregate counts only, so the same oversight capability
 * as the projects list and the reviewer board.
 */
export const load: PageServerLoad = async ({ url }) => {
	requireCapability('view_audit');
	const window = funnelWindowFrom(url.searchParams.get('window'));
	/* Only a source on the allowlist, or a participant's invite; anything else
	   is everyone. */
	const requested = url.searchParams.get('source');
	const source = isReferralSource(requested) || requested === INVITED_SOURCE ? requested : null;
	const [steps, hours] = await Promise.all([
		onboardingFunnel(FUNNEL_WINDOWS[window], source),
		hoursFunnel(FUNNEL_WINDOWS[window], source)
	]);
	const top = steps[0]?.n ?? 0;

	return {
		window,
		source,
		sources: [
			...Object.entries(REFERRAL_SOURCES).map(([key, label]) => ({ key, label })),
			{ key: INVITED_SOURCE, label: 'a referral code' }
		],
		steps: steps.map((step, i) => {
			const previous = i === 0 ? null : (steps[i - 1]?.n ?? 0);
			return {
				...step,
				/* Of everyone at the top, and of the step before. Null where there
				   is nothing to divide by, which the page prints as a dash rather
				   than as a hundred percent of nobody. */
				ofTop: top > 0 ? step.n / top : null,
				ofPrevious: previous === null ? null : previous > 0 ? step.n / previous : null
			};
		}),
		/* Hours, of the people who linked Hackatime. "Under an hour" is the
		   remainder rather than a step, so it has no step before; each threshold
		   after it is measured against the threshold before, the first against
		   everyone linked. */
		hours: {
			linked: hours.linked,
			steps: hours.steps.map((step, i) => {
				const previous = i === 0 ? null : i === 1 ? hours.linked : (hours.steps[i - 1]?.n ?? 0);
				return {
					...step,
					ofTop: hours.linked > 0 ? step.n / hours.linked : null,
					ofPrevious: previous === null ? null : previous > 0 ? step.n / previous : null
				};
			})
		}
	};
};
