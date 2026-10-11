import { and, eq, inArray, sql as raw } from 'drizzle-orm';

import { fragments } from '$lib/fragments';
import { recordEvent } from '$lib/server/analytics';
import { recordAudit } from '$lib/server/audit';
import { eligibilityAllows } from '$lib/server/auth/eligibility';
import { currentEligibility } from '$lib/server/auth/eligibility-refresh';
import type { SessionUser } from '$lib/server/auth/session';
import { db } from '$lib/server/db/client';
import { orderTransitions, orders, products, users, type Order } from '$lib/server/db/schema';
import { nudgeOutbox } from '$lib/server/jobs';
import { InsufficientBalance, spend } from '$lib/server/ledger';
import { enqueue } from '$lib/server/outbox';
import { creditStickers, stickersClaimed, stickersEarned } from '$lib/server/referrals';
import { revisionFor } from '$lib/server/shop/catalog';
import { parseOptionSchema, surchargeFor, validateOptions } from '$lib/shop/options';
import { sealShipping, type ShippingSnapshot } from '$lib/server/shop/shipping';
import { shopWindowNow } from '$lib/server/shop/window';
import { isUniqueViolation } from '$lib/server/db/errors';
import { REFERRAL_STICKERS_SLUG } from '$lib/referral';
import { INVITE_SLUG } from '$lib/shop/invite';
import { lockedOut, SHOP_LOCKED_MESSAGE } from '$lib/shop/locked';
import { normalizeCountry } from '$lib/countries';
import { regionBlocked, regionBlockedMessage } from '$lib/shop/regions';

/**
 * Buying something.
 *
 * This is the most consequential transaction in the application and it is one
 * function on purpose. Every check that decides whether a sale may happen is in
 * here, in order, inside one transaction, holding the account lock - because
 * every one of the defects the wiki records in this area is a check that lived
 * somewhere else.
 *
 * The order, which is the wiki's recommended invariant almost line for line:
 *
 *   authorise participant and product
 *   lock the account
 *   recompute the spendable balance from the entries
 *   guard stock with a conditional update
 *   guard the per-person quota
 *   validate the options against the FROZEN revision
 *   append the debit
 *   create the order and its first transition
 *   enqueue the notification
 *   commit
 *
 * Two things are worth saying plainly about what this does NOT do.
 *
 * It does not trust the page. Price, stock, availability, eligibility and the
 * shop window are all re-read here even though the product page checked them -
 * a server action is a POST endpoint, the page's checks are a courtesy to the
 * reader, and the catalog is advisory until the server rechecks it inside the
 * mutation.
 *
 * It does not call anything external. The Slack message goes in the outbox and
 * is sent by a worker. A network call in the middle of this would be a network
 * call holding an account lock, which is how one slow provider becomes a shop
 * that nobody can buy from.
 */

export type PurchaseInput = {
	user: SessionUser;
	productId: string;
	quantity: number;
	/** Raw form values, keyed by option key. Checked against the frozen revision
	 *  inside the transaction - never before it. */
	options: Record<string, string>;
	/** Required for physical products, refused for everything else. */
	shipping: ShippingSnapshot | null;
	/**
	 * The purchase intent, minted when the form was rendered.
	 *
	 * This is what makes a double-click buy one thing. The same value arrives on
	 * every resubmission of the same form, hits the unique index on
	 * `orders.idempotency_key`, and returns the order that already exists.
	 * Reloading the page mints a new one, which is correct - that is a person who
	 * has decided to buy another.
	 */
	intent: string;
	/**
	 * The rejected order this one replaces, if any.
	 *
	 * This is what "reopening" is here. Fallout reopens a rejected order in
	 * place, which does not rerun affordability and does not regrant the benefit
	 * it revoked - so the order is live again with no funds behind it. A
	 * replacement is a NEW order that goes through every check in this function
	 * at today's price and today's stock, and carries a link back so the pair is
	 * legible.
	 */
	replacesOrderId?: string | null;
};

export type PurchaseOutcome =
	{ ok: true; order: Order; repeat: boolean } | { ok: false; error: string };

/**
 * There is no cap on how many of one thing an order may hold.
 *
 * There used to be a flat ten, described as typo protection. It was not
 * protecting much: a typo is already refused by the two limits that mean
 * something - `stock`, which a guarded decrement enforces, and the balance,
 * which the ledger replays under a lock and will not let go negative - so the
 * ten only ever bit on products those two allow, which is exactly the case
 * where the buyer meant it. What it did instead was cap the stackable grants at
 * ten units an order: `hardware-grant` is $5 a unit, so "stack as many as you
 * need" stopped at $50 however many hours somebody had.
 *
 * What replaces it is not a smaller number but the two checks below, which are
 * about arithmetic rather than policy: a quantity has to be a whole number of
 * at least one, and the total it produces has to be a figure this program can
 * represent exactly. See `safeTotal`.
 */

/**
 * The only ceiling left on a quantity, and it is about arithmetic rather than
 * policy.
 *
 * Prices are seconds in a `bigint` column read into a JS number, so they are
 * exact to 2^53 and silently approximate past it. An approximate total is not
 * a rounding nuisance here: the orders table checks that total_price equals
 * unit_price times quantity, Postgres evaluates that in exact integers, and a
 * total that drifted by one would come back as a constraint violation - a 500
 * - rather than as a sentence. The debit would also be for a figure that is
 * not the figure on the order.
 *
 * Nobody reaches this by accident; the balance runs out first by a factor of
 * billions. It is the floor under the arithmetic, not a shopping limit, which
 * is why the refusal it produces says so plainly.
 */
function safeTotal(unitPrice: number, quantity: number): number | null {
	const total = unitPrice * quantity;
	return Number.isSafeInteger(total) ? total : null;
}

/**
 * The order states that consume a person's quota.
 *
 * The wiki asks for this to be an explicit policy choice and records Stasis
 * getting it wrong: its per-user maximum counts original purchase rows even
 * after the linked order was rejected and refunded, so a rejected order
 * permanently blocks the replacement it was supposed to make room for.
 *
 * The choice here is that REJECTED AND CANCELLED ORDERS RELEASE THE QUOTA. If
 * we took the value back, the person has bought nothing, and a limit that says
 * otherwise is punishing them for our decision. `fulfilled`, `placed` and
 * `on_hold` all count.
 */
const QUOTA_STATES = ['placed', 'on_hold', 'fulfilled', 'unfulfilled'] as const;

export async function purchase(input: PurchaseInput): Promise<PurchaseOutcome> {
	const { user } = input;

	/* Whole and positive. Not a limit on how many - see the note above - but on
	   what a quantity IS: the orders table carries a check that total_price is
	   unit_price times quantity, and a fraction or a zero cannot satisfy it, so
	   this refuses with a sentence rather than letting Postgres refuse with a
	   constraint violation. */
	if (!Number.isInteger(input.quantity) || input.quantity < 1) {
		return { ok: false, error: 'Choose a whole quantity of at least one.' };
	}

	/* ── eligibility, as of now ─────────────────────────────────────────────
     The stored decision - no call to HCA, which is asked only at sign-in and
     on the home page's "check again" (see eligibility-refresh.ts). Resolved
     before the transaction anyway, so nothing that could ever reach for the
     network runs while it holds locks.

     Resolved unconditionally, even though only a product with
     `requiresEligibility` will consult it, because whether the product needs
     it is not known until the transaction has the row. It costs nothing. */
	const [receipt] = await db
		.select()
		.from(orders)
		.where(eq(orders.idempotencyKey, input.intent))
		.limit(1);
	if (receipt) {
		return receipt.userId === user.id
			? { ok: true, order: receipt, repeat: true }
			: { ok: false, error: 'That purchase could not be completed.' };
	}
	const eligibility = await currentEligibility(user);

	try {
		/* Annotated, not inferred. Assigning the transaction to a variable instead
       of returning it directly widens every `ok: true` literal to `boolean`,
       and the union stops discriminating. */
		const result: PurchaseOutcome = await db.transaction(async (tx) => {
			/* ── the same intent arriving twice ────────────────────────────────
         Checked first, before anything is locked or spent. A retry must not
         be refused for being out of stock when the stock it wants is the unit
         it already bought. */
			const [existing] = await tx
				.select()
				.from(orders)
				.where(eq(orders.idempotencyKey, input.intent))
				.limit(1);

			if (existing) {
				if (existing.userId !== user.id) {
					/* Someone else's intent. Unguessable in practice, but the check
             costs nothing and its absence would be a way to read another
             person's order id back out of a form. */
					return { ok: false, error: 'That purchase could not be completed.' };
				}
				return { ok: true, order: existing, repeat: true };
			}

			/* ── the shop window, from the row ─────────────────────────────────
         The authoritative one, and it is deliberately AFTER the idempotency
         check: a retry of an order that already exists is being shown its own
         receipt, not making a new sale, and a shop that closed in between must
         not turn that into an error for a purchase that already happened.

         From here on the transaction holds a consistent view, so this is also
         the last moment the answer can change. A shop that closes after this
         line lets the purchase in flight finish, which is the intended
         behaviour; one that was already closed when the transaction opened
         does not, whatever this process happened to have in memory. */
			const live = await shopWindowNow(tx);

			/* ── the product, locked ───────────────────────────────────────────
         `for update` on the product row rather than a bare read, because the
         stock guard below has to be the only thing that can decrement it
         between the check and the write. */
			const [product] = await tx
				.select()
				.from(products)
				.where(eq(products.id, input.productId))
				.for('update')
				.limit(1);

			if (!product) return { ok: false, error: 'That product no longer exists.' };

			/* The referral stickers are a reward already earned rather than a sale,
			   so a closed shop does not hold them back. Everything else waits. */
			const stickers = product.slug === REFERRAL_STICKERS_SLUG;
			if (!live.open && !stickers) return { ok: false, error: 'The shop is closed.' };
			if (!product.active) return { ok: false, error: 'That product is not for sale.' };
			/* Held to the event by an operator: the invite and the flight
			   stipend only. See $lib/shop/locked.ts. */
			if (lockedOut(input.user.shopLocked, product.slug)) {
				return { ok: false, error: SHOP_LOCKED_MESSAGE };
			}
			/* Not sent where it cannot go. The address this order ships to, read
			   fresh by the caller, where there is one; otherwise the country
			   stored for the buyer. See $lib/shop/regions.ts. */
			const destination = normalizeCountry(input.shipping?.country) ?? input.user.country;
			if (destination && regionBlocked(product.blockedCountries, destination)) {
				return { ok: false, error: regionBlockedMessage(destination) };
			}

			const now = new Date();
			if (product.availableFrom && product.availableFrom > now) {
				return { ok: false, error: 'That product is not available yet.' };
			}
			if (product.availableUntil && product.availableUntil <= now) {
				return { ok: false, error: 'That product is no longer available.' };
			}

			/* ── who may buy it ────────────────────────────────────────────────
         Reads the stored decision, never the raw signals. lib/auth/eligibility
         is emphatic about why: gate the shop on the verification claim and
         project submission on the identity check, and the same person can be
         eligible for one and refused by the other with nothing in either
         path revealing that the two questions had different answers. */
			if (product.requiresEligibility && !eligibilityAllows(eligibility)) {
				return {
					ok: false,
					error: 'You need to be verified and eligible with Hack Club before you can buy this.'
				};
			}

			/* ── the referral stickers: earned, and once ────────────────────────
         Checked here as well as on the page, since the page is only a
         courtesy. One pack, however the product's limit is set, and a live
         order already placed for them is the claim spent. */
			if (stickers) {
				if (input.quantity !== 1)
					return { ok: false, error: 'The custom stickers are one pack each.' };
				if (!(await stickersEarned(user.id, tx))) {
					return {
						ok: false,
						error: 'These are free once a friend you invited finishes signing up.'
					};
				}
				if (await stickersClaimed(user.id, tx)) {
					return { ok: false, error: 'You have already claimed your custom stickers.' };
				}
			}

			/* ── what it was, at the version being sold ────────────────────────
         The revision, not the live row. They are the same object right now -
         we are holding the row lock - but reading the revision is what makes
         the frozen version on the order true by construction rather than by a
         coincidence that a later refactor could break. */
			const revision = await revisionFor(product.id, product.version, tx);
			if (!revision) {
				/* A product whose current version has no revision row cannot be sold,
           because the order would freeze a version number that names nothing.
           This should be unreachable - createProduct and updateProduct both
           write one - and if it happens it is a data bug worth refusing over
           rather than papering past. */
				return {
					ok: false,
					error: 'That product is misconfigured and cannot be bought right now.'
				};
			}

			/* ── the options, against the frozen schema ────────────────────────── */
			const parsed = parseOptionSchema(revision.optionSchema);
			if (!parsed.ok) {
				return { ok: false, error: "That product's options are misconfigured." };
			}
			const validated = validateOptions(parsed.options, input.options);
			if (!validated.ok) return { ok: false, error: validated.error };

			/* ── shipping, required by kind and refused by kind ────────────────
         Both directions. A physical order without an address cannot be
         fulfilled; a digital order WITH one is PII we had no reason to
         collect, and the database has a check constraint saying so. */
			if (revision.kind === 'physical' && !input.shipping) {
				return { ok: false, error: 'This ships, so it needs an address.' };
			}
			if (revision.kind !== 'physical' && input.shipping) {
				return { ok: false, error: 'This does not ship and cannot take an address.' };
			}

			/* ── the order being replaced, if one was named ────────────────────
         Checked rather than trusted: the id arrives from a form, so without
         this it is a way to attach your order to somebody else's, or to a
         live one, which would make the link say something untrue. */
			let replaces: string | null = null;
			if (input.replacesOrderId) {
				const [prior] = await tx
					.select({ id: orders.id, userId: orders.userId, state: orders.state })
					.from(orders)
					.where(eq(orders.id, input.replacesOrderId))
					.limit(1);

				if (!prior || prior.userId !== user.id || prior.state !== 'rejected') {
					return {
						ok: false,
						error: 'That order cannot be replaced.'
					};
				}
				replaces = prior.id;
			}

			/* ── the per-person limit ──────────────────────────────────────────── */
			if (revision.perUserLimit !== null) {
				const [counted] = await tx
					.select({ total: raw<number>`coalesce(sum(${orders.quantity}), 0)::int` })
					.from(orders)
					.where(
						and(
							eq(orders.userId, user.id),
							eq(orders.productId, product.id),
							inArray(orders.state, [...QUOTA_STATES])
						)
					);

				const already = counted?.total ?? 0;
				if (already + input.quantity > revision.perUserLimit) {
					return {
						ok: false,
						error:
							already >= revision.perUserLimit
								? `You have already bought your limit of ${revision.perUserLimit}.`
								: `You can buy ${revision.perUserLimit - already} more of these.`
					};
				}
			}

			/* ── stock, as a guarded update ────────────────────────────────────
         `where stock >= quantity` in the statement itself, so the check and
         the decrement are one operation and two concurrent purchases cannot
         both pass. Reading stock and decrementing it in a transaction with no
         row lock and no guarded update lets both succeed, and the shop
         oversells.

         Products with null stock skip this entirely - there is nothing to
         guard and nothing to decrement. */
			if (product.stock !== null) {
				const [decremented] = await tx
					.update(products)
					.set({ stock: raw`${products.stock} - ${input.quantity}` })
					.where(and(eq(products.id, product.id), raw`${products.stock} >= ${input.quantity}`))
					.returning({ stock: products.stock });

				if (!decremented) {
					return {
						ok: false,
						error: product.stock <= 0 ? 'That has sold out.' : `Only ${product.stock} left.`
					};
				}
			}

			/* ── what this configuration costs ─────────────────────────────────
         The base, plus whatever the chosen options add. Both halves come out
         of the SAME frozen revision the options were just validated against:
         pricing off the live product while validating against the revision
         would be two different answers to "what is this product", which is
         the exact drift the revision exists to prevent. An operator who
         reprices an upgrade mid-checkout changes the next order, not this
         one.

         `unitPrice` on the order is therefore what one of them actually cost,
         not what the product's sticker said - which is what makes a refund,
         a statement line and the fulfilment list all agree without any of
         them re-deriving the surcharge. */
			const surcharge = surchargeFor(parsed.options, validated.values);
			const unitPrice = revision.price + surcharge;
			const total = safeTotal(unitPrice, input.quantity);
			if (total === null) {
				return { ok: false, error: 'That quantity is too large to price. Order fewer at once.' };
			}

			/* ── the order ─────────────────────────────────────────────────────
         Everything economically meaningful is copied out of the revision, not
         read through the foreign key. Editing the product tomorrow changes
         nothing on this row. */
			const [order] = await tx
				.insert(orders)
				.values({
					userId: user.id,
					productId: product.id,
					productVersion: product.version,
					productName: revision.name,
					productKind: revision.kind,
					currency: revision.currency,
					unitPrice,
					quantity: input.quantity,
					totalPrice: total,
					options: Object.keys(validated.values).length ? validated.values : null,
					shippingEncrypted: input.shipping
						? sealShipping(input.shipping, {
								userId: user.id,
								idempotencyKey: input.intent
							})
						: null,
					state: 'placed',
					stateAt: now,
					idempotencyKey: input.intent,
					replacesOrderId: replaces,
					stockTaken: product.stock !== null
				})
				.returning();

			/* ── the money ─────────────────────────────────────────────────────
         Locks the account, replays the balance from the entries, refuses if it
         is short, and appends the debit. The cached balance plays no part -
         see lib/ledger.ts.

         AFTER the order, so the entry carries its order id at insert. It used
         to run first and be patched with an UPDATE afterwards, which is the one
         thing lib/ledger.ts says never happens to a ledger row - and an
         append-only table that the application updates cannot be enforced as
         append-only by the database either. Nothing is lost by the swap: both
         writes are in the same transaction, and `spend` still refuses before
         anything is committed. */
			/* Free, and still on the ledger: the stickers' credit lands first so the
			   debit below spends it rather than the participant's own hours. */
			if (stickers) await creditStickers(user.id, total, order.id, tx);

			const debit = await spend(
				{
					userId: user.id,
					amount: total,
					reason: `${revision.name} × ${input.quantity}`,
					/* Keyed on the intent rather than on the order id, because the order
             does not exist yet and the debit must be idempotent against the
             same retry the order is. */
					idempotencyKey: `intent:${input.intent}:debit`,
					actorId: user.id,
					orderId: order.id,
					metadata: {
						productId: product.id,
						productVersion: product.version,
						unitPrice,
						quantity: input.quantity
					}
				},
				tx
			);

			/* The history starts at birth. A transition table whose first row is the
         first correction cannot answer when the order was placed or by whom. */
			await tx.insert(orderTransitions).values({
				orderId: order.id,
				fromState: null,
				toState: 'placed',
				actorId: user.id,
				reason: 'placed by the participant',
				metadata: { entryId: debit.entry.id, balanceAfter: debit.balance }
			});

			await enqueue(
				{
					effect: 'slack.order_placed',
					dedupeKey: `order:${order.id}:placed`,
					payload: { orderId: order.id }
				},
				tx
			);

			await recordAudit(
				{
					action: 'order.placed',
					actorId: user.id,
					subjectId: user.id,
					metadata: {
						orderId: order.id,
						productId: product.id,
						productVersion: product.version,
						quantity: input.quantity,
						totalPrice: total,
						shipped: revision.kind === 'physical',
						replacesOrderId: replaces
					}
				},
				tx
			);

			/* The invite bought: the lock that held them to the event has done
			   its job, so it lifts by itself (see $lib/shop/locked.ts). In the
			   same transaction, so the order and the unlock stand or fall
			   together; on the audit log like an operator's unlock. */
			if (product.slug === INVITE_SLUG && user.shopLocked) {
				await tx
					.update(users)
					.set({ shopLocked: false, updatedAt: new Date() })
					.where(eq(users.id, user.id));
				await recordAudit(
					{
						action: 'shop.unlocked',
						actorId: user.id,
						subjectId: user.id,
						metadata: { shopLocked: false, reason: 'bought the invite', orderId: order.id }
					},
					tx
				);
			}

			return { ok: true, order, repeat: false };
		});

		/* Fired after the transaction, and only when it created something. Inside
       it this would count purchases that rolled back; on the `repeat` path it
       would count one person pressing twice as a second sale. No order id and
       no product name - what kind of thing sold, and how much of it, is the
       whole question a funnel asks. */
		/* Committed, so the order notice can go now rather than whenever something
		   next calls the dispatcher. Not on the `repeat` path: that is somebody
		   being shown a receipt for an order that already exists, and its notice
		   went out with the sale. See nudgeOutbox. */
		if (result.ok && !result.repeat) nudgeOutbox();

		if (result.ok && !result.repeat) {
			recordEvent('order.placed', {
				kind: result.order.productKind,
				/* What sold. A product name is catalog, not a person. */
				product: result.order.productName,
				quantity: result.order.quantity,
				total_seconds: result.order.totalPrice
			});
		}
		return result;
	} catch (error) {
		/* The one expected throw. Everything else in here returns a refusal, so a
       genuine fault still propagates and still becomes a 500 - which is what it
       should be. */
		if (error instanceof InsufficientBalance) {
			return {
				ok: false,
				error: `You have ${fragments(error.balance)} and this costs ${fragments(error.required)}.`
			};
		}

		/* The other expected throw: two submissions of the SAME intent in flight at
       once. The check at the top of this function only sees a committed order,
       so both passed it, and the loser hits the unique index on
       `idempotency_key` instead. That is the mechanism working - one order
       exists - and the person who pressed twice should be shown it rather than
       an error page for a purchase that succeeded. The sequential retry already
       returned here; this is the concurrent one catching up. */
		if (isUniqueViolation(error)) {
			const [existing] = await db
				.select()
				.from(orders)
				.where(eq(orders.idempotencyKey, input.intent))
				.limit(1);
			if (existing && existing.userId === user.id) {
				return { ok: true, order: existing, repeat: true };
			}
		}
		throw error;
	}
}

/**
 * A fresh purchase intent.
 *
 * Rendered into the form as a hidden field. It is unguessable because it is
 * also, in effect, the key to an order row - see the ownership check at the top
 * of `purchase` - and because a predictable one would let somebody else's
 * in-flight purchase be joined.
 */
export function newPurchaseIntent(): string {
	return crypto.randomUUID();
}
