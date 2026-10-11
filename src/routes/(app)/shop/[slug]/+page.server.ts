import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

import { chooseAddress } from '$lib/server/address';
import { can } from '$lib/server/auth/authorize';
import { eligibilityAllows } from '$lib/server/auth/eligibility';
import { addressLines, fetchHcaAddresses, hcaAddressPortalUrl } from '$lib/server/auth/hca';
import { requireOnboarded } from '$lib/server/auth/session';
import { countryList, countryName } from '$lib/countries';
import { lockedOut } from '$lib/shop/locked';
import { regionBlocked } from '$lib/shop/regions';
import { cachedBalance } from '$lib/server/ledger';
import { productBySlug, purchasabilityOf } from '$lib/server/shop/catalog';
import { newPurchaseIntent, purchase } from '$lib/server/shop/purchase';
import { snapshotFromHca, type ShippingSnapshot } from '$lib/server/shop/shipping';
import { stickersClaimed, stickersEarned } from '$lib/server/referrals';
import { shopWindow } from '$lib/server/shop/window';
import { INVITE_SLUG } from '$lib/shop/invite';
import { REFERRAL_STICKERS_SLUG } from '$lib/referral';
import { readOptionFields } from '$lib/shop/options';

/**
 * One product, and the form that buys it.
 *
 * The interesting thing on this page is the hidden `intent` field. It is minted
 * on the server on every render and is what makes a double-click buy one thing:
 * the same value arrives on every resubmission of this form, hits the unique
 * index on `orders.idempotency_key`, and returns the order that already exists.
 * A reload mints a new one, which is a person who has decided to buy another.
 *
 * When a submission fails, the intent comes back with the refusal and is
 * reused - so correcting a typo and pressing buy again is still the same
 * purchase, not a second one.
 *
 * Native form, native POST, native validation attributes; the server
 * revalidates all of it because the attributes are a courtesy to the reader.
 */

/** What stands between the reader and the buy form, decided once. Each of
 *  these is also re-checked inside the purchase transaction; this only decides
 *  what to render. */
type Refusal = { title: string; body: string };

export const load: PageServerLoad = async ({ params, url }) => {
	const user = requireOnboarded();

	const product = await productBySlug(params.slug);
	if (!product || !product.active) error(404);

	/* The referral stickers: free, and only to somebody who has earned them.
	   See lib/server/referrals.ts. */
	const free = product.slug === REFERRAL_STICKERS_SLUG;
	const [window, balance, earned, claimed] = await Promise.all([
		shopWindow(),
		cachedBalance(user.id),
		free ? stickersEarned(user.id) : false,
		free ? stickersClaimed(user.id) : false
	]);

	const blocked = purchasabilityOf(product);
	const eligible = eligibilityAllows(user.eligibility);
	const needsEligibility = product.requiresEligibility && !eligible;

	let refusal: Refusal | null = null;
	if (lockedOut(user.shopLocked, product.slug)) {
		refusal = {
			title: 'not for you right now',
			body: "since you've received a visa letter or a flight stipend from us, your shop is limited to the invite and the flight stipend to phantom."
		};
	} else if (user.country && regionBlocked(product.blockedCountries, user.country)) {
		/* The shop does not list it here; this is someone arriving by a link. */
		refusal = {
			title: 'not available where you are',
			body: `this can't be sent to ${countryName(user.country)}, where your shipping address is.`
		};
	} else if (free && !earned) {
		refusal = {
			title: 'invite a friend first',
			body: 'these are free once somebody you invited finishes signing up and is verified. your invite link is on your home page.'
		};
	} else if (free && claimed) {
		refusal = {
			title: 'already claimed',
			body: 'your custom stickers are on their way. your orders are listed on the shop page.'
		};
	} else if (!window.open && !free) {
		refusal = {
			title: 'the shop is closed',
			body: window.message ?? 'nothing can be bought right now.'
		};
	} else if (blocked) {
		refusal = {
			title: 'not available',
			body:
				blocked.reason === 'out_of_stock'
					? 'this has sold out.'
					: blocked.reason === 'not_yet'
						? `it opens on ${blocked.from.toISOString().slice(0, 10)}.`
						: blocked.reason === 'closed'
							? `it closed on ${blocked.until.toISOString().slice(0, 10)}.`
							: 'this cannot be bought right now.'
		};
	} else if (needsEligibility) {
		refusal = {
			title: 'you are not eligible yet',
			body: 'Hack Club needs to verify you first. your home page says where that stands.'
		};
	}
	/* Not being able to afford it is deliberately NOT a refusal. The page still
	   draws the whole form - options, quantity, address - so the reader can see
	   everything the product offers and what each configuration costs; only the
	   buy button is disabled, with the shortfall beside it. The page works that
	   out against the live total (quantity and surcharges move it), from the
	   balance returned below. The purchase transaction checks it again. */

	/* Where it ships: the addresses saved on the buyer's Hack Club account, read
	   live, only for a physical thing that can actually be bought. Editing them
	   happens on HCA's own address page, in a new tab - it does not come back,
	   so this page is still here when they return to it. */
	let addresses: { id: string; primary: boolean; label: string; lines: string[] }[] = [];
	let addressError = false;
	let addressPortalUrl: string | null = null;
	let defaultAddressId: string | null = null;
	if (product.kind === 'physical' && !refusal) {
		/* Built before the fetch, not inside it. It is one string off the
		   configured host and cannot fail because HCA is unreachable. Computed in
		   the `try` it went missing on exactly the error that makes it matter:
		   the read fails, the page says "we couldn't read your Hack Club
		   addresses", and the one link that leads to fixing them is not drawn. */
		addressPortalUrl = hcaAddressPortalUrl();
		try {
			const list = await fetchHcaAddresses(user.id);
			addresses = (list ?? []).map((address) => ({
				id: address.id,
				primary: address.primary,
				label: address.label,
				lines: addressLines(address.raw)
			}));
			/* Preselected: the default set on the account, else HCA's primary. */
			defaultAddressId =
				chooseAddress(list ?? [], { defaultId: user.defaultAddressId })?.id ?? null;
		} catch {
			addressError = true;
		}
	}

	return {
		product: {
			name: product.name,
			description: product.description,
			imageUrl: product.imageUrl,
			imagePadding: product.imagePadding,
			/**
			 * The gallery, cover first.
			 *
			 * Assembled here rather than in the component because it is the one
			 * place that knows both halves: `imageUrl` is the cover every other
			 * surface shows and `images` is the rest, and the page below only ever
			 * wants the sequence. Deduplicated, because an operator who pastes the
			 * cover into the gallery box as well has asked for one photograph
			 * twice and meant it once.
			 *
			 * Empty for a product with no picture at all, and the page draws the
			 * generated field thumbnail then, exactly as it did before.
			 */
			gallery: [...new Set([product.imageUrl, ...(product.images ?? [])])].filter(
				(url): url is string => url !== null
			),
			price: product.price,
			stock: product.stock,
			perUserLimit: free ? 1 : product.perUserLimit,
			kind: product.kind,
			options: product.options
		},
		balance,
		free,
		/* Somebody who keeps the catalog gets a way from the shelf to the form
		   that edits it - the id is only sent to them. */
		catalogId: can(user, 'manage_catalog') ? product.id : null,
		refusal,
		/* Where it cannot go, said up front to someone whose country we do not
		   know yet - checkout will refuse an address in one of them. Shown beside
		   any other refusal too; the region one needs a known country, so the
		   two never say the same thing twice. */
		regionNotice:
			!user.country && product.blockedCountries.length > 0
				? `this item is unavailable in ${countryList(product.blockedCountries)}.`
				: null,
		/* Minted fresh on every render; a failed submission hands its own back
		   through the action's result and the page prefers that one. */
		intent: newPurchaseIntent(),
		replaces: url.searchParams.get('replaces'),
		addresses,
		addressError,
		addressPortalUrl,
		defaultAddressId
	};
};

/**
 * Buying.
 *
 * Every precondition is re-established rather than trusted from the page. A
 * form action is a POST endpoint reachable by anything that can find its name -
 * the absent form is a courtesy to the reader, and `purchase` holds the actual
 * rules, because it is also reachable from the console and a rule written in
 * an action is a rule the other callers do not get.
 */
export const actions: Actions = {
	buy: async ({ params, request }) => {
		const user = requireOnboarded();
		const form = await request.formData();

		const intent = String(form.get('intent') ?? '');
		const quantity = Number(form.get('quantity') ?? 1);
		const replacesOrderId = String(form.get('replacesOrderId') ?? '') || null;

		const product = await productBySlug(params.slug);
		if (!product) return fail(404, { error: 'That product no longer exists.', intent });

		/* The intent is minted by the server when the form renders. An absent one
		   means the form was assembled elsewhere, and continuing would mean
		   writing an order with no idempotency key - so the request is refused
		   rather than given a fresh key here, which would defeat the whole
		   mechanism by making every replay unique.

		   And bounded. The intent is written to two unique btree indexes - the
		   order's and, prefixed, the ledger entry's - and Postgres refuses an index
		   tuple over about 2704 bytes from inside the transaction, which arrives as
		   a 500 rather than as a sentence. A server-minted intent is a uuid, so
		   anything approaching this limit was assembled by hand. */
		if (!intent || intent.length > 100) {
			return fail(400, { error: 'That form was stale. Try again.', intent });
		}

		let shipping: ShippingSnapshot | null = null;
		if (product.kind === 'physical') {
			/* The chosen saved address, re-read from HCA now rather than trusted
			   from the page, and frozen onto this order. */
			const addressId = String(form.get('address_id') ?? '');
			let list;
			try {
				list = await fetchHcaAddresses(user.id, { fresh: true });
			} catch {
				return fail(400, {
					error: 'Could not reach Hack Club to read your address. Try again.',
					intent
				});
			}
			if (list === null) {
				return fail(400, {
					error: 'Reconnect your Hack Club account so we can read your address.',
					intent
				});
			}
			const address = chooseAddress(list, {
				requestedId: addressId,
				defaultId: user.defaultAddressId
			});
			if (!address) {
				return fail(400, {
					error: 'Add a shipping address to your Hack Club account first.',
					intent
				});
			}
			const read = snapshotFromHca(address, user.displayName ?? user.email);
			if (!read.ok) return fail(400, { error: read.error, intent });
			shipping = read.snapshot;
		}

		const outcome = await purchase({
			user,
			productId: product.id,
			quantity,
			options: readOptionFields(form),
			shipping,
			intent,
			replacesOrderId
		});

		/* The intent goes back with the error, so correcting a typo and
		   resubmitting is still the same purchase intent rather than a second one.
		   Without this, a failed submission followed by a successful one would be
		   two orders if the first had in fact committed. */
		if (!outcome.ok) return fail(400, { error: outcome.error, intent });

		/* The invite goes home. Everything else goes to its order.

		   An order page is the right landing for a thing you bought: it is the
		   receipt, it is where the shipping and the state live, and it is what
		   somebody wants when they have bought a hoodie. The invite is not a
		   purchase in that sense - it is the point of the entire program, and the
		   thing to put in front of somebody the second it is theirs is the ticket
		   itself, which lives on the home page. The order is still there, and the
		   ticket on that page is the link through to it.

		   The marker in the query is what tells the home page to DEAL the ticket
		   rather than to have it already lying there; the page takes it back out
		   of the URL once it has read it. */
		if (product.slug === INVITE_SLUG) {
			redirect(303, `/home?bought=${INVITE_SLUG}`);
		}

		redirect(303, `/orders/${outcome.order.id}`);
	}
};
