import { desc, eq, inArray } from 'drizzle-orm';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { requireCapability } from '$lib/server/auth/authorize';
import { db } from '$lib/server/db/client';
import { orderState, orders, users } from '$lib/server/db/schema';
import {
	TRANSITION_LABELS,
	TRANSITION_NAMES,
	orderCounts,
	transitionOrder
} from '$lib/server/shop/orders';
import { isUuid } from '$lib/uuid';

/**
 * The work queue.
 *
 * It carries the buyer's name and NEVER the address: a bulk read that reveals
 * many addresses is a PII export, and one that produces no per-order audit row
 * is an export nothing recorded. Getting an address is a separate, individually
 * audited act on the order's own page.
 *
 * Open orders first, because those are the ones with somebody waiting behind
 * them.
 */
const OPEN = ['placed', 'on_hold'] as const;

export const load: PageServerLoad = async ({ url }) => {
	requireCapability('manage_orders');
	const state = url.searchParams.get('state');

	/* An unrecognised state falls back to the open queue rather than erroring.
	   This value is in a URL people bookmark and share, and a 500 because a
	   state was renamed is a worse outcome than showing the default. */
	const requested = orderState.enumValues.find((known) => known === state);
	const filter = requested === undefined ? [...OPEN] : [requested];

	const [rows, counts] = await Promise.all([
		db
			.select({ order: orders, displayName: users.displayName, email: users.email })
			.from(orders)
			.innerJoin(users, eq(users.id, orders.userId))
			.where(inArray(orders.state, filter))
			.orderBy(desc(orders.stateAt))
			.limit(200),
		orderCounts()
	]);

	return {
		heading: requested ? requested.replace(/_/g, ' ') : 'open',
		openCount: (counts['placed'] ?? 0) + (counts['on_hold'] ?? 0),
		states: orderState.enumValues.map((value) => ({
			value,
			label: value.replace(/_/g, ' '),
			count: counts[value] ?? 0
		})),
		/* The moves the bulk form may offer. Which of them each order accepts
		   is the transition's own business, decided one order at a time below. */
		moves: TRANSITION_NAMES.map((name) => ({ name, label: TRANSITION_LABELS[name] })),
		rows
	};
};

/**
 * One move, many orders.
 *
 * A loop over `transitionOrder`, deliberately, rather than one statement
 * over the set: each order takes its own lock, checks its own state, refunds
 * its own debit and writes its own transition and audit rows, and a batch
 * that bypassed any of that to go faster would be a batch that could refund
 * twice. What this adds is the loop and the tally. An order that refuses -
 * already fulfilled, moved by somebody else since the page loaded - is
 * reported by name and the rest go through; a refusal is a fact about one
 * order, not a reason to leave the other nineteen where they were.
 */
const BULK_LIMIT = 100;

export const actions: Actions = {
	bulk: async ({ request }) => {
		const actor = requireCapability('manage_orders');
		const form = await request.formData();

		const submitted = String(form.get('transition') ?? '');
		const transition = TRANSITION_NAMES.find((name) => name === submitted);
		if (transition === undefined) return fail(400, { error: `${submitted} is not a transition.` });

		const ids = [...new Set(form.getAll('id').map(String))].filter(isUuid);
		if (ids.length === 0) return fail(400, { error: 'Pick at least one order.' });
		if (ids.length > BULK_LIMIT) {
			return fail(400, { error: `Pick at most ${BULK_LIMIT} orders at a time.` });
		}

		const reason = String(form.get('reason') ?? '').trim() || null;
		const restock = form.get('restock') === 'on';

		const failed: { id: string; error: string }[] = [];
		let done = 0;
		for (const orderId of ids) {
			const outcome = await transitionOrder({ orderId, transition, actor, reason, restock });
			if (outcome.ok) done += 1;
			else failed.push({ id: orderId, error: outcome.error });
		}
		return { bulk: { transition: TRANSITION_LABELS[transition], done, failed } };
	}
};
