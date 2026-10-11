/**
 * Deciding what the "Loops - Sign Ups" table needs, given what it has.
 *
 * Pure, and apart from the sync that acts on it (lib/server/loops-sync.ts), so
 * the part that decides which rows to touch can be tested without a database or
 * an Airtable base - the same split as ari-signature.ts.
 *
 * Rows are matched on email, compared without case or surrounding space, because
 * that is how Loops itself tells contacts apart. Only the fields that differ go
 * into an update, and a row whose fields all agree is not sent at all: the point
 * of running every five minutes is that nearly every run writes nothing.
 *
 * Nothing is ever deleted. The landing page's waiting list writes to the same
 * table, so a row with no Phantom account behind it is somebody's sign-up, not
 * a mistake to clean up.
 */

export const SIGNED_UP_AT = 'Loops - phantomSignUpAt';
export const SHIPPED = 'Loops - phantomHasShippedAProject';

/** One person as Phantom knows them. */
export type Person = { email: string; signedUpAt: Date; shipped: boolean };

/** One row as Airtable returned it. */
export type Row = { id: string; createdTime: string; fields: Record<string, unknown> };

/**
 * How the sign-up field may be written, from its type in the base.
 *
 * `null` is a field the API cannot write - a Created time field, which is what
 * the table started with - and then the sync leaves it to Airtable.
 */
export type SignUpFormat = 'dateTime' | 'date' | null;

export type Plan = {
	creates: Record<string, unknown>[];
	updates: { id: string; fields: Record<string, unknown> }[];
	unchanged: number;
	/** Rows sharing an email with an earlier one. The oldest is kept up to date;
	 *  the rest are reported, never removed. */
	duplicateRows: number;
};

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * One entry per email.
 *
 * Accounts are keyed on the HCA subject, not the email, so two of them can share
 * one. They are one contact to Loops: the earliest sign-up and whether either
 * has shipped.
 */
export function mergePeople(people: Person[]): Map<string, Person> {
	const byEmail = new Map<string, Person>();
	for (const person of people) {
		const key = normalizeEmail(person.email);
		if (!key) continue;
		const seen = byEmail.get(key);
		if (!seen) {
			byEmail.set(key, { ...person, email: person.email.trim() });
			continue;
		}
		if (person.signedUpAt < seen.signedUpAt) seen.signedUpAt = person.signedUpAt;
		seen.shipped ||= person.shipped;
	}
	return byEmail;
}

/** The sign-up time as the field stores it: to the second, or the UTC day. */
function signUpValue(at: Date, format: 'dateTime' | 'date'): string {
	const iso = new Date(Math.floor(at.getTime() / 1000) * 1000).toISOString();
	return format === 'date' ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
}

function sameSignUp(stored: unknown, wanted: string, format: 'dateTime' | 'date'): boolean {
	if (typeof stored !== 'string') return false;
	if (format === 'date') return stored.slice(0, 10) === wanted;
	const a = Date.parse(stored);
	return Number.isFinite(a) && Math.floor(a / 1000) === Math.floor(Date.parse(wanted) / 1000);
}

export function planLoopsSync(
	people: Map<string, Person>,
	rows: Row[],
	emailField: string,
	signUpFormat: SignUpFormat
): Plan {
	/* Oldest row first, so which of two duplicates is kept does not depend on the
	   order Airtable happened to list them in. */
	const ordered = [...rows].sort((a, b) => a.createdTime.localeCompare(b.createdTime));
	const byEmail = new Map<string, Row>();
	let duplicateRows = 0;
	for (const row of ordered) {
		const email = row.fields[emailField];
		if (typeof email !== 'string' || !normalizeEmail(email)) continue;
		const key = normalizeEmail(email);
		if (byEmail.has(key)) duplicateRows += 1;
		else byEmail.set(key, row);
	}

	const plan: Plan = { creates: [], updates: [], unchanged: 0, duplicateRows };

	for (const [key, person] of people) {
		const wanted: Record<string, unknown> = { [SHIPPED]: person.shipped };
		if (signUpFormat) wanted[SIGNED_UP_AT] = signUpValue(person.signedUpAt, signUpFormat);

		const row = byEmail.get(key);
		if (!row) {
			plan.creates.push({ [emailField]: person.email, ...wanted });
			continue;
		}

		const changed: Record<string, unknown> = {};
		/* Airtable leaves an unticked checkbox out of the record entirely. */
		if ((row.fields[SHIPPED] === true) !== person.shipped) changed[SHIPPED] = person.shipped;
		if (
			signUpFormat &&
			!sameSignUp(row.fields[SIGNED_UP_AT], wanted[SIGNED_UP_AT] as string, signUpFormat)
		) {
			changed[SIGNED_UP_AT] = wanted[SIGNED_UP_AT];
		}

		if (Object.keys(changed).length > 0) plan.updates.push({ id: row.id, fields: changed });
		else plan.unchanged += 1;
	}

	return plan;
}
