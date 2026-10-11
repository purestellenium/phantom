import { describe, expect, test } from 'bun:test';

import { isReferralSource, referralFrom } from '../src/lib/referral';

const at = (query: string) => new URL(`https://phantom.hackclub.com/${query}`);

describe('referralFrom', () => {
	test('reads ?ref= and ?utm_source=, in any case', () => {
		expect(referralFrom(at('?ref=stardance'))).toBe('stardance');
		expect(referralFrom(at('?utm_source=Stardance'))).toBe('stardance');
		expect(referralFrom(at('shop?utm_medium=x&ref=STARDANCE'))).toBe('stardance');
	});

	test('ignores anything off the allowlist', () => {
		expect(referralFrom(at('?ref=someone-else'))).toBeNull();
		expect(referralFrom(at('?ref=stardance%3Cscript%3E'))).toBeNull();
		expect(referralFrom(at(''))).toBeNull();
	});

	test('prefers ref when both are given', () => {
		expect(referralFrom(at('?ref=stardance&utm_source=other'))).toBe('stardance');
	});
});

describe('utm_medium=email', () => {
	test('credits email, in any case', () => {
		expect(referralFrom(at('?utm_medium=email'))).toBe('email');
		expect(referralFrom(at('?utm_source=loops&utm_medium=Email'))).toBe('email');
	});

	test('a partner source wins over the medium', () => {
		expect(referralFrom(at('?utm_source=stardance&utm_medium=email'))).toBe('stardance');
	});

	test('other mediums are nothing', () => {
		expect(referralFrom(at('?utm_medium=social'))).toBeNull();
	});
});

describe('isReferralSource', () => {
	test('only the allowlist', () => {
		expect(isReferralSource('stardance')).toBe(true);
		expect(isReferralSource('Stardance')).toBe(false);
		expect(isReferralSource('toString')).toBe(false);
		expect(isReferralSource(undefined)).toBe(false);
	});
});
