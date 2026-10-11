import { describe, expect, test } from 'bun:test';

import { SHIP_MIN_SECONDS, shipShortfall } from '../src/lib/ship-floor';

const HOUR = SHIP_MIN_SECONDS;

describe('shipShortfall', () => {
	test('a first ship needs an hour', () => {
		expect(shipShortfall(0, null, false)).toBe(HOUR);
		expect(shipShortfall(HOUR - 60, null, false)).toBe(60);
		expect(shipShortfall(HOUR, null, false)).toBe(0);
	});

	test('an update ship needs an hour of new time since the last approved ship', () => {
		expect(shipShortfall(5 * HOUR, 0, false)).toBe(HOUR);
		expect(shipShortfall(5.5 * HOUR, HOUR / 2, false)).toBe(HOUR / 2);
		expect(shipShortfall(6 * HOUR, HOUR, false)).toBe(0);
	});

	test('a newly linked project brings none of its earlier time to an update', () => {
		/* 56h on the account, none of it since the last ship: Ari counts 0. */
		expect(shipShortfall(56 * HOUR, 0, false)).toBe(HOUR);
	});

	test('after a rejection the new-time floor goes but the hour in total stays', () => {
		expect(shipShortfall(5 * HOUR, 0, true)).toBe(0);
		expect(shipShortfall(20 * 60, null, true)).toBe(HOUR - 20 * 60);
		expect(shipShortfall(0, null, true)).toBe(HOUR);
	});
});
