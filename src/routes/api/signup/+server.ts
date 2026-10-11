import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { emailAlreadySignedUp, addEmailSignup } from '$lib/server/airtable';
import { recordEvent } from '$lib/server/analytics';

// Mirrors the shape the browser's own type="email" input already validates;
// this endpoint just can't rely on that validation having actually run.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 max mailbox length

// Coarse per-IP throttle: enough to stop a naive flood script from filling
// the table or burning through Airtable's ~5 req/sec per-base limit. This is
// per-process, in-memory state - it resets on restart and isn't shared across
// instances, so it's a floor, not a substitute for edge/WAF-level protection
// if this ever needs to withstand a distributed flood.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
	const now = Date.now();
	// Bounds worst-case memory under a flood from many distinct IPs, at the
	// cost of an occasional early reset for everyone - acceptable for a
	// best-effort throttle.
	if (hits.size > 10_000) hits.clear();

	const entry = hits.get(ip);
	if (!entry || now > entry.resetAt) {
		hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
		return false;
	}
	entry.count += 1;
	return entry.count > MAX_PER_WINDOW;
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	if (isRateLimited(getClientAddress())) {
		return json({ error: 'too many requests' }, { status: 429 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid request' }, { status: 400 });
	}

	const email = (body as { email?: unknown })?.email;
	if (typeof email !== 'string') {
		return json({ error: 'invalid email' }, { status: 400 });
	}

	const trimmed = email.trim();
	if (trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(trimmed)) {
		return json({ error: 'invalid email' }, { status: 400 });
	}

	try {
		const alreadySignedUp = await emailAlreadySignedUp(trimmed);
		if (!alreadySignedUp) {
			await addEmailSignup(trimmed);
		}
		recordEvent('waitlist.joined', { already: alreadySignedUp });
		// Deliberately not returning `alreadySignedUp`: the client shows the same
		// "on the list" message either way, and echoing it back would let anyone
		// probe whether an arbitrary address is already in the table.
		return json({ ok: true });
	} catch (err) {
		console.error('signup failed', err);
		return json({ error: 'signup failed' }, { status: 502 });
	}
};
