import { describe, expect, test } from 'bun:test';

import { PIXEL_ICONS, pixelCells, type PixelIconName } from '../src/lib/pixel-icons';

describe('pixel icons', () => {
	for (const [name, grid] of Object.entries(PIXEL_ICONS)) {
		test(`${name} is a 12x12 grid of . and #`, () => {
			expect(grid).toHaveLength(12);
			for (const row of grid) expect(row).toMatch(/^[.#]{12}$/);
			expect(pixelCells(name as PixelIconName).length).toBeGreaterThan(0);
		});
	}
});
