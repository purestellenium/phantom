import type { RequestHandler } from './$types';

import { requireCapability } from '$lib/server/auth/authorize';
import { auditFiltersFrom, searchAudit } from '$lib/server/audit-search';
import { csvResponse, stampedName, toCsv } from '$lib/csv';

/**
 * The events, as a file - the same filters the page read, the same query,
 * more rows.
 *
 * Guarded with the page's `view_audit`, and not as a formality: an endpoint
 * that serves the rows a page serves is a way around the page's check unless
 * it performs the same one. Metadata goes out as one JSON column rather than
 * exploded into keys, for the reason the page renders it that way: its shape
 * is not known here and a column set chosen today would silently drop the
 * events added tomorrow.
 */
const EXPORT_LIMIT = 5000;

export const GET: RequestHandler = async ({ url }) => {
	requireCapability('view_audit');

	const rows = await searchAudit(auditFiltersFrom(url), EXPORT_LIMIT);

	const body = toCsv(
		['at', 'action', 'actor_email', 'actor_name', 'subject_email', 'subject_name', 'metadata'],
		rows.map((row) => [
			row.event.createdAt,
			row.event.action,
			row.actorEmail,
			row.actorName,
			row.subjectEmail,
			row.subjectName,
			row.event.metadata ? JSON.stringify(row.event.metadata) : ''
		])
	);

	return csvResponse(stampedName('phantom-audit'), body);
};
