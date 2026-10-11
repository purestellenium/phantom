import { env as runtime } from '$env/dynamic/private';

import { takeSection, type AriJustificationFields } from '$lib/justification';
import type { EffectOutcome } from '$lib/server/outbox';

/**
 * Posting an approved submission to the YSWS records base, and reporting honestly
 * whether it landed - the same shape and discipline as effects/slack.ts.
 *
 * It writes to a SEPARATE table from the waiting list (that one is
 * lib/server/airtable.ts).
 *
 * The field names below are OneKey's, verbatim, because they are the ones the
 * YSWS base actually has. The set this file started with was invented - it sent
 * `Project`, `Name`, `Approved Hours`, `Review Justification` and `Phone`, none
 * of which exist there - so every record was refused with a 422 and the effect
 * failed terminally. Two of those absences are the interesting ones: there is no
 * project-name column at all (the record is identified by its Code URL), and no
 * phone column, so both are dropped rather than renamed.
 *
 * Treat them as a contract with the base, not a suggestion. Anything not on the
 * list below is an UNKNOWN_FIELD_NAME and takes the whole record down with it -
 * Airtable validates the envelope, not the field.
 *
 * Unconfigured is `deferred`, not `skipped`, for the reason Slack is - an
 * approval recorded the hour before the base was wired up must still reach it
 * once the variable arrives.
 */

const API_URL = 'https://api.airtable.com/v0';
const AIRTABLE_TIMEOUT_MS = 10_000;

export type SubmissionRecord = {
	description: string | null;
	repoUrl: string | null;
	demoUrl: string | null;
	screenshotUrl: string | null;
	/** One string, split into First/Last on the way out - the base has two
	 *  columns and HCA gives us one name. */
	authorName: string | null;
	authorEmail: string | null;
	/** `YYYY-MM-DD`, from the HCA `birthdate` claim. */
	authorBirthday: string | null;
	approvedSeconds: number;
	justification: string | null;
	/** For an approval Ari decided: the base's own justification fields, which
	 *  its formula assembles for Unified. Null for an older, hand-written
	 *  justification, which goes to the override column as before. */
	justificationFields: AriJustificationFields | null;
	address: {
		line1: string | null;
		line2: string | null;
		city: string | null;
		region: string | null;
		postal: string | null;
		country: string | null;
	} | null;
};

/**
 * One name into the base's two columns.
 *
 * Last word is the surname, everything before it the rest - which is wrong for
 * plenty of names and is what OneKey does, so the two programs at least get it
 * wrong the same way and a record can be matched across them. A single word is
 * a first name with no surname rather than a surname with no first name.
 */
function splitName(fullName: string | null): { first: string | null; last: string | null } {
	if (!fullName?.trim()) return { first: null, last: null };
	const parts = fullName.trim().split(/\s+/);
	if (parts.length === 1) return { first: parts[0], last: null };
	return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

/**
 * The owner segment of a github.com URL, or nothing.
 *
 * A repository that is not on github.com has no GitHub username, so this is
 * null, which `set` below drops: the column is empty rather than holding a
 * full link or anything else that is not a username.
 */
function githubUsername(repoUrl: string | null): string | null {
	if (!repoUrl) return null;
	try {
		const url = new URL(repoUrl);
		if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
		return url.pathname.split('/').filter(Boolean)[0] ?? null;
	} catch {
		return null;
	}
}

type SubmissionConfig = { apiKey: string; baseId: string; table: string };

function submissionConfig(): SubmissionConfig | null {
	const apiKey = runtime.AIRTABLE_API_KEY?.trim();
	const baseId = runtime.AIRTABLE_BASE_ID?.trim();
	const table = runtime.AIRTABLE_SUBMISSIONS_TABLE?.trim();
	if (!apiKey || !baseId || !table) return null;
	return { apiKey, baseId, table };
}

export async function postAirtableSubmission(record: SubmissionRecord): Promise<EffectOutcome> {
	const config = submissionConfig();
	if (!config) {
		return { status: 'deferred', error: 'AIRTABLE_SUBMISSIONS_TABLE is not set' };
	}

	/* To the nearest tenth of an hour - Ari's own rounding of its approved
	   minutes (`approved_hours`), so the base says what Ari decided. */
	const hours = Math.round((record.approvedSeconds / 3600) * 10) / 10;

	const fields: Record<string, unknown> = {};
	const set = (key: string, value: unknown) => {
		if (value !== null && value !== undefined && value !== '') fields[key] = value;
	};
	const { first, last } = splitName(record.authorName);

	set('Code URL', record.repoUrl);
	set('Playable URL', record.demoUrl);
	set('First Name', first);
	set('Last Name', last);
	set('Email', record.authorEmail);
	if (record.screenshotUrl) fields['Screenshot'] = [{ url: record.screenshotUrl }];
	set('Description', record.description);
	set('GitHub Username', githubUsername(record.repoUrl));
	if (record.address) {
		set('Address (Line 1)', record.address.line1);
		set('Address (Line 2)', record.address.line2);
		set('City', record.address.city);
		set('State / Province', record.address.region);
		set('Country', record.address.country);
		set('ZIP / Postal Code', record.address.postal);
	}
	set('Birthday', record.authorBirthday);
	set('Optional - Override Hours Spent', hours);

	/* An Ari approval fills the base's justification fields one by one, and
	   leaves `Optional - Override Hours Spent Justification` EMPTY: the base's
	   `Automation - Unified Justification` formula only assembles the fields
	   while the override is blank, and uses the override verbatim otherwise. */
	const parts = record.justificationFields;
	if (parts) {
		set('Justification - Submitter Hackatime ID', parts.hackatimeId);
		set('Justification - Hackatime Project Name(s) + Date Range(s)', parts.hackatimeProjects);
		set('Justification - Lapse Links, comma-separated', parts.lapseLinks);
		set('Justification - Specific Technical Features', parts.technicalFeatures);
		set('Justification - Deflation Justification', parts.deflation);
		set('Justification - Alternate Tracking Method', parts.alternateTracking);
		set('Justification - Additional Justification', parts.additional);
		set('Optional - Override Duplicate Justification', parts.duplicate);
	} else {
		/* An older approval's single hand-written text. The reship explanation
		   files in its own column: `[UPDATE]` says this project has been
		   approved before and what has been added since, which is what the
		   base's duplicate column asks for. The header does not travel with
		   it: the column is the label. */
		const { body: duplicate, rest: justification } = takeSection(
			record.justification ?? '',
			'UPDATE'
		);
		set('Optional - Override Duplicate Justification', duplicate);
		set('Optional - Override Hours Spent Justification', justification);
	}

	let response: Response;
	try {
		response = await fetch(`${API_URL}/${config.baseId}/${encodeURIComponent(config.table)}`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${config.apiKey}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({ records: [{ fields }] }),
			signal: AbortSignal.timeout(AIRTABLE_TIMEOUT_MS),
			cache: 'no-store'
		});
	} catch (cause) {
		/* An abort is safe to retry; any other transport failure after the request
		   was written is ambiguous - record creation is not idempotent, so a blind
		   retry could duplicate the row. */
		const aborted = cause instanceof Error && cause.name === 'TimeoutError';
		return aborted
			? { status: 'retryable', error: 'timed out reaching Airtable' }
			: {
					status: 'ambiguous',
					error: `network failure talking to Airtable: ${cause instanceof Error ? cause.name : 'unknown'}`
				};
	}

	if (!response.ok) {
		/* The body, to the log.
		 *
		 * `outbox_events.lastError` keeps status codes and never bodies, and that
		 * rule stays - but it left "Airtable returned 422" as the entire account of
		 * a terminal failure, and 422 is precisely the status whose body says which
		 * field was wrong. Establishing that a record had been refused for naming
		 * `Project` took an afternoon of probing the base by hand; it was one line
		 * in this response the whole time. Same split as the CDN upload: prose to
		 * the log, status to the caller. */
		let detail = '';
		try {
			detail = (await response.text()).slice(0, 300);
		} catch {
			/* No body to read; the status still says enough. */
		}
		console.error(
			`[airtable] submission refused with ${response.status}${detail ? `: ${detail}` : ''}`
		);

		if (response.status === 429 || response.status >= 500) {
			return { status: 'retryable', error: `Airtable returned ${response.status}` };
		}
		return { status: 'failed', error: `Airtable returned ${response.status}` };
	}

	let remoteId: string | null = null;
	try {
		const body = (await response.json()) as { records?: { id?: string }[] };
		remoteId = body.records?.[0]?.id ?? null;
	} catch {
		/* Delivered even if the created id could not be read back. */
	}
	return { status: 'delivered', remoteId };
}
