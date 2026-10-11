import { env } from '$env/dynamic/private';

import { SIGNED_UP_AT, type Row, type SignUpFormat } from '$lib/server/loops-plan';

const API_URL = 'https://api.airtable.com/v0';
const AIRTABLE_TIMEOUT_MS = 10_000;

/* Airtable allows five requests a second per base, and answers a sixth with a
   429 and a thirty-second penalty. Every call here goes through `request`, which
   spaces them out, so a sync of a few thousand rows stays under the limit
   rather than tripping it and waiting. */
const MIN_GAP_MS = 220;
const RATE_LIMIT_WAIT_MS = 30_000;
/** The most records one create or update call accepts. */
const BATCH = 10;

function config() {
	const apiKey = env.AIRTABLE_API_KEY;
	const baseId = env.AIRTABLE_BASE_ID;
	const table = env.AIRTABLE_TABLE_NAME;
	const emailField = env.AIRTABLE_EMAIL_FIELD || 'Email';

	if (!apiKey || !baseId || !table) {
		throw new Error(
			'Airtable is not configured: set AIRTABLE_API_KEY, AIRTABLE_BASE_ID and AIRTABLE_TABLE_NAME'
		);
	}

	return { apiKey, baseId, table, emailField };
}

export function emailField(): string {
	return config().emailField;
}

let lastRequestAt = 0;

async function request(path: string, init: RequestInit = {}, attempt = 0): Promise<unknown> {
	const { apiKey } = config();

	const wait = lastRequestAt + MIN_GAP_MS - Date.now();
	if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
	lastRequestAt = Date.now();

	const res = await fetch(`${API_URL}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
			...init.headers
		},
		signal: AbortSignal.timeout(AIRTABLE_TIMEOUT_MS)
	});

	if (res.status === 429 && attempt < 2) {
		await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
		return request(path, init, attempt + 1);
	}
	if (!res.ok) {
		throw new Error(`Airtable ${init.method ?? 'GET'} failed: ${res.status} ${await res.text()}`);
	}
	return res.json();
}

function tablePath() {
	const { baseId, table } = config();
	return `/${baseId}/${encodeURIComponent(table)}`;
}

// Formulas are strings the Airtable API parses on its end, so a stray quote
// in the email would otherwise close the string early and mangle the query.
function escapeForFormula(value: string) {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function emailAlreadySignedUp(email: string): Promise<boolean> {
	const { emailField } = config();

	const params = new URLSearchParams({
		filterByFormula: `LOWER({${emailField}})=LOWER("${escapeForFormula(email)}")`,
		maxRecords: '1'
	});
	const data = (await request(`${tablePath()}?${params}`)) as { records: unknown[] };
	return data.records.length > 0;
}

export async function addEmailSignup(email: string): Promise<void> {
	const { emailField } = config();

	const fields: Record<string, unknown> = { [emailField]: email };
	/* Once the sign-up field is a plain date rather than a Created time, nothing
	   fills it in by itself any more - so a waiting-list row says when it joined
	   only if this writes it. Best effort: a schema read that fails must not
	   cost somebody their place on the list. */
	const format = await signUpFormat().catch(() => null);
	if (format === 'dateTime') fields[SIGNED_UP_AT] = new Date().toISOString();
	if (format === 'date') fields[SIGNED_UP_AT] = new Date().toISOString().slice(0, 10);

	await request(tablePath(), {
		method: 'POST',
		body: JSON.stringify({ records: [{ fields }] })
	});
}

/* ── the Loops sync ──────────────────────────────────────────────────────── */

let formatCache: { format: SignUpFormat; at: number } | null = null;
const FORMAT_TTL_MS = 5 * 60_000;

/**
 * How the sign-up field can be written, read from the base's own schema.
 *
 * Asked rather than assumed because the field started as a Created time, which
 * the API refuses to write, and becomes writable only when somebody changes its
 * type in Airtable. Reading it means the sync starts writing real dates the run
 * after that change, with no deploy in between.
 */
export async function signUpFormat(): Promise<SignUpFormat> {
	if (formatCache && Date.now() - formatCache.at < FORMAT_TTL_MS) return formatCache.format;

	const { baseId, table } = config();
	const data = (await request(`/meta/bases/${baseId}/tables`)) as {
		tables: { id: string; name: string; fields: { name: string; type: string }[] }[];
	};
	const found = data.tables.find((t) => t.id === table || t.name === table);
	if (!found) throw new Error(`Airtable table ${table} is not in base ${baseId}`);

	const type = found.fields.find((f) => f.name === SIGNED_UP_AT)?.type;
	const format: SignUpFormat = type === 'dateTime' || type === 'date' ? type : null;
	formatCache = { format, at: Date.now() };
	return format;
}

/** Every row in the table, a hundred at a time. */
export async function listRows(): Promise<Row[]> {
	const rows: Row[] = [];
	let offset: string | undefined;
	do {
		const params = new URLSearchParams({ pageSize: '100' });
		if (offset) params.set('offset', offset);
		const page = (await request(`${tablePath()}?${params}`)) as {
			records: Row[];
			offset?: string;
		};
		rows.push(...page.records);
		offset = page.offset;
	} while (offset);
	return rows;
}

export async function createRows(rows: Record<string, unknown>[]): Promise<void> {
	for (let i = 0; i < rows.length; i += BATCH) {
		await request(tablePath(), {
			method: 'POST',
			body: JSON.stringify({ records: rows.slice(i, i + BATCH).map((fields) => ({ fields })) })
		});
	}
}

/** PATCH, not PUT: only the fields named are touched, so a column somebody
 *  added in Airtable by hand is left as they set it. */
export async function updateRows(rows: { id: string; fields: Record<string, unknown> }[]) {
	for (let i = 0; i < rows.length; i += BATCH) {
		await request(tablePath(), {
			method: 'PATCH',
			body: JSON.stringify({ records: rows.slice(i, i + BATCH) })
		});
	}
}
