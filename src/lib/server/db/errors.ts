import postgres from 'postgres';

/**
 * Driver errors this application branches on.
 *
 * A failed INSERT is not always a fault. A unique index doing its job is how
 * two of these tables express "somebody already has that", and the difference
 * between that and a genuine 500 is a SQLSTATE and a constraint name. Reading
 * them through the driver's own error class keeps the field names in one place
 * and out of the three modules that used to reach into a cast object literal
 * for `code`.
 */

/** unique_violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * The driver's error inside whatever threw it.
 *
 * Drizzle does not rethrow what the driver raised: a failed query arrives as a
 * `DrizzleQueryError` carrying the real one on `cause`, and that wrapper has no
 * `code` of its own. Reading `code` off the caught value therefore answers
 * "no" for every unique violation there has ever been, which is a refusal
 * message silently becoming a 500 - so the chain is walked rather than the
 * top of it inspected.
 *
 * Bounded because `cause` is a public field anything may set, including to
 * something that points back at its own error.
 */
function driverError(cause: unknown): postgres.PostgresError | null {
	let current = cause;
	for (let depth = 0; depth < 4; depth++) {
		if (current instanceof postgres.PostgresError) return current;
		if (!(current instanceof Error)) return null;
		current = current.cause;
	}
	return null;
}

export function isUniqueViolation(cause: unknown): boolean {
	return driverError(cause)?.code === UNIQUE_VIOLATION;
}

/**
 * The index or constraint a unique violation came from, when the driver names
 * it.
 *
 * Null is a real answer: which field is populated depends on the driver
 * version, and a caller that needs to tell two constraints apart has to decide
 * what to do when it cannot. Guessing here would make that decision silently.
 */
export function violatedConstraint(cause: unknown): string | null {
	return driverError(cause)?.constraint_name ?? null;
}
