import { describe, expect, test } from 'bun:test';

import { applyAiDeduction } from '../src/lib/server/auth/ai-deduction';

describe('applyAiDeduction', () => {
	test('ai time counts at a third: 7h hand-coded plus 3h ai reads as 8h', () => {
		expect(applyAiDeduction(10 * 3600, 3 * 3600)).toBe(8 * 3600);
	});

	test('no ai time leaves the total alone', () => {
		expect(applyAiDeduction(10 * 3600, 0)).toBe(10 * 3600);
	});

	test('all-ai time reads as a third', () => {
		expect(applyAiDeduction(9 * 3600, 9 * 3600)).toBe(3 * 3600);
	});

	test('a non-positive total floors at zero rather than going negative', () => {
		expect(applyAiDeduction(-100, 0)).toBe(0);
		expect(applyAiDeduction(0, 0)).toBe(0);
	});

	test('fractional thirds round to the nearest second', () => {
		/* One second of AI keeps a third of a second: rounds down to the total. */
		expect(applyAiDeduction(3600, 1)).toBe(3599);
	});
});
