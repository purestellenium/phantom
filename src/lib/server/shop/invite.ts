import { and, asc, eq, inArray } from 'drizzle-orm';

import { db } from '$lib/server/db/client';
import { orders, products } from '$lib/server/db/schema';
import { productBySlug, type CatalogProduct } from '$lib/server/shop/catalog';
import { INVITE_SLUG } from '$lib/shop/invite';

/**
 * The invite: the one product this application knows by name.
 *
 * Everything else in the catalog is data - an operator makes it, prices it,
 * retires it, and no code anywhere cares which rows exist. The invite is
 * different because two surfaces are built around it: the shop pins it above
 * the grid rather than filing it among the stickers, and the home page's goal
 * meter is measuring progress toward being able to buy it - counting toward
 * this row's price, which is the only place that number lives. Both need a way
 * to ask "which product is that one", and a reserved slug is the cheapest
 * answer that needs no schema change.
 *
 * It is otherwise an ordinary product row. Its name, description, picture,
 * stock and availability window are edited in the console like anything else -
 * which is the point of storing it as a product rather than writing it into a
 * component: the copy and the photograph are the program's to change on a
 * Tuesday afternoon, and only its identity is ours.
 *
 * NOTHING HERE IS A GATE. The shop still checks purchasability and the purchase
 * transaction still checks price, stock, eligibility and the per-user limit.
 * This module only answers questions about which row is the invite and whether
 * somebody already has one.
 */

/** The invite product, or null where nobody has created it yet.
 *
 *  Null is a real state and not an error: a fresh database has no catalog at
 *  all, and every caller here is expected to carry on without the card rather
 *  than fail. */
export async function inviteProduct(): Promise<CatalogProduct | null> {
	return productBySlug(INVITE_SLUG);
}

/**
 * Order states that mean the invite is actually theirs.
 *
 * Placed, on-hold and unfulfilled count as much as fulfilled: the seconds have
 * left their balance and the thing is coming (again, for an unfulfilled one). Rejected and cancelled do not, and the
 * reason is written on the states themselves - both put the seconds back, so an
 * account in either of those has neither the invite nor the hours, and telling
 * it the goal is met would be telling it a lie in both directions.
 */
const SECURED = ['placed', 'on_hold', 'fulfilled', 'unfulfilled'] as const;

/** The order that made the invite theirs, as the home page's ticket stub needs
 *  it: enough to say when it was bought and to link through to the rest. */
export type InviteOrder = { id: string; state: (typeof SECURED)[number]; boughtAt: Date };

/**
 * The order by which this person has the invite, or null.
 *
 * One query, joined on the slug rather than on an id read separately, so this
 * costs a single round trip on a page that runs it on every visit.
 *
 * The OLDEST secured order wins where somebody somehow has two. The row is
 * shown as "this is when you got your ticket", and the honest answer to that is
 * the first time they did, not the most recent.
 */
export async function inviteOrder(userId: string): Promise<InviteOrder | null> {
	const [row] = await db
		.select({ id: orders.id, state: orders.state, boughtAt: orders.createdAt })
		.from(orders)
		.innerJoin(products, eq(products.id, orders.productId))
		.where(
			and(
				eq(orders.userId, userId),
				eq(products.slug, INVITE_SLUG),
				inArray(orders.state, [...SECURED])
			)
		)
		.orderBy(asc(orders.createdAt))
		.limit(1);

	if (!row) return null;
	/* The `where` above already restricts the column to these three; the cast
	   says so to the type system, which only knows the full enum. */
	return { ...row, state: row.state as InviteOrder['state'] };
}

/**
 * Whether this person has bought the invite.
 *
 * The same question with the answer thrown away, for the callers that only
 * need the boolean. One implementation so the two cannot disagree about what
 * "has the invite" means.
 */
export async function hasInvite(userId: string): Promise<boolean> {
	return (await inviteOrder(userId)) !== null;
}
