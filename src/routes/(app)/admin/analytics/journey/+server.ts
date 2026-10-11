import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { requireCapability } from '$lib/server/auth/authorize';
import { type DateRange, type JourneyStep, journey } from '$lib/server/plausible-stats';

/**
 * One column of the analytics page's journeys panel, asked for as somebody
 * clicks through it. The same capability as the page; the steps are checked
 * for shape, since they are only ever echoed on to Plausible.
 */

const RANGES: DateRange[] = ['7d', '30d', 'all'];
const MAX_STEPS = 6;

function isStep(value: unknown): value is JourneyStep {
	const step = value as JourneyStep;
	return (
		typeof step === 'object' &&
		step !== null &&
		typeof step.name === 'string' &&
		typeof step.pathname === 'string' &&
		typeof step.includes_subpaths === 'boolean' &&
		typeof step.subpaths_count === 'number' &&
		typeof step.is_goal === 'boolean'
	);
}

export const POST: RequestHandler = async ({ request }) => {
	requireCapability('view_audit');
	const body = (await request.json().catch(() => null)) as {
		range?: unknown;
		steps?: unknown;
		direction?: unknown;
		search?: unknown;
	} | null;

	const range = RANGES.find((r) => r === body?.range);
	const steps = body?.steps;
	const direction = body?.direction === 'backward' ? 'backward' : 'forward';
	const search = typeof body?.search === 'string' ? body.search.slice(0, 100) : '';
	if (!range || !Array.isArray(steps) || steps.length > MAX_STEPS || !steps.every(isStep)) {
		error(400, 'bad journey');
	}

	const answer = await journey(range, steps, direction, search);
	if (!answer) error(502, 'plausible did not answer');
	return json(answer);
};
