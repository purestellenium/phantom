import type { PageServerLoad } from './$types';

import { requireCapability } from '$lib/server/auth/authorize';
import { hasFindings, reconcile } from '$lib/server/reconcile';

/**
 * The books, checked.
 *
 * The page has NO BUTTONS. That is the design, not an omission: every repair
 * available would be an append to the ledger, which is a decision with a reason
 * attached rather than something a button should do in a loop. When something
 * shows up here, the fix is an adjustment on the person's own page, quoting the
 * finding's id in its reason - which is itself an auditable row that says why.
 *
 * The checks run on every load rather than being cached, because a stale
 * answer to "do the books balance" is worse than no answer. They also run on a
 * schedule; see the ledger.reconcile job.
 */
export const load: PageServerLoad = async () => {
	requireCapability('view_audit');
	const findings = await reconcile();
	return { findings, anything: hasFindings(findings) };
};
