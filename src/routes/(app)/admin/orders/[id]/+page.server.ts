import { eq } from 'drizzle-orm';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { orderHistory } from '$lib/server/log';
import { peopleById } from '$lib/server/people';

import { can, requireCapability } from '$lib/server/auth/authorize';
import { db } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';
import { entriesForOrder } from '$lib/server/ledger';
import { revisionFor } from '$lib/server/shop/catalog';
import {
	TRANSITION_LABELS,
	TRANSITION_NAMES,
	availableTransitions,
	orderById,
	transitionOrder,
	transitionsFor
} from '$lib/server/shop/orders';
import { revealShipping, shippingLines } from '$lib/server/shop/shipping';
import { describeOptions, parseOptionSchema } from '$lib/shop/options';

/**
 * One order, for an operator.
 *
 * THE TRANSITIONS ARE COMPUTED, not listed. `availableTransitions` derives them
 * from the order's current state and the reader's capabilities, so a terminal
 * order has no buttons and a stale tab's button is refused by the action. There
 * is no un-reject and there will not be: reopening in place does not recheck
 * affordability. The replacement path is a new order that goes through every
 * check again.
 *
 * THE ADDRESS IS NOT RENDERED unless asked for. It is behind a POST, requires
 * `view_pii`, and every reveal writes an audit row naming the operator, the
 * order and the time. Rendering it on load would make that audit trail a record
 * of who opened a page rather than of who read an address.
 *
 * THE LEDGER IS SHOWN NEXT TO THE STATE. They are two halves of one event, and
 * the question an operator is answering - "was this actually refunded" - is
 * unanswerable from the state alone.
 */
export const load: PageServerLoad = async ({ params, url }) => {
	const actor = requireCapability('manage_orders');

	const order = await orderById(params.id);
	if (!order) error(404);

	const [buyer] = await db
		.select({ id: users.id, email: users.email, displayName: users.displayName })
		.from(users)
		.where(eq(users.id, order.userId))
		.limit(1);

	const [transitions, entries, revision] = await Promise.all([
		transitionsFor(order.id),
		entriesForOrder(order.id),
		revisionFor(order.productId, order.productVersion)
	]);

	const schema = parseOptionSchema(revision?.optionSchema ?? null);
	const options = describeOptions(schema.ok ? schema.options : [], order.options);

	/* The reveal runs here, not in the action, because this is where the
	   plaintext is needed - and it re-checks `view_pii` and writes its own audit
	   row, so a shared URL reveals nothing to somebody without the capability. */
	const revealed =
		url.searchParams.get('reveal') === '1' && order.shippingEncrypted
			? await revealShipping(order, actor)
			: null;

	const people = await peopleById([
		...transitions.map((t) => t.actorId),
		...entries.map((e) => e.actorId)
	]);
	const log = orderHistory(transitions, entries, people);

	return {
		log,
		order: {
			id: order.id,
			productName: order.productName,
			productKind: order.productKind,
			productVersion: order.productVersion,
			quantity: order.quantity,
			unitPrice: order.unitPrice,
			totalPrice: order.totalPrice,
			state: order.state,
			createdAt: order.createdAt,
			stateAt: order.stateAt,
			replacesOrderId: order.replacesOrderId
		},
		buyer: buyer ?? null,
		options,
		moves: availableTransitions(order, actor).map((move) => ({
			name: move,
			label: TRANSITION_LABELS[move],
			/* Unfulfilling is a correction, not the next step, so it does not
			   look like the primary action on a fulfilled order. */
			quiet: move === 'reject' || move === 'cancel' || move === 'unfulfil'
		})),
		canViewPii: can(actor, 'view_pii'),
		revealed: revealed
			? revealed.ok
				? {
						ok: true as const,
						lines: shippingLines(revealed.snapshot),
						capturedAt: revealed.snapshot.capturedAt.slice(0, 10) || 'unknown'
					}
				: { ok: false as const, error: revealed.error }
			: null
	};
};

/**
 * Moving an order from the console.
 *
 * A thin wrapper, and it should be. The rules - which states a transition may
 * leave, who may run it, whether it refunds - are in $lib/server/shop/orders.ts,
 * because that module is also reached from the participant's cancel button and
 * a rule written here would be a rule that path does not get.
 *
 * What this adds is `manage_orders` and the restock decision, which is a
 * checkbox with no default: the right answer genuinely varies. An order
 * rejected because the thing was already picked and packed should not restock;
 * one rejected the same afternoon should.
 */
export const actions: Actions = {
	move: async ({ params, request }) => {
		const actor = requireCapability('manage_orders');
		const form = await request.formData();

		const submitted = String(form.get('transition') ?? '');
		const reason = String(form.get('reason') ?? '').trim() || null;
		const restock = form.get('restock') === 'on';

		/* The closed set is the allowlist. A transition name from a form must never
		   index the table without this - an unknown key would be `undefined` and
		   the next line would read `.from` off it. Found rather than tested, so what
		   continues is a transition name and not a string somebody checked earlier. */
		const transition = TRANSITION_NAMES.find((name) => name === submitted);
		if (transition === undefined) {
			return fail(400, { error: `${submitted} is not a transition.` });
		}

		const outcome = await transitionOrder({
			orderId: params.id,
			transition,
			actor,
			reason,
			restock
		});

		if (!outcome.ok) return fail(400, { error: outcome.error });

		redirect(303, `/admin/orders/${params.id}`);
	},

	/**
	 * Reveal an order's address.
	 *
	 * A POST rather than a link, and a redirect carrying a flag rather than a
	 * render that always decrypts. Both follow from the same rule: reading this
	 * is an ACT, not a view. The decryption and the audit write both happen in
	 * `revealShipping`, which writes the audit row FIRST and returns nothing if
	 * it cannot. This only carries the operator's intent through the redirect.
	 *
	 * `?reveal=1` in the URL is what the page reads. It means the operator
	 * asked; it is not a permission - the page calls `revealShipping` again,
	 * which checks `view_pii` and audits again. Sharing the URL reveals nothing
	 * to somebody who lacks the capability, and reveals it with THEIR name on
	 * the audit row if they have it.
	 */
	reveal: async ({ params }) => {
		requireCapability('view_pii');
		redirect(303, `/admin/orders/${params.id}?reveal=1`);
	}
};
