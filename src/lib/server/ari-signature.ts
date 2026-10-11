import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Ari's two signatures, one each way, with nothing else imported - so the
 * arithmetic that decides whether a request is trusted can be tested on its
 * own (tests/ari.test.ts).
 *
 * - What Phantom sends is signed over the exact body bytes (`X-Ari-Signature`,
 *   with the ingest secret).
 * - What Ari sends is signed over `timestamp.delivery_id.body`, with the
 *   separate outbound secret, and carries `X-Ari-Timestamp` and
 *   `X-Ari-Delivery-Id` beside it.
 */

function hmacHex(secret: string, value: string): string {
	return createHmac('sha256', secret).update(value).digest('hex');
}

/** The `X-Ari-Signature` for a body Phantom sends: an HMAC of the exact bytes. */
export function signIngest(body: string, secret: string): string {
	return hmacHex(secret, body);
}

/** How old a delivery may be and still be trusted. Ari's docs say five
 *  minutes, and its retries are signed afresh (seen: a retry thirty seconds
 *  later carried a new timestamp), so a real one never is. */
export const DELIVERY_MAX_AGE_SECONDS = 5 * 60;

export type DeliveryCheck = 'ok' | 'bad_signature' | 'stale';

function sameHex(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8');
	const right = Buffer.from(b, 'utf8');
	return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Whether a delivery to /api/ari/webhook really came from Ari, now.
 *
 * The signature is over `timestamp.delivery_id.body` - all three, so neither
 * the id nor the time can be swapped onto someone else's body. Compared in
 * constant time. A timestamp more than five minutes either side of ours is
 * `stale`: a replay, or a clock that has drifted, and neither is applied.
 */
export function verifyDelivery(
	input: {
		timestamp: string | null;
		deliveryId: string | null;
		signature: string | null;
		body: string;
	},
	secret: string,
	nowMs = Date.now()
): DeliveryCheck {
	const { timestamp, deliveryId, signature, body } = input;
	if (!timestamp || !deliveryId || !signature || !/^\d{1,12}$/.test(timestamp)) {
		return 'bad_signature';
	}
	const expected = hmacHex(secret, `${timestamp}.${deliveryId}.${body}`);
	if (!sameHex(signature.trim().toLowerCase(), expected)) return 'bad_signature';
	if (Math.abs(nowMs / 1000 - Number(timestamp)) > DELIVERY_MAX_AGE_SECONDS) return 'stale';
	return 'ok';
}
