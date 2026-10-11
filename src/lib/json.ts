/**
 * Decoding for values that arrive from outside this process.
 *
 * Provider responses, webhook bodies and stored payloads are JSON and nothing
 * more: `JSON.parse` establishes the shape of the syntax and says nothing about
 * the contract. Everything here turns that into a domain value or a null, in
 * one place, so that the modules doing the actual work receive types rather
 * than a dictionary they have to interrogate at every use.
 *
 * The guards are the only place a `typeof` belongs. A representation check
 * scattered through business logic narrows a value without ever establishing
 * what it means; the same check behind a named predicate is a decoder.
 */

/** A value as `JSON.parse` produced it. Known to be JSON, known to be nothing
 *  else - no `unknown`, so a caller cannot reach past the decoders below. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

/** The envelope every response this codebase reads arrives in. */
export type JsonObject = { readonly [key: string]: JsonValue };

export function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
	return Array.isArray(value);
}

export function isJsonString(value: JsonValue): value is string {
	return typeof value === 'string';
}

/** Finite on purpose. `NaN` and the infinities survive a `typeof` check and
 *  then land in a duration, a price or a column. */
export function isJsonNumber(value: JsonValue): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

export function isJsonBoolean(value: JsonValue): value is boolean {
	return typeof value === 'boolean';
}

/**
 * Parse text that claims to be JSON.
 *
 * `undefined` for "that was not JSON", rather than a throw, because every caller
 * here already has a better sentence to say about the endpoint than
 * `SyntaxError` does about character 4.
 *
 * `undefined` and not `null`, because `null` is a JSON value a body or a form
 * field is allowed to hold, and a parser that reports failure with one of the
 * values it can legitimately return makes "the operator typed null" and "the
 * operator typed nonsense" the same answer.
 */
export function parseJson(text: string): JsonValue | undefined {
	try {
		const value: JsonValue = JSON.parse(text);
		return value;
	} catch {
		return undefined;
	}
}

/**
 * Read a field only if it is genuinely a non-empty string.
 *
 * Trimmed, and empty means absent: a provider that sends `""` for a name has
 * not sent a name. `String(undefined)` produces the string "undefined", and
 * that has been stored in a database more than once.
 */
export function readString(source: JsonObject, key: string): string | null {
	const value = source[key];
	if (value === undefined || !isJsonString(value)) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function readNumber(source: JsonObject, key: string): number | null {
	const value = source[key];
	return value !== undefined && isJsonNumber(value) ? value : null;
}

export function readBoolean(source: JsonObject, key: string): boolean | null {
	const value = source[key];
	return value !== undefined && isJsonBoolean(value) ? value : null;
}

export function readObject(source: JsonObject, key: string): JsonObject | null {
	const value = source[key];
	return value !== undefined && isJsonObject(value) ? value : null;
}

export function readArray(source: JsonObject, key: string): readonly JsonValue[] | null {
	const value = source[key];
	return value !== undefined && isJsonArray(value) ? value : null;
}

/** The members that are strings, and only those. A list with one number in it
 *  is a list of strings with a hole, not a reason to reject the response. */
export function readStringArray(source: JsonObject, key: string): readonly string[] | null {
	const value = readArray(source, key);
	return value === null ? null : value.filter(isJsonString);
}

/**
 * An identifier that arrives as either a string or a number.
 *
 * Coerced to a string here and nowhere else, so a column holds one
 * representation - a mix of `42` and `"42"` in a text column is a lookup that
 * silently misses.
 */
export function readId(source: JsonObject, key: string): string | null {
	const value = source[key];
	if (value === undefined) return null;
	if (isJsonString(value)) {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	return isJsonNumber(value) ? String(value) : null;
}
