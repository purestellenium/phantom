import { describe, expect, test } from 'bun:test';

import { isoWeek, scrubUrl, stringProps } from '../src/lib/analytics/shared';

const at = (path: string) => `https://phantom.hackclub.com${path}`;
const ID = '3f2b8c1e-1234-4abc-9def-0123456789ab';

describe('scrubUrl', () => {
	test('collapses UUIDs in the path, and keeps project numbers', () => {
		expect(scrubUrl(at(`/orders/${ID}`))).toBe(at('/orders/:id'));
		expect(scrubUrl(at(`/admin/users/${ID}/x`))).toBe(at('/admin/users/:id/x'));
		expect(scrubUrl(at('/explore/42'))).toBe(at('/explore/42'));
	});

	test('drops every query parameter but utm_*', () => {
		expect(scrubUrl(at('/api/auth/hca/callback?code=s3cret&state=x'))).toBe(
			at('/api/auth/hca/callback')
		);
		expect(scrubUrl(at('/explore?q=foo&kind=hardware'))).toBe(at('/explore'));
		expect(scrubUrl(at('/?utm_source=stardance&utm_medium=x'))).toBe(
			at('/?utm_source=stardance&utm_medium=x')
		);
	});

	test('replaces an invite code with utm_source=invite, never over a partner source', () => {
		expect(scrubUrl(at('/?ref=aB3xY&email=a@b.co'))).toBe(
			at('/?utm_source=invite&utm_medium=referral')
		);
		expect(scrubUrl(at('/?utm_source=stardance&ref=aB3xY'))).toBe(at('/?utm_source=stardance'));
	});
});

describe('isoWeek', () => {
	test('takes the year from the week, not the date', () => {
		expect(isoWeek(new Date('2026-10-09T12:00:00Z'))).toBe('2026-W41');
		expect(isoWeek(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
		expect(isoWeek(new Date('2025-12-29T12:00:00Z'))).toBe('2026-W01');
	});
});

describe('stringProps', () => {
	test('states booleans as yes/no and leaves out empty values', () => {
		expect(stringProps({ a: true, b: 3, c: null, d: undefined, e: 'x' })).toEqual({
			a: 'yes',
			b: '3',
			e: 'x'
		});
	});
});
