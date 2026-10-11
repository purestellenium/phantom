import { describe, expect, test } from 'bun:test';

import {
	mergePeople,
	planLoopsSync,
	SHIPPED,
	SIGNED_UP_AT,
	type Person,
	type Row
} from '../src/lib/server/loops-plan';

const AT = new Date('2026-09-14T02:25:22.908Z');

function people(...list: Person[]) {
	return mergePeople(list);
}

function row(
	id: string,
	fields: Record<string, unknown>,
	createdTime = '2026-10-01T00:00:00.000Z'
): Row {
	return { id, createdTime, fields };
}

describe('Loops sync plan', () => {
	test('an account with no row is created with every field', () => {
		const plan = planLoopsSync(
			people({ email: 'a@x.com', signedUpAt: AT, shipped: true }),
			[],
			'Email',
			'dateTime'
		);
		expect(plan.creates).toEqual([
			{ Email: 'a@x.com', [SHIPPED]: true, [SIGNED_UP_AT]: '2026-09-14T02:25:22Z' }
		]);
		expect(plan.updates).toEqual([]);
	});

	test('a row that already agrees is not sent, whatever its case or milliseconds', () => {
		const plan = planLoopsSync(
			people({ email: 'A@X.com ', signedUpAt: AT, shipped: false }),
			[row('rec1', { Email: 'a@x.com', [SIGNED_UP_AT]: '2026-09-14T02:25:22.000Z' })],
			'Email',
			'dateTime'
		);
		expect(plan).toEqual({ creates: [], updates: [], unchanged: 1, duplicateRows: 0 });
	});

	test('only the fields that differ go into an update', () => {
		const plan = planLoopsSync(
			people({ email: 'a@x.com', signedUpAt: AT, shipped: true }),
			[row('rec1', { Email: 'a@x.com', [SIGNED_UP_AT]: '2026-09-14T02:25:22.000Z' })],
			'Email',
			'dateTime'
		);
		expect(plan.updates).toEqual([{ id: 'rec1', fields: { [SHIPPED]: true } }]);
	});

	test('an unwritable sign-up field is left to Airtable', () => {
		const plan = planLoopsSync(
			people({ email: 'a@x.com', signedUpAt: AT, shipped: false }),
			[row('rec1', { Email: 'a@x.com', [SIGNED_UP_AT]: '2026-10-08T20:00:00.000Z' })],
			'Email',
			null
		);
		expect(plan.unchanged).toBe(1);
		expect(
			planLoopsSync(people({ email: 'b@x.com', signedUpAt: AT, shipped: false }), [], 'Email', null)
				.creates
		).toEqual([{ Email: 'b@x.com', [SHIPPED]: false }]);
	});

	test('a date-only field compares and writes the day', () => {
		const plan = planLoopsSync(
			people({ email: 'a@x.com', signedUpAt: AT, shipped: false }),
			[row('rec1', { Email: 'a@x.com', [SIGNED_UP_AT]: '2026-09-13' })],
			'Email',
			'date'
		);
		expect(plan.updates).toEqual([{ id: 'rec1', fields: { [SIGNED_UP_AT]: '2026-09-14' } }]);
	});

	test('waiting-list rows are never touched, and duplicates keep the oldest', () => {
		const plan = planLoopsSync(
			people({ email: 'a@x.com', signedUpAt: AT, shipped: true }),
			[
				row('newer', { Email: 'a@x.com' }, '2026-10-02T00:00:00.000Z'),
				row('older', { Email: 'A@x.com' }, '2026-10-01T00:00:00.000Z'),
				row('waitlist', { Email: 'w@x.com' })
			],
			'Email',
			null
		);
		expect(plan.updates).toEqual([{ id: 'older', fields: { [SHIPPED]: true } }]);
		expect(plan.duplicateRows).toBe(1);
		expect(plan.creates).toEqual([]);
	});

	test('two accounts on one email are one contact', () => {
		const merged = mergePeople([
			{ email: 'a@x.com', signedUpAt: new Date('2026-10-01'), shipped: false },
			{ email: 'A@x.com', signedUpAt: AT, shipped: true }
		]);
		expect(merged.size).toBe(1);
		expect(merged.get('a@x.com')).toEqual({ email: 'a@x.com', signedUpAt: AT, shipped: true });
	});
});
