import { recordAudit } from '$lib/server/audit';
import { can } from '$lib/server/auth/authorize';
import { normalizeHcaAddress, type HcaAddress } from '$lib/server/auth/hca';
import type { SessionUser } from '$lib/server/auth/session';
import { bindings, decryptJson, encryptJson } from '$lib/server/crypto';
import { isJsonObject, readString, type JsonValue } from '$lib/json';
import type { Order } from '$lib/server/db/schema';

/**
 * Where a physical order goes, frozen at the moment it was placed.
 *
 * Two decisions here are the whole file, and both are corrections to something
 * the wiki records as a defect.
 *
 * IT IS A SNAPSHOT, NOT A JOIN. If an order has no order-time address and its
 * admin pages and export join the account's CURRENT address, editing a profile
 * after purchase silently changes where a past order ships and no record
 * survives of where it was supposed to go. Here the address is written
 * into the order, encrypted, and the order is the only place it exists.
 *
 * IT IS CHOSEN PER ORDER, NOT HELD ON THE USER. There is no address on the
 * user row. The buyer picks one of the addresses saved on their Hack Club
 * account at the moment they buy a physical thing (`snapshotFromHca`, below),
 * and that address is frozen onto that order alone. Editing happens on HCA's
 * own portal, never here. That is the wiki's rule that shipping identity is "a
 * historical fulfilment snapshot, not a general user-profile convenience".
 * `readShippingForm` stays for the console's correction form.
 */

export type ShippingSnapshot = {
	recipient: string;
	line1: string;
	line2: string | null;
	city: string;
	region: string | null;
	postcode: string;
	country: string;
	phone: string | null;
	/** When it was captured. The order has its own timestamps, but a snapshot
	 *  that is later corrected (see `correctShipping`) carries its own, and
	 *  reading the wrong one would misdate an address. */
	capturedAt: string;
};

/** Per-field ceilings. An address line is not a place to put a novel, and every
 *  one of these ends up in an encrypted column and, one day, on a label. */
const LIMITS = {
	recipient: 120,
	line1: 160,
	line2: 160,
	city: 100,
	region: 100,
	postcode: 32,
	country: 64,
	phone: 32
} as const satisfies Partial<Record<keyof ShippingSnapshot, number>>;

export type ShippingResult =
	{ ok: true; snapshot: ShippingSnapshot } | { ok: false; error: string };

function field(form: FormData, name: string): string {
	const value = form.get(name);
	return value === null || value instanceof File ? '' : value.trim();
}

/**
 * Read and check an address out of a submitted form.
 *
 * Deliberately loose about FORMAT and strict about PRESENCE. There is no
 * postcode regular expression here and there will not be one: address formats
 * differ by country in ways no validator gets right, and the failure mode of a
 * wrong one is refusing a real person's real address with no way to argue. What
 * is checked is that the required parts are there and are a sane length, which
 * is the part a human filling this in can act on.
 *
 * `capturedAt` is set here rather than by the caller so it cannot be forgotten
 * or supplied.
 */
export function readShippingForm(form: FormData, now = new Date()): ShippingResult {
	const values = {
		recipient: field(form, 'recipient'),
		line1: field(form, 'line1'),
		line2: field(form, 'line2') || null,
		city: field(form, 'city'),
		region: field(form, 'region') || null,
		postcode: field(form, 'postcode'),
		country: field(form, 'country'),
		phone: field(form, 'phone') || null
	};

	const required: (keyof typeof values)[] = ['recipient', 'line1', 'city', 'postcode', 'country'];
	for (const name of required) {
		if (!values[name]) return { ok: false, error: `${LABELS[name]} is required.` };
	}

	/* SAFETY: `Object.keys` loses the key type and nothing else. LIMITS is
     declared `satisfies Partial<Record<keyof ShippingSnapshot, number>>` and
     LABELS `satisfies Record<keyof typeof LIMITS, string>`, so every key here
     indexes all three objects or the declarations stop compiling. */
	for (const name of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
		const value = values[name];
		if (value && value.length > LIMITS[name]) {
			return {
				ok: false,
				error: `${LABELS[name]} must be ${LIMITS[name]} characters or fewer.`
			};
		}
	}

	return {
		ok: true,
		snapshot: { ...values, capturedAt: now.toISOString() }
	};
}

/**
 * A snapshot from an address saved on the buyer's Hack Club account.
 *
 * Same presence and length rules as the typed form, so an HCA record missing
 * a part the label needs is refused with a sentence pointing at the portal
 * rather than frozen incomplete. The recipient is the address's own name
 * when it carries one, else the account's.
 */
export function snapshotFromHca(
	address: HcaAddress,
	fallbackRecipient: string,
	now = new Date()
): ShippingResult {
	const raw = address.raw;
	const normalised = normalizeHcaAddress(raw);
	const values = {
		recipient: (normalised.name ?? fallbackRecipient).trim(),
		line1: normalised.line1 ?? '',
		line2: normalised.line2,
		city: normalised.city ?? '',
		region: normalised.region,
		postcode: normalised.postal ?? '',
		country: normalised.country ?? '',
		phone: normalised.phone
	};

	const required: (keyof typeof values)[] = ['recipient', 'line1', 'city', 'postcode', 'country'];
	for (const key of required) {
		if (!values[key]) {
			return {
				ok: false,
				error: `That saved address has no ${LABELS[key]}. Fix it at Hack Club and try again.`
			};
		}
	}
	for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
		const value = values[key];
		if (value && value.length > LIMITS[key]) {
			return { ok: false, error: `${LABELS[key]} must be ${LIMITS[key]} characters or fewer.` };
		}
	}

	return { ok: true, snapshot: { ...values, capturedAt: now.toISOString() } };
}

/** The words on the form, and in the errors above. One place, so a field
 *  renamed on screen is renamed in the message that refuses it. */
export const LABELS = {
	recipient: 'recipient name',
	line1: 'address',
	line2: 'address line 2',
	city: 'city',
	region: 'state or region',
	postcode: 'postcode',
	country: 'country',
	phone: 'phone'
} as const satisfies Record<keyof typeof LIMITS, string>;

/**
 * Encrypt for storage. The column holds this and nothing else.
 *
 * Bound to the buyer and to the purchase intent rather than to the order's id,
 * because the id is generated by the insert this value is a column of - there
 * is nothing to bind to until after the row exists. `orders.idempotency_key` is
 * unique, is minted before the transaction opens, and is the thing that already
 * identifies "this purchase and no other", so an address cannot be lifted onto
 * a different order or a different person and still open.
 */
export function sealShipping(
	snapshot: ShippingSnapshot,
	owner: { userId: string; idempotencyKey: string }
): string {
	return encryptJson(snapshot, bindings.orderShipping(owner.userId, owner.idempotencyKey));
}

/* ── reading it back ─────────────────────────────────────────────────────── */

export type RevealResult = { ok: true; snapshot: ShippingSnapshot } | { ok: false; error: string };

/**
 * Reveal an order's address to an operator, and record that it happened.
 *
 * Modelled directly on Sidekick, which the wiki singles out as the strongest
 * boundary in the source set: viewing an order and viewing its address are
 * separate capabilities, and an actual reveal writes an audit event naming the
 * operator, the order and the time. The order list shows a name and never the
 * address; getting the address is a deliberate act that leaves a trace.
 *
 * The audit write is awaited before the plaintext is returned, and that ordering
 * is deliberate. If the audit row cannot be written, the address is not
 * revealed - an unlogged reveal is exactly the thing this function exists to
 * make impossible, and returning the data first and logging after would make the
 * log best-effort.
 */
export async function revealShipping(order: Order, actor: SessionUser): Promise<RevealResult> {
	if (!can(actor, 'view_pii')) {
		return { ok: false, error: 'You do not have permission to see addresses.' };
	}
	if (!order.shippingEncrypted) {
		return { ok: false, error: 'This order has no address; it does not ship.' };
	}

	await recordAudit({
		action: 'order.address_revealed',
		actorId: actor.id,
		subjectId: order.userId,
		metadata: { orderId: order.id, productName: order.productName }
	});

	let parsed: JsonValue;
	try {
		parsed = decryptJson(
			order.shippingEncrypted,
			bindings.orderShipping(order.userId, order.idempotencyKey)
		);
	} catch {
		/* Undecryptable has three causes now and the message names all of them,
       because they want different responses. The key may have been rotated
       without a re-encryption pass; the column may be corrupt; or the
       ciphertext may be intact but belong to a DIFFERENT ORDER, which is what
       the v2 binding is there to catch and is the only one of the three that
       means someone has been writing to this database directly.

       None is retryable, and none should be reported as "no address" - that
       would send an operator looking for a missing form submission. */
		return {
			ok: false,
			error:
				'The stored address could not be decrypted. Either ENCRYPTION_KEY was ' +
				'rotated without re-encrypting existing orders, or this ciphertext ' +
				'does not belong to this order - which would mean the row was written ' +
				'outside the application.'
		};
	}

	const snapshot = narrow(parsed);
	if (!snapshot) {
		return { ok: false, error: 'The stored address is not in a shape this version understands.' };
	}
	return { ok: true, snapshot };
}

/** Narrow decrypted JSON to a snapshot, or null.
 *
 *  It exists because `decryptJson` returns `unknown` on purpose: the ciphertext
 *  may have been written by an older version of this file, and a cast would be
 *  a promise about data this code never saw written. */
function narrow(value: JsonValue): ShippingSnapshot | null {
	if (!isJsonObject(value)) return null;
	const text = (key: string): string | null => readString(value, key);

	const recipient = text('recipient');
	const line1 = text('line1');
	const city = text('city');
	const postcode = text('postcode');
	const country = text('country');
	if (!recipient || !line1 || !city || !postcode || !country) return null;

	return {
		recipient,
		line1,
		line2: text('line2'),
		city,
		region: text('region'),
		postcode,
		country,
		phone: text('phone'),
		capturedAt: text('capturedAt') ?? ''
	};
}

/** Flatten a snapshot to lines, for display. Empty parts are dropped rather
 *  than rendered as blanks. */
export function shippingLines(snapshot: ShippingSnapshot): string[] {
	return [
		snapshot.recipient,
		snapshot.line1,
		snapshot.line2,
		[snapshot.city, snapshot.region].filter(Boolean).join(', '),
		snapshot.postcode,
		snapshot.country,
		snapshot.phone
	].filter((line): line is string => !!line && line.length > 0);
}
