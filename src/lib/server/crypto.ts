import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	timingSafeEqual
} from 'node:crypto';

import { env } from '$lib/server/env';
import type { JsonValue } from '$lib/json';

/**
 * The three pieces of cryptography this app actually needs: encrypting provider
 * tokens at rest, hashing session identifiers, and generating PKCE pairs.
 *
 * Each one is here rather than inline at its call site so there is exactly one
 * implementation to audit, and so the format decisions below are made once.
 */

/* ── provider tokens ─────────────────────────────────────────────────────── */

/* AES-256-GCM, authenticated, and BOUND TO THE ROW IT BELONGS TO.
 *
 * A stored OAuth token is a bearer credential for someone's identity, so the
 * threat is not only someone reading the database - it is someone who can WRITE
 * to it moving one user's ciphertext into another user's row, or moving a
 * refresh token into the access-token column to see what the upstream service
 * does with the result.
 *
 * The tag alone does not stop that. GCM proves a ciphertext was written by
 * someone holding the key and has not been altered since; it proves nothing
 * about WHERE that ciphertext was supposed to live, and every row here is
 * encrypted under the same key. So a blob copied from one row to another would
 * decrypt perfectly, and the copy would be a valid credential belonging to the
 * wrong person.
 *
 * Additional authenticated data closes it: a caller-supplied string naming the
 * row and column the ciphertext is for. The AAD is not stored - it is rebuilt
 * from the record at decryption time - so opening a blob requires already
 * knowing where it legitimately sits. Move it anywhere else and the tag fails.
 *
 * The version prefix exists so the key can be rotated later without a migration
 * that has to guess at what each row contains. Only this version is accepted,
 * and any later one must be too: a reader that still accepts an older, weaker
 * envelope is a downgrade, because whoever can move a row can also relabel it. */
const TOKEN_VERSION = 'v1';
const IV_BYTES = 12; // 96 bits, the size GCM is specified and optimised for
const TAG_BYTES = 16;

/**
 * What a ciphertext is for: which record, and which column of it.
 *
 * Built from values that are unique, stable and known BEFORE the row is
 * inserted - `provider_accounts` is unique on (user_id, provider), and
 * `orders.idempotency_key` is unique - because a binding derived from a
 * generated primary key cannot be computed until after the insert it is
 * supposed to protect.
 *
 * Stable is the load-bearing word. Anything in here that can be edited later
 * turns a legitimate row into an unreadable one, so these are identifiers and
 * never attributes.
 */
export const bindings = {
	providerToken: (userId: string, provider: string, column: string) =>
		`provider_accounts/${userId}/${provider}/${column}`,
	orderShipping: (userId: string, idempotencyKey: string) =>
		`orders/${userId}/${idempotencyKey}/shipping`,
	/* The submission id is a generated key, so this binding is computed AFTER the
	   insert and written in a second update inside the same transaction - the one
	   place a shipping binding cannot be pre-insert, since a submission has no
	   stable unique column of its own. */
	submissionShipping: (userId: string, submissionId: string) =>
		`submissions/${userId}/${submissionId}/shipping`
} as const;

/* The version travels inside the AAD as well as in front of the payload, so the
   prefix is authenticated rather than merely descriptive. */
function aad(binding: string): Buffer {
	return Buffer.from(`${TOKEN_VERSION}.${binding}`, 'utf8');
}

/**
 * Encrypt a provider token for storage.
 *
 * The output is `v1.<iv>.<ciphertext>.<tag>`, each part base64url - text, so it
 * lives in an ordinary column and survives being logged, copied or diffed
 * without a binary encoding argument in the middle. The binding is deliberately
 * NOT in there: it is derived from the row, and storing it beside the
 * ciphertext would let whoever moved the row move it too.
 *
 * `binding` is required rather than optional. An optional one would be omitted
 * at exactly the call site nobody reviewed.
 */
export function encryptToken(plaintext: string, binding: string): string {
	/* A fresh IV per encryption, from a CSPRNG. Reusing an IV under one key in
     GCM is not a weakness, it is a total break: it leaks the XOR of the two
     plaintexts and, worse, allows the authentication key to be recovered, at
     which point the tag stops meaning anything at all. */
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', env.ENCRYPTION_KEY, iv);
	cipher.setAAD(aad(binding));

	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();

	return [
		TOKEN_VERSION,
		iv.toString('base64url'),
		ciphertext.toString('base64url'),
		tag.toString('base64url')
	].join('.');
}

/**
 * Decrypt a stored provider token.
 *
 * Throws on anything that is not intact: wrong key, truncated column, tampered
 * ciphertext, or a ciphertext that belongs somewhere else. Callers should treat
 * a throw as "this account needs relinking", not as a transient error to retry
 * - retrying will fail identically, and swallowing it would hand upstream a
 * token we cannot vouch for.
 *
 * The binding must be rebuilt from the record being read. Passing the binding
 * the caller WANTS rather than the one the row actually has would defeat the
 * whole mechanism, which is why these are constructed by `bindings` from
 * columns rather than assembled by hand at the call site.
 */
export function decryptToken(payload: string, binding: string): string {
	const parts = payload.split('.');
	if (parts.length !== 4) {
		throw new Error('Stored token is malformed: expected four parts.');
	}

	const [version, ivPart, ciphertextPart, tagPart] = parts;
	if (version !== TOKEN_VERSION) {
		throw new Error(`Stored token has unknown version ${version}.`);
	}

	const iv = Buffer.from(ivPart, 'base64url');
	const tag = Buffer.from(tagPart, 'base64url');
	if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
		throw new Error('Stored token is malformed: bad IV or tag length.');
	}

	const decipher = createDecipheriv('aes-256-gcm', env.ENCRYPTION_KEY, iv);
	decipher.setAAD(aad(binding));
	decipher.setAuthTag(tag);

	return Buffer.concat([
		decipher.update(Buffer.from(ciphertextPart, 'base64url')),
		decipher.final() // throws if the tag does not verify
	]).toString('utf8');
}

/**
 * The same envelope, for a structured record rather than a token.
 *
 * Sharing the format is deliberate rather than lazy. There is one ciphertext
 * shape in this database, one version prefix, and one key rotation to write when
 * the day comes - two envelopes would mean discovering on rotation day that half
 * the rows are in the other one. The `v1.` prefix is what makes that survivable,
 * and it only helps if everything wears it.
 *
 * What goes through here is a shipping snapshot: a name, an address, a phone
 * number, frozen onto an order. Reading it requires `view_pii` and writes an
 * audit row - see lib/shop/shipping.ts. Nothing else in the application
 * encrypts a record.
 */
export function encryptJson(value: JsonValue, binding: string): string {
	return encryptToken(JSON.stringify(value), binding);
}

/**
 * Decrypt and parse.
 *
 * Returns bare JSON, so the caller has to narrow it. A signature that promised a
 * shape would be promising something about ciphertext written by an older
 * version of this code, which is exactly the promise that cannot be kept.
 *
 * A payload that decrypts but does not parse throws, which is right: the key
 * worked, so this is corruption rather than the ordinary "not for us" case.
 */
export function decryptJson(payload: string, binding: string): JsonValue {
	const value: JsonValue = JSON.parse(decryptToken(payload, binding));
	return value;
}

/* ── session identifiers ─────────────────────────────────────────────────── */

/* 32 bytes of CSPRNG output. Guessing one is not a threat model at this size;
   what matters is that it comes from a cryptographic source rather than from
   anything sequential or time-based, since those are enumerable. */
const SESSION_TOKEN_BYTES = 32;

/** A new session token. This exact value goes to the browser and is never
 *  written down anywhere on our side. */
export function newSessionToken(): string {
	return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * The lookup key for a session token.
 *
 * The database stores this, never the token itself, so a leaked backup or a
 * successful read of the sessions table does not hand over a working set of
 * live sessions - the same reason passwords are not stored in the clear.
 *
 * Plain SHA-256 rather than a password hash, deliberately. Argon2 and bcrypt
 * are slow on purpose to make guessing a low-entropy human secret expensive;
 * this input is 32 uniformly random bytes, so there is nothing to guess and the
 * slowness would only be a per-request cost on every authenticated page load.
 */
export function hashSessionToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compare two hex digests without leaking where they diverge.
 *
 * A byte-by-byte comparison returns as soon as it finds a difference, so how
 * long it took is a measurement of how much of the prefix was right - enough,
 * over many attempts, to reconstruct a value one byte at a time. Lengths are
 * checked first because timingSafeEqual throws on a mismatch, and that throw
 * would itself be the leak it is meant to prevent.
 */
export function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8');
	const right = Buffer.from(b, 'utf8');
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/* ── PKCE ────────────────────────────────────────────────────────────────── */

export type PkcePair = {
	/** Kept server-side and presented at the token exchange. */
	verifier: string;
	/** Sent to the authorization endpoint in the open. */
	challenge: string;
};

/**
 * A PKCE verifier and its S256 challenge.
 *
 * PKCE closes the window where a leaked authorization code - out of a redirect
 * that went to the wrong place, a referrer header, a shared device's history -
 * can be exchanged by anyone who did not start the flow. Without it, possession
 * of the code is enough. With it, the exchange also requires the verifier,
 * which never left the server.
 *
 * The platform baseline calls out a flow without PKCE as a gap, and it costs
 * almost nothing to close.
 *
 * 32 random bytes as base64url is 43 characters, inside the 43–128 the spec
 * allows, and base64url is already the spec's unreserved alphabet so the value
 * needs no further escaping.
 */
export function createPkcePair(): PkcePair {
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
	return { verifier, challenge };
}

/** An opaque, unguessable value for the OAuth `state` parameter. */
export function newStateValue(): string {
	return randomBytes(32).toString('base64url');
}
