import { and, eq, isNull } from 'drizzle-orm';

import { recordAudit, type DbHandle } from '$lib/server/audit';
import { db } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';

/** Mark setup complete once, with the audit row in the same transaction. */
export async function completeOnboarding(
	input: { userId: string; hackatimeAccountId: string },
	handle: DbHandle = db
): Promise<boolean> {
	const [updated] = await handle
		.update(users)
		.set({ onboardedAt: new Date(), updatedAt: new Date() })
		.where(and(eq(users.id, input.userId), isNull(users.onboardedAt)))
		.returning({ id: users.id });

	if (!updated) return false;

	await recordAudit(
		{
			action: 'onboarding.finished',
			actorId: input.userId,
			subjectId: input.userId,
			metadata: { hackatimeAccountId: input.hackatimeAccountId }
		},
		handle
	);

	return true;
}
