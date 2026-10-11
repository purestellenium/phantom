import { and, asc, desc, eq, inArray, isNull, lt } from 'drizzle-orm';

import type { DbHandle } from '$lib/server/audit';
import { HACKATIME_COUNTS_FROM } from '$lib/server/auth/hackatime';
import { PROVIDER_TIMEOUT_MS } from '$lib/server/auth/oauth';
import { signIngest } from '$lib/server/ari-signature';
import { db } from '$lib/server/db/client';
import {
	ariShips,
	projects,
	providerAccounts,
	submissionTransitions,
	submissions,
	users
} from '$lib/server/db/schema';
import { ariAppUrl, ariConfig, type AriConfig } from '$lib/server/env';
import type { EffectOutcome } from '$lib/server/outbox';
import { parseGithubRepo } from '$lib/server/github';
import { parseProjectNames } from '$lib/server/projects/projects';
import {
	isJsonObject,
	isJsonString,
	parseJson,
	readArray,
	readNumber,
	readObject,
	readString,
	type JsonObject,
	type JsonValue
} from '$lib/json';
import { hoursAndMinutes } from '$lib/justification';

/**
 * Ari, Hack Club's review platform, where every project shipped here is
 * reviewed. Its webhook reference (Docs -> Webhooks, in Ari) is the contract
 * this module keeps, and where it is silent, what Ari was seen to do.
 *
 * Two directions, each signed with its own secret:
 *
 * - OUT, a ship. Every ship and every "changes are done" is sent to
 *   `POST /api/ingest/{program}` by the `ari.ingest` outbox effect, signed
 *   with an HMAC-SHA256 of the exact body. `external_id` is the project's id,
 *   so Ari sees each Phantom project as one project and counts its ships as
 *   versions. Ari's answer carries its id for the ship, kept in `ari_ships`.
 * - IN, a decision. Ari posts every review event to /api/ari/webhook, signed
 *   over `timestamp.delivery_id.body` with the outbound secret. Verified here;
 *   applied by projects/decisions.ts.
 *
 * And `GET /api/ingest/{program}/status`, with the ingest secret as a bearer
 * token, for asking where a ship is. Used before a retried send (see
 * `sendShip`), before an approval mints anything, and by `ari.reconcile`.
 */

export const ARI_INGEST_EFFECT = 'ari.ingest';

/** One send per ship, and one per "changes are done" - a submission sent back
 *  after changes goes to Ari again as the project's next version. */
export function ariIngestDedupeKey(submissionId: string, resumedAt?: Date): string {
	return resumedAt
		? `submission:${submissionId}:ari:resumed:${resumedAt.getTime()}`
		: `submission:${submissionId}:ari`;
}

/** The review page for one Ari ship, as Ari's own app addresses it:
 *  `/p/{program}/review/{ship id}`. Null when Ari is not configured. */
export function ariReviewUrl(ariId: string): string | null {
	const app = ariAppUrl();
	if (!app) return null;
	return `${app.host}/p/${encodeURIComponent(app.program)}/review/${encodeURIComponent(ariId)}`;
}

/** Every Ari ship sent for a project, newest first - one per send, so a
 *  submission sent back after changes has more than one. */
export async function ariShipsForProject(
	projectId: string,
	handle: DbHandle = db
): Promise<{ ariId: string; submissionId: string; createdAt: Date }[]> {
	return handle
		.select({
			ariId: ariShips.ariId,
			submissionId: ariShips.submissionId,
			createdAt: ariShips.createdAt
		})
		.from(ariShips)
		.innerJoin(submissions, eq(submissions.id, ariShips.submissionId))
		.where(eq(submissions.projectId, projectId))
		.orderBy(desc(ariShips.createdAt));
}

/** The project's most recent Ari ship id, or null when it has never been sent.
 *  What a new send is "after" - see `sendShip`. */
export async function latestAriShip(
	projectId: string,
	handle: DbHandle = db
): Promise<string | null> {
	const [row] = await handle
		.select({ ariId: ariShips.ariId })
		.from(ariShips)
		.innerJoin(submissions, eq(submissions.id, ariShips.submissionId))
		.where(eq(submissions.projectId, projectId))
		.orderBy(desc(ariShips.createdAt))
		.limit(1);
	return row?.ariId ?? null;
}

/* ── the ship ────────────────────────────────────────────────────────────── */

/** Ari's limits on `meta`: flat, string values, at most 24 keys. */
const META_VALUE_MAX = 2000;
const UPDATE_MESSAGE_MAX = 2000;

function clip(value: string, max: number): string {
	const chars = [...value];
	return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}

/** An http(s) URL as it was entered, or null. Ari takes either scheme, and a
 *  query string is part of the link (a YouTube `watch?v=` is nothing without
 *  it), so nothing is stripped. */
export function httpUrl(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value.trim());
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
}

/** The repository itself, for a link to a page inside one on GitHub - Ari
 *  expects `repo_url` to be the repository, so a branch or a file has to come
 *  back to `owner/repo`. Anything else is passed through as entered. */
export function ariRepoUrl(value: string | null): string | null {
	const repo = parseGithubRepo(value);
	if (repo) return `https://github.com/${repo.owner}/${repo.name}`;
	return httpUrl(value);
}

/**
 * The ship for one submission, exactly as Ari reads it.
 *
 * Built from the submission's frozen copy, never the project's working copy -
 * the ship is what was submitted. Built when it is sent rather than when it
 * was enqueued, like every outbox effect: `sendShip` asks Ari before resending
 * anything, so a retry does not need to be byte-identical to be safe.
 *
 * `meta` carries what only Phantom knows, for the reviewer: what Phantom will
 * grant at most (its new-work cap), what was approved here before, and the
 * participant's own declarations.
 */
export async function buildShip(
	submissionId: string,
	options: { backdate: boolean; origin: string | null },
	handle: DbHandle = db
): Promise<JsonObject | null> {
	const [row] = await handle
		.select({
			submission: submissions,
			projectNumber: projects.number,
			projectKind: projects.kind,
			email: users.email,
			displayName: users.displayName,
			slackUsername: users.slackUsername,
			slackId: users.slackId
		})
		.from(submissions)
		.innerJoin(projects, eq(projects.id, submissions.projectId))
		.innerJoin(users, eq(users.id, submissions.userId))
		.where(eq(submissions.id, submissionId))
		.limit(1);
	if (!row) return null;
	const { submission } = row;

	const [hackatime] = await handle
		.select({ accountId: providerAccounts.providerAccountId })
		.from(providerAccounts)
		.where(
			and(
				eq(providerAccounts.userId, submission.userId),
				eq(providerAccounts.provider, 'hackatime')
			)
		)
		.limit(1);

	/* What was approved on this project before this ship, oldest first. The
	   last one's claim is the baseline the new-work cap is measured from. */
	const prior = await handle
		.select({ claimed: submissions.claimedSeconds, awarded: submissions.awardedSeconds })
		.from(submissions)
		.where(
			and(
				eq(submissions.projectId, submission.projectId),
				inArray(submissions.state, ['approved', 'revoked']),
				lt(submissions.createdAt, submission.createdAt)
			)
		)
		.orderBy(asc(submissions.createdAt));
	const baseline = prior.at(-1)?.claimed ?? 0;
	/* The same cap an approval applies - see `grantCap` in projects/review.ts,
	   which this mirrors rather than imports (review.ts imports this module). */
	const [shipRow] = await handle
		.select({ metadata: submissionTransitions.metadata })
		.from(submissionTransitions)
		.where(
			and(
				eq(submissionTransitions.submissionId, submission.id),
				isNull(submissionTransitions.fromState)
			)
		)
		.orderBy(asc(submissionTransitions.createdAt))
		.limit(1);
	const since = shipRow?.metadata?.sinceLastShip;
	const newWork = Math.max(
		0,
		submission.claimedSeconds - baseline,
		typeof since === 'number' ? since : 0
	);

	const maker: Record<string, JsonValue> = {
		email: row.email,
		name: clip(row.displayName ?? row.slackUsername ?? row.email.split('@')[0], 200),
		slack_id: row.slackId ?? ''
	};
	if (hackatime) maker.hackatime_id = hackatime.accountId;

	const meta: Record<string, string> = {};
	const put = (key: string, value: string | null | undefined) => {
		if (value?.trim()) meta[key] = clip(value.trim(), META_VALUE_MAX);
	};
	if (options.origin?.startsWith('https://')) {
		put('Phantom project', `${options.origin}/projects/${row.projectNumber}`);
	}
	put(
		'Phantom new work',
		`${hoursAndMinutes(newWork)} - the new Hackatime time Phantom counted since the last approval here, when it shipped.`
	);
	put(
		'Phantom tracked total',
		`${hoursAndMinutes(submission.claimedSeconds)} on the linked projects since ${HACKATIME_COUNTS_FROM.slice(0, 10)}, when it shipped.`
	);
	if (prior.length > 0) {
		put(
			'Previously approved on Phantom',
			prior.map((approval) => hoursAndMinutes(approval.awarded ?? 0)).join(', ')
		);
	}
	put('AI use', submission.aiDeclaration);
	put('Notes for the reviewer', submission.notesForReviewer);
	/* The owner's own "this existed before" goes here when the changelog took
	   `update_message`; otherwise it is the update message itself. */
	if (submission.changelog) put('Update declaration', submission.updateDeclaration);
	put('Phantom submission', submission.id);

	const ship: Record<string, JsonValue> = {
		external_id: submission.projectId,
		title: clip(submission.name, 200),
		description: submission.description ?? '',
		maker,
		repo_url: ariRepoUrl(submission.repoUrl) ?? submission.repoUrl ?? '',
		track: submission.kind ?? row.projectKind ?? 'software',
		hackatime_projects: parseProjectNames(submission.hackatimeProjects),
		evidence: ['commits', 'elapsed', 'devlog'],
		meta
	};
	const demo = httpUrl(submission.demoUrl);
	if (demo) ship.demo_url = demo;
	const thumbnail = httpUrl(submission.screenshotUrl);
	if (thumbnail) ship.thumbnail_url = thumbnail;

	/* Either kind of update - Phantom's own reship, or the owner's declaration
	   that it existed before - is an update to Ari. The changelog is the more
	   specific account when there is one. */
	const updateMessage = submission.changelog ?? submission.updateDeclaration;
	if (updateMessage?.trim()) {
		ship.is_update = true;
		ship.update_message = clip(updateMessage.trim(), UPDATE_MESSAGE_MAX);
	}

	/* For ships that were waiting before Ari reviewed them: their own ship
	   date, so Ari's queue keeps the order they shipped in. */
	if (options.backdate) ship.shipped_at = submission.createdAt.toISOString();

	return ship;
}

/* ── talking to Ari ──────────────────────────────────────────────────────── */

/** Ari could not be asked, or answered with something other than an answer. */
export class AriError extends Error {
	constructor(
		message: string,
		/** Ari's status, when it answered at all. */
		readonly status: number | null = null
	) {
		super(message);
	}
}

/**
 * Ari's status endpoint is not answering for any ship - the route itself is
 * gone, not one ship. A 404 from it means "no such ship" only when it is
 * Ari's own answer, a JSON body; a bare "Not Found" page is the endpoint
 * missing, and reading that as "no such ship" would skip approvals as if Ari
 * had taken them back.
 *
 * Its own class so each caller can choose: an approval waits (the webhook
 * answers 503 and Ari retries), the live status shows nothing, reconcile
 * counts the ship as unreachable rather than drifted, and a send goes ahead,
 * since Ari's ingest refuses a duplicate on its own (409 already_queued).
 */
export class AriStatusUnavailable extends AriError {}

type IngestAnswer =
	| { kind: 'accepted'; id: string }
	| { kind: 'already_queued'; id: string }
	| { kind: 'refused'; status: number; error: string };

async function readBody(response: Response): Promise<JsonObject> {
	try {
		const body = parseJson(await response.text());
		return body !== undefined && isJsonObject(body) ? body : {};
	} catch {
		return {};
	}
}

/** Send one signed body to the ingest endpoint. A transport failure throws. */
async function postIngest(config: AriConfig, body: string): Promise<IngestAnswer> {
	let response: Response;
	try {
		response = await fetch(`${config.host}/api/ingest/${encodeURIComponent(config.program)}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-ari-signature': signIngest(body, config.ingestSecret)
			},
			body,
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
			cache: 'no-store'
		});
	} catch {
		throw new AriError('Could not reach Ari.');
	}
	const answer = await readBody(response);
	const id = readString(answer, 'id');
	/* 202 accepted, or 200 duplicate - the same bytes again while it is open. */
	if (response.ok && id) return { kind: 'accepted', id };
	if (response.status === 409 && readString(answer, 'error') === 'already_queued' && id) {
		return { kind: 'already_queued', id };
	}
	const error = readString(answer, 'error') ?? `status ${response.status}`;
	const field = readString(answer, 'field');
	return { kind: 'refused', status: response.status, error: field ? `${error} (${field})` : error };
}

export type AriShipStatus = {
	id: string;
	externalId: string;
	version: number | null;
	/** processing, fraud_review, review, under_review, second_pass, reviewed,
	 *  withdrawn or reverted. */
	phase: string;
	/** null until decided; then approved, changes or rejected. */
	decision: string | null;
};

/**
 * Where a ship is on Ari: by our `external_id` for the project's latest ship,
 * or by Ari's id for a specific one. Null when Ari has nothing by that name.
 * Anything that is not an answer throws, so a caller can retry.
 */
export async function ariStatus(
	lookup: { externalId: string } | { id: string },
	config: AriConfig | null = ariConfig()
): Promise<AriShipStatus | null> {
	if (!config) throw new AriError('Ari is not configured.');
	const url = new URL(`${config.host}/api/ingest/${encodeURIComponent(config.program)}/status`);
	if ('externalId' in lookup) url.searchParams.set('external_id', lookup.externalId);
	else url.searchParams.set('id', lookup.id);

	let response: Response;
	try {
		response = await fetch(url, {
			headers: { authorization: `Bearer ${config.ingestSecret}`, accept: 'application/json' },
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
			cache: 'no-store'
		});
	} catch {
		throw new AriError('Could not reach Ari.');
	}
	if (response.status === 404) {
		const text = await response.text().catch(() => '');
		const parsed = parseJson(text);
		const body = parsed !== undefined && isJsonObject(parsed) ? parsed : null;
		/* Not Ari's answer at all - see AriStatusUnavailable. */
		if (!body) {
			throw new AriStatusUnavailable("Ari's status endpoint is not answering (404).", 404);
		}
		/* A program Ari does not know is a configuration problem, not "no ship". */
		if (readString(body, 'error') === 'unknown_program') {
			throw new AriError('Ari does not know ARI_PROGRAM.', 404);
		}
		return null;
	}
	if (!response.ok)
		throw new AriError(`Ari's status endpoint returned ${response.status}.`, response.status);
	const body = await readBody(response);
	const id = readString(body, 'id');
	const phase = readString(body, 'phase');
	if (!id || !phase) throw new AriError('Ari returned a status with no id or phase.');
	return {
		id,
		externalId: readString(body, 'external_id') ?? '',
		version: readNumber(body, 'version'),
		phase,
		decision: readString(body, 'decision')
	};
}

/* ── the ingest effect ───────────────────────────────────────────────────── */

async function shipOwner(ariId: string): Promise<string | null> {
	const [row] = await db
		.select({ submissionId: ariShips.submissionId })
		.from(ariShips)
		.where(eq(ariShips.ariId, ariId))
		.limit(1);
	return row?.submissionId ?? null;
}

async function recordShip(ariId: string, submissionId: string): Promise<void> {
	await db.insert(ariShips).values({ ariId, submissionId }).onConflictDoNothing();
}

/**
 * Send a submission to Ari: the `ari.ingest` outbox effect.
 *
 * Safe to run twice, and that is most of what it does. A send can land and its
 * answer be lost (a timeout after the request went out), and Ari is only
 * idempotent about that while the ship is open: once a ship is decided - and
 * Ari rejects some on its own within minutes - the same `external_id` again is
 * a second version. So before sending, it asks Ari for the project's latest
 * ship. `after` is the latest one Phantom knew of when the send was enqueued:
 * Ari reporting a ship Phantom has no record of means the earlier attempt
 * landed, and it is adopted rather than sent again.
 *
 * Unconfigured, and refusals that are about this deployment (a signature Ari
 * does not accept, a program it does not know), are `deferred` - recorded, and
 * sent once fixed. A refusal of the ship itself (422) is `failed`, for an
 * operator, with Ari's named field: the ship form refuses everything Ari
 * requires, so that is a bug to read, not a participant's to fix.
 */
export async function sendShip(payload: JsonObject | null): Promise<EffectOutcome> {
	const submissionId = payload ? readString(payload, 'submissionId') : null;
	if (!submissionId) return { status: 'failed', error: 'payload has no submissionId' };
	const after = payload ? readString(payload, 'after') : null;
	const origin = payload ? readString(payload, 'origin') : null;
	const backdate = payload?.backdate === true;

	const config = ariConfig();
	if (!config) return { status: 'deferred', error: 'ARI_PROGRAM / ARI_INGEST_SECRET are not set' };

	const [submission] = await db
		.select({ state: submissions.state, projectId: submissions.projectId })
		.from(submissions)
		.where(eq(submissions.id, submissionId))
		.limit(1);
	if (!submission) return { status: 'skipped', error: 'that submission no longer exists' };
	if (submission.state !== 'pending') {
		return {
			status: 'skipped',
			error: `the submission is ${submission.state}, not waiting for Ari`
		};
	}

	/* ── did an earlier attempt land? ──────────────────────────────────────── */
	let latest: AriShipStatus | null;
	try {
		latest = await ariStatus({ externalId: submission.projectId }, config);
	} catch (error) {
		/* The status endpoint down is no reason to hold every new ship back:
		   send, and let Ari's own 409 already_queued catch a repeat. */
		if (error instanceof AriStatusUnavailable) latest = null;
		else return deferOrRetry(error);
	}
	if (latest && latest.id !== after) {
		const owner = await shipOwner(latest.id);
		if (owner === submissionId) return { status: 'delivered', remoteId: latest.id };
		if (owner === null) {
			await recordShip(latest.id, submissionId);
			console.warn(
				`[ari] adopted ${latest.id} for submission ${submissionId} from an earlier send`
			);
			return { status: 'delivered', remoteId: latest.id };
		}
	}

	/* ── send ──────────────────────────────────────────────────────────────── */
	const ship = await buildShip(submissionId, { backdate, origin });
	if (!ship) return { status: 'skipped', error: 'that submission no longer exists' };

	let answer: IngestAnswer;
	try {
		answer = await postIngest(config, JSON.stringify(ship));
	} catch (error) {
		return deferOrRetry(error);
	}

	if (answer.kind === 'accepted') {
		await recordShip(answer.id, submissionId);
		return { status: 'delivered', remoteId: answer.id };
	}
	if (answer.kind === 'already_queued') {
		/* An open ship for this project. Ours if Phantom has no other claim on
		   it - the only sender for this program is Phantom - and otherwise a
		   ship of an earlier submission that Ari still holds open, which is a
		   disagreement for a person. */
		const owner = await shipOwner(answer.id);
		if (owner === null || owner === submissionId) {
			await recordShip(answer.id, submissionId);
			return { status: 'delivered', remoteId: answer.id };
		}
		return {
			status: 'failed',
			error: `Ari still holds ${answer.id} open for an earlier submission of this project`
		};
	}

	const { status, error } = answer;
	if (status === 401 || error.startsWith('unknown_program')) {
		return { status: 'deferred', error: `Ari refused the send (${status} ${error})` };
	}
	if (status === 408 || status === 429 || status >= 500) {
		return { status: 'retryable', error: `Ari returned ${status}` };
	}
	console.error(`[ari] ship ${submissionId} refused: ${status} ${error}`);
	return { status: 'failed', error: `Ari refused the ship: ${status} ${error}` };
}

function deferOrRetry(error: unknown): EffectOutcome {
	if (error instanceof AriError) {
		if (error.status === 401 || error.status === 404) {
			return { status: 'deferred', error: error.message };
		}
		return { status: 'retryable', error: error.message };
	}
	throw error;
}

/* ── reading a delivery ──────────────────────────────────────────────────── */

/** The fields of Ari's ship snapshot Phantom keeps, as present in a delivery.
 *  Absent means "not in this delivery", never "cleared". */
export type AriSnapshot = {
	title?: string;
	description?: string;
	track?: 'software' | 'hardware';
	thumbnailUrl?: string | null;
	repoUrl?: string | null;
	demoUrl?: string | null;
	hackatimeProjects?: string[];
};

export type AriReview = {
	approvedMinutes: number | null;
	noteToMaker: string | null;
	auditNote: string | null;
	/** Ari's hours justification, flat: each part as Ari named it. */
	justification: Record<string, string>;
	reviewer: { email: string | null; slackId: string | null } | null;
	breakdown: JsonObject | null;
	/** The program's review checklist, as the reviewer answered it. `key` is
	 *  the field's stable name on Ari; `label` is what it reads as, and can be
	 *  renamed there at any time. */
	fields: { key: string | null; label: string; value: string | number | boolean | null }[];
};

/** The review field Ari's reviewers tick to mark a ship hyper-chroma. */
export const HYPER_CHROMA_FIELD = 'hyper_chroma';

/** Whether the reviewer ticked hyper-chroma. Matched on the field's key, never
 *  its label, so renaming the checkbox on Ari cannot quietly stop it counting;
 *  and only a boolean true, so a field of some other type that happens to
 *  share the name is not read as a yes. */
export function isHyperChroma(review: AriReview | null): boolean {
	return (review?.fields ?? []).some(
		(field) => field.key === HYPER_CHROMA_FIELD && field.value === true
	);
}

export type AriEvent = {
	event: string;
	decision: string | null;
	/** Ari's id for the ship this is about. */
	id: string;
	externalId: string;
	ship: AriSnapshot | null;
	review: AriReview | null;
};

function nullableUrl(source: JsonObject, key: string): string | null | undefined {
	if (!(key in source)) return undefined;
	return httpUrl(readString(source, key));
}

function readSnapshot(source: JsonObject | null): AriSnapshot | null {
	if (!source) return null;
	const snapshot: AriSnapshot = {};
	const title = readString(source, 'title');
	if (title?.trim()) snapshot.title = title.trim();
	const description = readString(source, 'description');
	if (description !== null) snapshot.description = description;
	const track = readString(source, 'track');
	if (track === 'software' || track === 'hardware') snapshot.track = track;
	const thumbnail = nullableUrl(source, 'thumbnail_url');
	if (thumbnail !== undefined) snapshot.thumbnailUrl = thumbnail;
	const repo = nullableUrl(source, 'repo_url');
	if (repo !== undefined) snapshot.repoUrl = repo;
	const demo = nullableUrl(source, 'demo_url');
	if (demo !== undefined) snapshot.demoUrl = demo;
	const hackatime = readArray(source, 'hackatime_projects');
	if (hackatime) {
		snapshot.hackatimeProjects = hackatime
			.filter(isJsonString)
			.map((name) => name.trim())
			.filter(Boolean);
	}
	return snapshot;
}

function readReview(source: JsonObject | null): AriReview | null {
	if (!source) return null;
	const justification: Record<string, string> = {};
	const parts = readObject(source, 'justification');
	if (parts) {
		for (const [key, value] of Object.entries(parts)) {
			if (isJsonString(value) && value.trim()) justification[key] = value.trim();
		}
	}
	const reviewer = readObject(source, 'reviewer');
	return {
		approvedMinutes: readNumber(source, 'approved_minutes'),
		noteToMaker: readString(source, 'note_to_maker')?.trim() || null,
		auditNote: readString(source, 'audit_note')?.trim() || null,
		justification,
		reviewer: reviewer
			? { email: readString(reviewer, 'email'), slackId: readString(reviewer, 'slack_id') }
			: null,
		breakdown: readObject(source, 'minutes_breakdown'),
		fields: (readArray(source, 'fields') ?? []).filter(isJsonObject).map((field) => {
			const value = field.value;
			return {
				key: readString(field, 'key'),
				label: readString(field, 'label') ?? readString(field, 'key') ?? '',
				value:
					typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
						? value
						: null
			};
		})
	};
}

/** A delivery's body, read into the parts Phantom acts on. Null when it lacks
 *  what every event carries - its name and which ship it is about. */
export function readAriEvent(body: JsonObject): AriEvent | null {
	const event = readString(body, 'event');
	const id = readString(body, 'id');
	const externalId = readString(body, 'external_id');
	if (!event || !id || !externalId) return null;
	return {
		event,
		decision: readString(body, 'decision'),
		id,
		externalId,
		ship: readSnapshot(readObject(body, 'ship')),
		review: readReview(readObject(body, 'review'))
	};
}
