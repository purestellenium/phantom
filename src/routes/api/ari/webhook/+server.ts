import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { verifyDelivery } from '$lib/server/ari-signature';
import { ariWebhookSecret } from '$lib/server/env';
import { applyDelivery } from '$lib/server/projects/decisions';
import { isJsonObject, parseJson, type JsonObject } from '$lib/json';

/**
 * Where Ari sends every review decision: `POST /api/ari/webhook`. Set as the
 * program's destination in Ari's Settings -> Webhooks.
 *
 * Ari counts a delivery made on any 2xx within ten seconds, and treats a 4xx
 * (other than 408 and 429) as a refusal it never retries. So everything that
 * could be a problem on THIS side - the secret not set, a signature that does
 * not match after a secret was rolled, the database out of reach - answers
 * 503, and Ari keeps the delivery and tries again for hours. Only a delivery
 * that was verified and recorded gets its 2xx, including one that did not fit
 * and was recorded as `ignored`: retrying that would only fail the same way.
 *
 * Redirects count as failures too, which is why this lives under /api/ari/,
 * outside the launch gate and the signed-in shell (see lib/server/launch.ts).
 */

export const prerender = false;

const HEADERS = { 'cache-control': 'no-store' };

export const POST: RequestHandler = async ({ request }) => {
	const secret = ariWebhookSecret();
	if (!secret) {
		console.error('[ari] webhook refused: ARI_WEBHOOK_SECRET is not set');
		return json({ error: 'unavailable' }, { status: 503, headers: HEADERS });
	}

	/* The raw body, exactly as sent: the signature is over these bytes. */
	const body = await request.text();
	const deliveryId = request.headers.get('x-ari-delivery-id');
	const check = verifyDelivery(
		{
			timestamp: request.headers.get('x-ari-timestamp'),
			deliveryId,
			signature: request.headers.get('x-ari-signature'),
			body
		},
		secret
	);
	if (check !== 'ok' || !deliveryId) {
		console.error(`[ari] webhook refused a delivery: ${check}`);
		return json({ error: 'unverified' }, { status: 503, headers: HEADERS });
	}

	const parsed = parseJson(body);
	const payload: JsonObject =
		parsed !== undefined && isJsonObject(parsed) ? parsed : { unreadable: body.slice(0, 10_000) };

	try {
		const result = await applyDelivery(deliveryId, payload);
		if (result !== 'duplicate' && result.outcome !== 'applied') {
			console.warn(`[ari] delivery ${deliveryId} ${result.outcome}: ${result.detail ?? ''}`);
		}
		return json({ ok: true }, { headers: HEADERS });
	} catch (error) {
		console.error('[ari] delivery could not be applied', deliveryId, error);
		return json({ error: 'unavailable' }, { status: 503, headers: HEADERS });
	}
};
