/**
 * The shape of a review justification: `[SECTION]` headers, each with a body.
 *
 * The text is assembled from an Ari decision (`ariJustification`, below) and
 * stored on the submission; the Airtable effect reads it back and lifts
 * `[UPDATE]` out into its own column. Nothing here is enforced, and nothing
 * may throw on text that does not match - older justifications were typed by
 * hand on the review desk and follow the convention only roughly. Pure, so it
 * is testable without a server.
 *
 * Every function here is total: unrecognised text comes back unchanged, and a
 * missing section is an empty string rather than an error. A reviewer who
 * deletes a header has written prose, not a malformed document.
 */

/** A line that is exactly a section header, and nothing else on it. */
const HEADER = /^\[[A-Z][A-Z ]*\]$/;

export type Section = {
	/** Null for anything above the first header - prose a reviewer typed at the
	 *  top rather than inside a section. Kept rather than discarded. */
	name: string | null;
	body: string;
};

/** Break a justification into its sections, in the order they appear. */
export function splitSections(text: string): Section[] {
	const sections: Section[] = [];
	let name: string | null = null;
	let lines: string[] = [];

	const flush = () => {
		const body = lines.join('\n').trim();
		if (name !== null || body) sections.push({ name, body });
		lines = [];
	};

	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (HEADER.test(trimmed)) {
			flush();
			name = trimmed.slice(1, -1);
		} else {
			lines.push(line);
		}
	}
	flush();
	return sections;
}

/** Put them back together, one blank line between blocks. */
export function joinSections(sections: readonly Section[]): string {
	return sections
		.map((section) => (section.name === null ? section.body : `[${section.name}]\n${section.body}`))
		.filter((block) => block.trim())
		.join('\n\n');
}

/**
 * Lift one section out: its body, and the text without it.
 *
 * For the Airtable effect, which files `[UPDATE]` in a column of its own. The
 * header does not travel - the column IS the label, and a `[UPDATE]` line
 * inside a field called "Override Duplicate Justification" is the same word
 * said twice.
 */
export function takeSection(text: string, name: string): { body: string; rest: string } {
	const sections = splitSections(text);
	const found = sections.find((section) => section.name === name);
	return {
		body: found?.body ?? '',
		rest: joinSections(sections.filter((section) => section !== found))
	};
}

/* ── the figures ─────────────────────────────────────────────────────────── */

/** `20h 57m`, the way every number in a justification is written. */
export function hoursAndMinutes(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.round((seconds % 3600) / 60);
	return `${hours}h ${minutes}m`;
}

/** The sentence in `[UPDATE]` that names this grant and the running total. */
export function updateTotalsSentence(awardedSeconds: number, priorTotal: number): string {
	return (
		`Now, ${hoursAndMinutes(awardedSeconds)} additional are being approved, ` +
		`to total to ${hoursAndMinutes(priorTotal + awardedSeconds)}.`
	);
}

/** The line a justification opens with: what is being granted, above all the
 *  reasons for it. */
export function approvedSentence(awardedSeconds: number): string {
	return `Project is approved for ${hoursAndMinutes(awardedSeconds)}.`;
}

/* ── built from an Ari decision ──────────────────────────────────────────── */

export type AriJustificationInput = {
	/** What Phantom granted: Ari's figure. */
	awardedSeconds: number;
	/** What Ari approved. */
	ariSeconds: number;
	/** The new time Phantom counted itself - see `grantCap` in
	 *  projects/review.ts. Kept for the record; it does not change the grant. */
	newWork: number;
	/** Every earlier approval on the project, oldest first, in seconds. */
	priorApprovals: number[];
	changelog: string | null;
	updateDeclaration: string | null;
	/** Ari's `review.justification`, as sent. */
	parts: Readonly<Record<string, string>>;
	/** Ari's `review.audit_note`: the reviewer's own write-up of the review.
	 *  The bulk of the justification; `technical_features` is often just its
	 *  first sentence. */
	auditNote?: string | null;
	/** Ari's `review.fields`: the program's review checklist, as answered. */
	checks?: readonly { label: string; value: string | number | boolean | null }[];
	/** Ari's `review.minutes_breakdown`: where its approved minutes came from. */
	breakdown?: Readonly<Record<string, number>> | null;
	/** The submitter's Hackatime id as Phantom has it, for when Ari sends none. */
	hackatimeAccountId?: string | null;
	/** Who decided it, as the footer says it. */
	credit: string;
};

/**
 * The YSWS base's own justification fields, one per part, for an approval Ari
 * decided. The base's `Automation - Unified Justification` formula assembles
 * them into what reaches the Unified database - but only while `Optional -
 * Override Hours Spent Justification` is blank, so an Ari approval fills these
 * and leaves the override alone. Null is "leave the field empty".
 */
export type AriJustificationFields = {
	hackatimeId: string | null;
	/** `name M/D/YYYY-M/D/YYYY`, comma-separated - Ari sends exactly the format
	 *  the base's field asks for. */
	hackatimeProjects: string | null;
	lapseLinks: string | null;
	technicalFeatures: string | null;
	deflation: string | null;
	alternateTracking: string | null;
	additional: string | null;
	/** `Optional - Override Duplicate Justification`: the update account. */
	duplicate: string | null;
};

/* Ari's prose prompts beyond technical features, with the label each gets in
   Additional Justification. */
const REVIEWER_PARTS: [key: string, label: string][] = [
	['time_evidence', 'Time evidence'],
	['supporting_evidence', 'Supporting evidence'],
	['hours_reasoning', 'Hours reasoning'],
	['additional_justification', 'Additional justification']
];
/* Every part that has a field of its own, or a place above. */
const PLACED = new Set([
	'hackatime_projects',
	'hackatime_user_id',
	'lapse_links',
	'technical_features',
	'deflation_reason',
	'unified_db_record',
	...REVIEWER_PARTS.map(([key]) => key)
]);

const BREAKDOWN_LABELS: [key: string, label: string][] = [
	['journals', 'journal entries'],
	['lapse', 'Lapse timelapses'],
	['program', 'time the program vouched for']
];

const clean = (value: string | null | undefined) => value?.trim() || null;

/**
 * Ari's decision, split into the YSWS base's justification fields.
 *
 * Ari writes most of it: the time tracking (which Hackatime projects were
 * counted over which dates, the Hackatime id, the Lapse links), the technical
 * features, and the reviewer's own write-up and checklist. Phantom
 * adds what only it knows - the earlier approvals on this project and what the
 * participant said changed.
 *
 * Total like the rest of this module: missing parts are left empty, never
 * invented. A part of Ari's that has no field of its own goes to Additional
 * Justification under its own name rather than being dropped, so a new prompt
 * on Ari's side still reaches the record.
 */
export function ariJustificationFields(input: AriJustificationInput): AriJustificationFields {
	const { parts } = input;

	const deflation = [clean(parts.deflation_reason)];

	/* Time Ari credited from somewhere other than Hackatime - the base's
	   "alternate tracking method", in Ari's own minutes. */
	const alternate = BREAKDOWN_LABELS.flatMap(([key, label]) => {
		const minutes = input.breakdown?.[key] ?? 0;
		return minutes > 0 ? [`${hoursAndMinutes(minutes * 60)} from ${label}`] : [];
	});

	/* The reviewer's write-up first, then any prompt it does not already
	   contain - `technical_features` is usually its opening sentence, and
	   saying it twice reads as padding. */
	const note = clean(input.auditNote);
	const technical = clean(parts.technical_features) ?? note;
	const said = (value: string) =>
		[note, technical].some((text) => text !== null && text.includes(value.trim()));
	const additional: string[] = [];
	if (note && note !== technical) additional.push(note);
	for (const [key, label] of REVIEWER_PARTS) {
		const value = clean(parts[key]);
		if (value && !said(value)) additional.push(`${label}: ${value}`);
	}
	for (const [key, value] of Object.entries(parts)) {
		if (!PLACED.has(key) && clean(value) && !said(value)) {
			additional.push(`${key.replace(/_/g, ' ')}: ${value.trim()}`);
		}
	}
	const checks = (input.checks ?? []).filter((check) => check.label.trim());
	if (checks.length > 0) {
		additional.push(
			`Review checklist:\n${checks
				.map((check) => {
					const answer =
						check.value === true
							? 'yes'
							: check.value === false
								? 'no'
								: String(check.value ?? '').trim() || '-';
					return `- ${check.label.trim()}: ${answer}`;
				})
				.join('\n')}`
		);
	}
	/* Hardware decisions: Ari's own ready-to-paste write-up, as it wrote it. */
	if (clean(parts.unified_db_record)) additional.push(parts.unified_db_record.trim());
	additional.push(input.credit);

	const update: string[] = [];
	if (input.priorApprovals.length > 0) {
		const prior = input.priorApprovals.map(hoursAndMinutes).join(' and ');
		const total = input.priorApprovals.reduce((sum, value) => sum + value, 0);
		update.push(
			`This is an update ship / reship to a project previously submitted to Phantom. ` +
				`Previously, ${prior} were approved. ` +
				`${updateTotalsSentence(input.awardedSeconds, total)}` +
				(input.changelog
					? `\nHere's what changed, as reported by the submitter:\n"${input.changelog}"`
					: '')
		);
	}
	if (input.updateDeclaration) {
		update.push(
			`The user marked this project as an update to an existing project, saying:\n"${input.updateDeclaration}"`
		);
	}

	const joined = (lines: (string | null)[], separator = '\n') =>
		lines.filter((line): line is string => !!line).join(separator) || null;
	return {
		hackatimeId: clean(parts.hackatime_user_id) ?? clean(input.hackatimeAccountId),
		hackatimeProjects: clean(parts.hackatime_projects),
		lapseLinks: clean(parts.lapse_links),
		technicalFeatures: technical,
		deflation: joined(deflation),
		alternateTracking: alternate.length > 0 ? `Ari also counted ${alternate.join(', ')}.` : null,
		additional: joined(additional, '\n\n'),
		duplicate: joined(update, '\n\n')
	};
}

/**
 * The same justification as one text, for Phantom's own record of the
 * approval (`submissions.justification`) - laid out the way the base's
 * formula lays out the fields, so the two read alike. `[UPDATE]` stays a
 * section of its own here; the base keeps it in its duplicate column.
 */
export function ariJustification(input: AriJustificationInput): string {
	const fields = ariJustificationFields(input);
	const sections: Section[] = [{ name: null, body: approvedSentence(input.awardedSeconds) }];
	const hackatime = [
		fields.hackatimeId ? `Hackatime ID: ${fields.hackatimeId}` : null,
		fields.hackatimeProjects ? `Hackatime Projects: ${fields.hackatimeProjects}` : null,
		fields.lapseLinks ? `Lapse Links: ${fields.lapseLinks}` : null
	].filter((line): line is string => line !== null);
	if (hackatime.length > 0) sections.push({ name: 'HACKATIME', body: hackatime.join('\n') });
	if (fields.duplicate) sections.push({ name: 'UPDATE', body: fields.duplicate });
	if (fields.technicalFeatures) {
		sections.push({ name: 'SPECIFIC TECHNICAL FEATURES', body: fields.technicalFeatures });
	}
	if (fields.deflation) sections.push({ name: 'DEFLATION JUSTIFICATION', body: fields.deflation });
	if (fields.alternateTracking) {
		sections.push({ name: 'ALTERNATE TRACKING METHOD', body: fields.alternateTracking });
	}
	if (fields.additional)
		sections.push({ name: 'ADDITIONAL JUSTIFICATION', body: fields.additional });
	return joinSections(sections);
}
