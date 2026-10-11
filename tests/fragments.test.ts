import { describe, expect, test } from 'bun:test';

import { payoutSeconds, fragments, signedFragments, toFragments } from '../src/lib/fragments';

describe('fragments', () => {
	test('an hour is ten fragments', () => {
		expect(toFragments(3600)).toBe(10);
		expect(fragments(3600)).toBe('10 fragments');
		expect(fragments(360)).toBe('1 fragment');
	});

	test('a grant pays whole fragments, rounded down', () => {
		/* 47 minutes is 7.83 fragments: 7 are credited. */
		expect(payoutSeconds(47 * 60)).toBe(7 * 360);
		expect(payoutSeconds(359)).toBe(0);
		expect(payoutSeconds(3600)).toBe(3600);
	});

	test('a remainder never shows as a fragment it is not', () => {
		expect(toFragments(3599)).toBe(9);
		/* Toward zero both ways, so a debit never shows more than it took. */
		expect(toFragments(-3599)).toBe(-9);
		expect(signedFragments(-3600)).toBe('−10 fragments');
		expect(signedFragments(720)).toBe('+2 fragments');
	});
});
