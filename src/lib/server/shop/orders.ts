import { and, desc, eq, inArray, sql as raw } from 'drizzle-orm';

import { isUuid } from '$lib/uuid';
import { recordEvent } from '$lib/server/analytics';
import { recordAudit } from '$lib/server/audit';
import { can } from '$lib/server/auth/authorize';
import type { SessionUser } from '$lib/server/auth/session';
import { db } from '$lib/server/db/client';
import {
	orderTransitions,
	orders,
	type Order,
	type OrderState,
	type OrderTransition
} from '$lib/server/db/schema';
import { nudgeOutbox } from '$lib/server/jobs';
import { refund } from '$lib/server/ledger';
import { reverseStickerCredit } from '$lib/server/referrals';
import { enqueue } from '$lib/server/outbox';
import { adjustStock } from '$lib/server/shop/catalog';

/**
 * Moving an order, and the rules about who may move it where.
 *
 * Every transition in this file does the same five things, in the same order,
 * and the shape is not incidental - it is the wiki's minimum transition
 * contract:
 *
 *   1. authorise the actor for THIS transition, not for orders generally;
 *   2. update the row with the expected current state in the WHERE clause;
 *   3. append an immutable transition row naming actor and reason;
 *   4. run the economic compensation, if the transition has one;
 *   5. audit, and enqueue any notification.
 *
 * Step two is the one that matters most. A status handler that validates the
 * target string but not the prior state or the affected row lets an order move
 * backwards, twice, from a stale tab, with no actor and no reason recorded. Putting the expected state in the WHERE
 * means a stale request updates zero rows and is told so, rather than winning
 * a race it did not know it was in.
 *
 * The other rule, from the compensating-actions page: A REVERSAL IS NEVER THE
 * ORIGINAL TRANSITION RUN BACKWARDS. Rejecting is its own command with its own
 * authority and its own compensation. There is no un-reject, because the honest
 * form of "we changed our mind" is a new order that re-checks affordability -
 * Fallout reopens rejected orders without rechecking, and the result is a live
 * order with no funds behind it.
 *
 * `unfulfil` is not an un-fulfil in that forbidden sense either: it is its own
 * command, for goods that were sent and did not arrive or came back, and it
 * lands in its own state rather than back at `placed`. An unfulfilled order is
 * still paid for and still owed - an operator reships it (`fulfil`) or gives
 * the value back (`reject`, or `cancel`) - but the participant can no longer
 * cancel it themselves, because by then the goods may be on their way back to
 * them.
 */

/** Nothing moves out of these. */
const TERMINAL: readonly OrderState[] = ['rejected', 'cancelled'];

export function isTerminal(state: OrderState): boolean {
	return TERMINAL.includes(state);
}

export type TransitionResult = { ok: true; order: Order } | { ok: false; error: string };

/** Every move a caller can ask for. A closed set, because a transition is a
 *  named command with its own rules and not a target state somebody types. */
export type TransitionName = 'hold' | 'release' | 'fulfil' | 'unfulfil' | 'reject' | 'cancel';

type TransitionSpec = {
	from: readonly OrderState[];
	to: OrderState;
	/** Whether the money comes back. */
	refunds: boolean;
	/** What the participant is told, and what goes in the transition row when the
	 *  operator gives no reason of their own. */
	defaultReason: string;
};

const TRANSITIONS = {
	hold: {
		from: ['placed'],
		to: 'on_hold',
		refunds: false,
		defaultReason: 'put on hold by an operator'
	},
	release: {
		from: ['on_hold'],
		to: 'placed',
		refunds: false,
		defaultReason: 'taken off hold'
	},
	fulfil: {
		/* From `unfulfilled` too: that is reshipping it. */
		from: ['placed', 'on_hold', 'unfulfilled'],
		to: 'fulfilled',
		refunds: false,
		defaultReason: 'fulfilled'
	},
	unfulfil: {
		from: ['fulfilled'],
		to: 'unfulfilled',
		/* No refund here: it is still owed, and reshipping is the usual answer.
		   Refunding is the separate reject or cancel that may follow. */
		refunds: false,
		defaultReason: 'marked unfulfilled - it did not reach them'
	},
	reject: {
		from: ['placed', 'on_hold', 'unfulfilled'],
		to: 'rejected',
		refunds: true,
		defaultReason: 'rejected by an operator'
	},
	cancel: {
		/* From `placed` for the participant - an order on hold is one somebody is
       already looking at, and letting it be cancelled underneath them means
       the hold decides nothing. From `unfulfilled` for an operator only; see
       `authorise`. */
		from: ['placed', 'unfulfilled'],
		to: 'cancelled',
		refunds: true,
		defaultReason: 'cancelled by the participant'
	}
} satisfies Record<TransitionName, TransitionSpec>;

/** Every transition there is, once, so the console and the rules cannot drift
 *  apart by one list being edited and the other not. */
export const TRANSITION_NAMES =
	/* SAFETY: `Object.keys` widens to `string[]` and loses nothing else.
     TRANSITIONS is declared `satisfies Record<TransitionName, TransitionSpec>`,
     so its keys are exactly that union - a name without a spec, or a spec
     without a name, stops the declaration above compiling. */
	Object.keys(TRANSITIONS) as TransitionName[];

export type TransitionInput = {
	orderId: string;
	transition: TransitionName;
	actor: SessionUser;
	/** Free text from the operator. Stored verbatim on the transition row. */
	reason?: string | null;
	/**
	 * Whether to put the unit back on the shelf.
	 *
	 * An explicit argument with no default, because the platform baseline says
	 * stock restoration is a separate explicit action and because the right
	 * answer genuinely varies: a rejected order for something already picked and
	 * packed should not restock, and a cancelled one an hour after placement
	 * should. A refund that never restocks, and never says so, quietly shrinks
	 * the catalog every time.
	 *
	 * Only a transition that UNWINDS the order may carry it, and only once. Both
	 * halves of that are enforced in `transitionOrder`: `hold` and `release`
	 * return no goods, and a restock clears `stock_taken` so the same units
	 * cannot be put back a second time.
	 */
	restock?: boolean;
};

/**
 * Whether this person may run this transition on this order.
 *
 * `cancel` is the only one a participant can run, and only on their own order
 * while it is still `placed` - never once it has been sent and come back
 * unfulfilled. Everything else, and every cancel of an unfulfilled order,
 * needs `manage_orders`. Written as one function rather than
 * checked at each call site because a page and a server action would otherwise
 * each carry their own copy, and the copy on the page is not the check.
 */
function authorise(
	input: TransitionInput,
	order: Order
): { ok: true } | { ok: false; error: string } {
	if (input.transition === 'cancel') {
		if (can(input.actor, 'manage_orders')) return { ok: true };
		const own = order.userId === input.actor.id;
		if (own && order.state === 'placed') return { ok: true };
		return {
			ok: false,
			error:
				own && order.state === 'unfulfilled'
					? 'This order was sent and came back. Contact us and we will reship or refund it.'
					: 'You cannot cancel this order.'
		};
	}

	if (!can(input.actor, 'manage_orders')) {
		return { ok: false, error: 'You cannot change orders.' };
	}
	return { ok: true };
}

/**
 * Run a transition.
 *
 * One transaction: the state change, its history row, its refund and its audit
 * either all land or none do. A refund that commits without the state change is
 * value given back on an order that is still live.
 */
export async function transitionOrder(input: TransitionInput): Promise<TransitionResult> {
	const spec: TransitionSpec = TRANSITIONS[input.transition];

	/* Before a transaction is opened for an id that cannot name a row. `orderById`
	   guards this, and the console's move action reaches here without passing
	   through it - so a malformed route parameter was a 500 rather than the
	   refusal every other branch of this function returns. */
	if (!isUuid(input.orderId)) return { ok: false, error: 'That order does not exist.' };

	/* Annotated, not inferred - the same note lib/shop/purchase.ts carries. Now
	   that this is assigned rather than returned directly, an unannotated
	   callback widens every `ok: true` literal to `boolean` and TransitionResult
	   stops discriminating. */
	const result = await db.transaction(async (tx): Promise<TransitionResult> => {
		const [current] = await tx
			.select()
			.from(orders)
			.where(eq(orders.id, input.orderId))
			.for('update')
			.limit(1);

		if (!current) return { ok: false, error: 'That order does not exist.' };

		const allowed = authorise(input, current);
		if (!allowed.ok) return allowed;

		if (!spec.from.includes(current.state)) {
			/* The stale-tab case, and the message says which state it actually found
         rather than "invalid transition" - an operator looking at a screen that
         says `placed` needs to be told it is now `rejected`, or they will press
         the button again. */
			return {
				ok: false,
				error: isTerminal(current.state)
					? `This order is ${current.state} and cannot be changed. Reopening is a new order.`
					: `This order is ${current.state}, not ${spec.from.join(' or ')}.`
			};
		}

		/* ── whether the unit actually comes back ──────────────────────────────
       `restock` is the operator's intent and everything else here is whether
       that intent is possible.

       The transition has to be one that UNWINDS the order. `hold` and
       `release` move an order that is still live and still owed to the buyer,
       so there are no goods to put back - restocking on them was a way to
       hold and release the same order repeatedly and mint inventory out of
       nothing, three units becoming seven while the order stayed placed.
       `refunds` is exactly the set that gives the value back, so it is exactly
       the set that may give the unit back.

       And the order has to still be holding a unit. `stockTaken` is what
       happened at purchase - a product that was unlimited when it was bought
       decremented nothing, and `adjustStock`'s own `stock is not null` guard
       cannot see the difference because by now the product may well have a
       number on it. */
		if (input.restock && !spec.refunds) {
			return {
				ok: false,
				error: `Nothing comes back on a ${input.transition}, so there is nothing to restock.`
			};
		}
		const restocking = input.restock === true && current.stockTaken;

		const now = new Date();
		/* An operator cancelling somebody else's order is not "cancelled by the
		   participant", which is what the spec's default says. */
		const reason =
			input.reason?.trim() ||
			(input.transition === 'cancel' && input.actor.id !== current.userId
				? 'cancelled by an operator'
				: spec.defaultReason);

		/* The expected state is in the WHERE, so this is the point of
       serialisation and not the read above. Holding the row lock already makes
       a race impossible; the predicate is what makes it impossible to get wrong
       later if the lock is ever removed. */
		const [updated] = await tx
			.update(orders)
			.set({
				state: spec.to,
				stateAt: now,
				/* Cleared in the same statement that moves the state, so the units
           this order took are returned once and the flag no longer says it is
           holding any. A second restock then finds nothing to give back. */
				...(restocking ? { stockTaken: false } : {})
			})
			.where(and(eq(orders.id, current.id), eq(orders.state, current.state)))
			.returning();

		if (!updated) {
			return { ok: false, error: 'That order changed while you were looking at it.' };
		}

		let refundedEntryId: string | null = null;
		let restocked: number | null = null;

		/* Stock first, then the refund, so this function takes its locks in the
       same order the purchase path does - products, then the ledger account.
       Reversed, the two deadlock: a buyer holds the product row and waits for
       their account while an operator holds that account and waits for the
       product, and Postgres breaks the cycle by killing one of them. */
		if (restocking) {
			restocked = await adjustStock(current.productId, current.quantity, tx);
		}

		if (spec.refunds) {
			/* Idempotent on the ORDER rather than on this attempt: an order is
         refunded once, whichever transition got there. The unique index on the
         key is what enforces it, so two operators pressing reject at the same
         moment produce one refund and one of them is told the state moved. */
			const posted = await refund(
				{
					userId: current.userId,
					amount: current.totalPrice,
					reason: `${current.productName} - ${spec.to}`,
					idempotencyKey: `order:${current.id}:refund`,
					orderId: current.id,
					actorId: input.actor.id,
					metadata: { transition: input.transition, state: spec.to }
				},
				tx
			);
			refundedEntryId = posted.entry.id;
			/* A sticker order was paid for by a credit, not by the person: the
			   refund gives the fragment back, so the credit goes too, or the
			   cancel would leave them a fragment up. See referrals.ts. */
			await reverseStickerCredit(current, input.actor.id, tx);
		}

		await tx.insert(orderTransitions).values({
			orderId: current.id,
			fromState: current.state,
			toState: spec.to,
			actorId: input.actor.id,
			reason,
			metadata: {
				transition: input.transition,
				refundEntryId: refundedEntryId,
				restocked: restocking,
				stockAfter: restocked
			}
		});

		await enqueue(
			{
				effect: 'slack.order_state_changed',
				/* Keyed on the destination state, not on the order: an order that is
           held and then released and then rejected should produce three
           notifications, and one keyed only on the order id would produce
           one. */
				dedupeKey: `order:${current.id}:${spec.to}`,
				payload: { orderId: current.id, state: spec.to }
			},
			tx
		);

		await recordAudit(
			{
				action: `order.${input.transition}`,
				actorId: input.actor.id,
				subjectId: current.userId,
				metadata: {
					orderId: current.id,
					fromState: current.state,
					toState: spec.to,
					refunded: spec.refunds,
					refundEntryId: refundedEntryId,
					restocked: restocking,
					reason
				}
			},
			tx
		);

		return { ok: true, order: updated };
	});

	/* Committed, so the state-change notice can go now. See nudgeOutbox. */
	if (result.ok) {
		nudgeOutbox();
		recordEvent('order.transitioned', {
			transition: input.transition,
			by: result.order.userId === input.actor.id ? 'owner' : 'staff',
			kind: result.order.productKind
		});
	}
	return result;
}

/** Which transitions this person could run on this order right now. Drives
 *  which buttons render; every one of them is re-authorised in
 *  `transitionOrder`, because a rendered button is not a permission. */
export function availableTransitions(order: Order, actor: SessionUser): TransitionName[] {
	return TRANSITION_NAMES.filter((name) => {
		const spec: TransitionSpec = TRANSITIONS[name];
		if (!spec.from.includes(order.state)) return false;
		return authorise({ orderId: order.id, transition: name, actor }, order).ok;
	});
}

/** The word on the button, and the word in a sentence about what happened. */
export const TRANSITION_LABELS = {
	hold: 'put on hold',
	release: 'take off hold',
	fulfil: 'mark fulfilled',
	unfulfil: 'mark unfulfilled',
	reject: 'reject and refund',
	cancel: 'cancel and refund'
} satisfies Record<TransitionName, string>;

/* ── reading ─────────────────────────────────────────────────────────────── */

export async function orderById(id: string): Promise<Order | null> {
	if (!isUuid(id)) return null;
	const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
	return row ?? null;
}

export async function ordersFor(userId: string): Promise<Order[]> {
	return db.select().from(orders).where(eq(orders.userId, userId)).orderBy(desc(orders.createdAt));
}

export async function transitionsFor(orderId: string): Promise<OrderTransition[]> {
	return db
		.select()
		.from(orderTransitions)
		.where(eq(orderTransitions.orderId, orderId))
		.orderBy(orderTransitions.createdAt);
}

/**
 * The operator's queue.
 *
 * Deliberately returns the buyer's name and email and NEVER the shipping
 * snapshot. That is Sidekick's boundary, which the wiki holds up as the right
 * one: a list of orders is a work queue, and the address is a separate,
 * capability-gated, individually audited reveal. A list that carried addresses
 * would be a bulk PII export that nothing recorded.
 */
export async function ordersInState(states: readonly OrderState[], limit = 200): Promise<Order[]> {
	return db
		.select()
		.from(orders)
		.where(inArray(orders.state, [...states]))
		.orderBy(desc(orders.stateAt))
		.limit(limit);
}

/** How many orders are in each state, for the console's overview and for the
 *  "what is stuck" question an alert would ask. */
export async function orderCounts(): Promise<Record<string, number>> {
	const rows = await db
		.select({ state: orders.state, count: raw<number>`count(*)::int` })
		.from(orders)
		.groupBy(orders.state);
	return Object.fromEntries(rows.map((row) => [row.state, row.count]));
}
