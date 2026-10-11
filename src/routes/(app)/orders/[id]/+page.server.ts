import { REFERRAL_STICKERS_SLUG } from '$lib/referral';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { orderHistory } from '$lib/server/log';
import { peopleById } from '$lib/server/people';

import { requireOnboarded } from '$lib/server/auth/session';
import { entriesForOrder } from '$lib/server/ledger';
import { productById, revisionFor } from '$lib/server/shop/catalog';
import { orderById, transitionOrder, transitionsFor } from '$lib/server/shop/orders';
import { describeOptions, parseOptionSchema } from '$lib/shop/options';

/**
 * One order, in full: what it was, what it cost, everywhere it has been, and
 * what the ledger did about it.
 *
 * The ledger entries are shown next to the state history on purpose. They are
 * two halves of the same event and keeping them on separate screens is how a
 * participant ends up asking whether a rejected order was actually refunded -
 * a question the platform should never make anybody ask.
 *
 * The address is NOT here, even though it is the buyer's own. It is encrypted
 * onto the order and reading it is a capability-gated, individually audited act
 * (see $lib/server/shop/shipping.ts); decrypting it on every page load to show
 * somebody something they typed would make the audit trail meaningless. What
 * the page confirms is that an address is held.
 */
export const load: PageServerLoad = async ({ params }) => {
	const user = requireOnboarded();

	const order = await orderById(params.id);
	/* Not found rather than forbidden for somebody else's order. A 403 confirms
	   the id exists, which is a small thing to leak and free not to. */
	if (!order || order.userId !== user.id) error(404);

	const [transitions, entries, revision, product] = await Promise.all([
		transitionsFor(order.id),
		entriesForOrder(order.id),
		revisionFor(order.productId, order.productVersion),
		productById(order.productId)
	]);

	/* Options are labelled from the revision the order bought, not from the
	   product as it is now. A product whose options changed since should still
	   render this order's choices with the words that were on screen when they
	   were made. */
	const schema = parseOptionSchema(revision?.optionSchema ?? null);
	const options = describeOptions(schema.ok ? schema.options : [], order.options);

	/* One history: the moves and the money, in the order they happened, with
	   who did each. */
	const people = await peopleById([
		...transitions.map((t) => t.actorId),
		...entries.map((e) => e.actorId)
	]);
	const log = orderHistory(transitions, entries, people);

	return {
		order,
		log,
		imageUrl: product?.imageUrl ?? null,
		/* The referral stickers: credited back as they are claimed, so free -
		   see the orders list. */
		free: product?.slug === REFERRAL_STICKERS_SLUG,
		/* The product as it is now, for a link from the line; null if it has
		   been unlisted since. */
		productSlug: product?.active ? product.slug : null,
		email: user.email,
		options,
		cancellable: order.state === 'placed',
		/* Not a reopen. A replacement is a new order at today's price with today's
		   stock, linked back to this one - reopening in place does not recheck
		   whether the person can still afford it. */
		replaceSlug: order.state === 'rejected' && product?.active === true ? product.slug : null
	};
};

/**
 * Cancelling, which is the one thing a participant can do to an order after
 * placing it. The rules live in `transitionOrder`, because that module is also
 * reached from the console, and a rule written here would be a rule the other
 * caller does not get.
 */
export const actions: Actions = {
	cancel: async ({ params }) => {
		const user = requireOnboarded();

		const order = await orderById(params.id);
		if (!order || order.userId !== user.id) error(404);

		const outcome = await transitionOrder({
			orderId: order.id,
			transition: 'cancel',
			actor: user,
			reason: 'cancelled by the participant',
			/* A cancellation an hour after placement is the case this exists for,
			   and nothing has been picked or packed, so the unit goes back on the
			   shelf. An operator rejecting an order later chooses for themselves -
			   see the console, where restock is a checkbox with no default. */
			restock: true
		});

		if (!outcome.ok) return fail(400, { error: outcome.error });

		redirect(303, `/orders/${order.id}`);
	}
};
