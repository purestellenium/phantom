import { resolve } from '$app/paths';
import type { PageServerLoad } from './$types';

import { requireCapability } from '$lib/server/auth/authorize';
import {
	auditFiltersFrom,
	auditLog,
	auditPrefixes,
	auditQuery,
	searchAudit
} from '$lib/server/audit-search';

/**
 * Who changed what.
 *
 * The audit table is append-only and deliberately loose about its metadata -
 * the schema says so, and that looseness is what makes it get written at all -
 * so this page renders the metadata as JSON rather than pretending to know the
 * shape of every event. A viewer that only understood the event types it was
 * written for would silently show nothing for the ones added afterwards, which
 * is the exact failure an audit log cannot have.
 *
 * Values are scrubbed on the way IN, by $lib/server/audit.ts, not on the way
 * out here. That is the right end: a token that never reached the column
 * cannot leak from a page that forgot to redact it.
 *
 * The query itself lives in $lib/server/audit-search.ts, shared with the CSV
 * export so the file is the page.
 */
export const load: PageServerLoad = async ({ url }) => {
	requireCapability('view_audit');
	const filters = auditFiltersFrom(url);

	const [rows, prefixes] = await Promise.all([searchAudit(filters, 200), auditPrefixes()]);

	/* Every link resolved here, where the filters are. A chip keeps the rest
	   of the search and swaps the prefix, so narrowing by action does not throw
	   away the dates just typed; the export is the page's own query. */
	const query = auditQuery(filters);
	return {
		filters,
		log: auditLog(rows),
		everythingHref: resolve('/admin/audit'),
		exportHref: query ? resolve(`/admin/audit/export?${query}`) : resolve('/admin/audit/export'),
		prefixes: prefixes.map((row) => {
			const active = filters.action === row.prefix;
			const chip = auditQuery({ ...filters, action: active ? null : row.prefix });
			return {
				...row,
				active,
				href: chip ? resolve(`/admin/audit?${chip}`) : resolve('/admin/audit')
			};
		})
	};
};
