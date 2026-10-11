import { db, type Db } from '$lib/server/db/client';
import { auditEvents } from '$lib/server/db/schema';
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue
} from '$lib/json';

/**
 * The audit writer.
 *
 * One function, because an audit trail that is written three different ways is
 * one that is redacted in two of them. Everything that creates a session, links
 * an account, changes a role or refuses an identity goes through here.
 *
 * The handle argument is the important part of the signature. `auditEvents` is
 * described in the schema as being written on the same connection as the change
 * it records, and that only holds if the caller can hand its transaction in -
 * otherwise the audit row commits independently and can survive a rollback,
 * which is how you end up with a log of a link that never happened.
 */

/* Drizzle does not export the transaction type in a form worth importing by
   name, and it is parameterised over the schema, so deriving it from the handle
   we already have keeps the two in step automatically. */
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Either the pool or an open transaction. Pass the transaction whenever one is
 *  open; the default is only for events that stand alone. */
export type DbHandle = Db | Transaction;

export type AuditEntry = {
	/** A dotted verb, matching the schema's examples: `session.created`,
	 *  `provider.linked`, `identity.observed`. */
	action: string;
	actorId?: string | null;
	subjectId?: string | null;
	metadata?: JsonObject;
};

/* ── redaction ───────────────────────────────────────────────────────────── */

/**
 * Key names whose values must never reach the audit table.
 *
 * This exists because the audit metadata column is deliberately loose - the
 * schema says so, and that looseness is what makes it get written at all - and
 * a loose column plus a call site that spreads a token response into it is how
 * bearer credentials end up in a table that support staff read casually. The
 * check is on key segments rather than substrings so that `error_code` and
 * `status_code` survive while `code_verifier` and `access_token` do not.
 *
 * A denylist is a weaker guarantee than an allowlist, and the real defence is
 * that no call site in this codebase passes a token. This is the backstop for
 * the call site someone adds later.
 */
const REDACTED_SEGMENTS = new Set([
	'token',
	'tokens',
	'secret',
	'secrets',
	'password',
	'passwords',
	'verifier',
	'challenge',
	'authorization',
	'cookie',
	'cookies',
	'credential',
	'credentials',
	'bearer',
	'jwt',
	'assertion'
]);

/** Whole keys that are dangerous even though no segment of them is. */
const REDACTED_KEYS = new Set(['code', 'id_token', 'state']);

const REDACTED = '[redacted]';

function shouldRedact(key: string): boolean {
	const lower = key.toLowerCase();
	if (REDACTED_KEYS.has(lower)) return true;
	return lower.split(/[^a-z0-9]+/).some((segment) => REDACTED_SEGMENTS.has(segment));
}

/** What is left of a value that nested deeper than the cap. Frozen because one
 *  instance is handed to every caller that hits the cap, and a shared object a
 *  caller can write to is a bug waiting for the first caller that tries. */
const TRUNCATED: JsonObject = Object.freeze({ truncated: true });

/**
 * One value, scrubbed - whatever shape it is.
 *
 * Arrays used to fall past the object branch and be stored verbatim, so
 * `{ grants: [{ access_token: "…" }] }` reached the column with neither the key
 * redaction nor the length truncation applied, and was rendered in full on the
 * audit page. No call site passes one today; this function exists precisely for
 * the call site somebody adds later, and a backstop with a hole in it is worse
 * than none, because it is trusted.
 */
function scrubValue(value: JsonValue, depth: number): JsonValue {
	if (isJsonArray(value)) {
		if (depth > 4) return TRUNCATED;
		return value.map((entry) => scrubValue(entry, depth + 1));
	}
	if (isJsonObject(value)) {
		return scrubMetadata(value, depth + 1);
	}
	/* Long strings are the shape a token takes even under an innocent key.
     Truncating is enough to keep one unusable while leaving it recognisable. */
	if (isJsonString(value) && value.length > 512) {
		return `${value.slice(0, 512)}…`;
	}
	return value;
}

/**
 * Strip secret-shaped values out of metadata, recursively.
 *
 * Depth is capped rather than trusted: metadata is a plain object handed in by a
 * caller, and a cyclic or pathologically nested one would otherwise turn an
 * audit write into a stack overflow inside a transaction.
 */
export function scrubMetadata(metadata: JsonObject, depth = 0): JsonObject {
	if (depth > 4) return TRUNCATED;

	return Object.fromEntries(
		Object.entries(metadata).map(([key, value]) => [
			key,
			shouldRedact(key) ? REDACTED : scrubValue(value, depth)
		])
	);
}

/* ── writing ─────────────────────────────────────────────────────────────── */

/**
 * Append one event.
 *
 * Errors propagate on purpose. Inside a transaction that is the whole point -
 * the change and its record commit together or not at all. Outside one, a
 * failure here means the database is unreachable, and the caller's own writes
 * were not going to succeed either; swallowing it would only move the failure
 * somewhere less legible.
 */
export async function recordAudit(entry: AuditEntry, handle: DbHandle = db): Promise<void> {
	await recordAudits([entry], handle);
}

/**
 * Several rows, in one statement.
 *
 * One INSERT rather than one per entry, because a round trip to the database is
 * the expensive part and an event that produces three audit rows was paying for
 * three of them - inside a transaction, in front of somebody waiting. Sign-in is
 * the case that made it worth having: it writes the account, the identity it
 * observed and the session it opened, and against a database a couple of hundred
 * milliseconds away those three statements are most of a second on their own.
 *
 * The scrubbing is per entry and unchanged; this only changes how many times the
 * result is sent. An empty list writes nothing rather than sending an INSERT with
 * no rows, which Postgres would refuse.
 */
export async function recordAudits(entries: AuditEntry[], handle: DbHandle = db): Promise<void> {
	if (entries.length === 0) return;

	await handle.insert(auditEvents).values(
		entries.map((entry) => ({
			action: entry.action,
			actorId: entry.actorId ?? null,
			subjectId: entry.subjectId ?? null,
			metadata: entry.metadata ? scrubMetadata(entry.metadata) : null
		}))
	);
}
