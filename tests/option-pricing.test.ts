import { describe, expect, test } from 'bun:test';

import {
	MAX_EXTRA_HOURS,
	parseOptionSchema,
	priceRange,
	surchargeFor,
	validateOptions,
	type ProductOption
} from '../src/lib/shop/options';

/**
 * What a configuration costs.
 *
 * Pure, so it needs no database and runs anywhere - which is the point of
 * testing this half rather than the purchase transaction around it. Every rule
 * here is one a wrong answer turns into money: a surcharge that parses as zero
 * is a discount nobody authorised, and one that survives on a choice the buyer
 * did not pick is a charge nobody agreed to.
 */

const parse = (schema: unknown) => parseOptionSchema(schema as never);

function optionsOf(schema: unknown): ProductOption[] {
	const result = parse(schema);
	if (!result.ok) throw new Error(`expected a valid schema, got: ${result.error}`);
	return result.options;
}

const SIZE = {
	type: 'select',
	key: 'size',
	label: 'size',
	required: true,
	choices: [
		{ value: 'thirteen', label: '13-inch' },
		{ value: 'fifteen', label: '15-inch', extraHours: 50 }
	]
};

describe('parsing', () => {
	test('a choice with no extraHours is free', () => {
		const [option] = optionsOf([SIZE]);
		if (option.type !== 'select') throw new Error('expected a select');
		expect(option.choices[0].extraSeconds).toBe(0);
	});

	test('extraHours is read as hours and stored as seconds', () => {
		const [option] = optionsOf([SIZE]);
		if (option.type !== 'select') throw new Error('expected a select');
		expect(option.choices[1].extraSeconds).toBe(50 * 3600);
	});

	test('a negative surcharge is refused', () => {
		const result = parse([{ ...SIZE, choices: [{ value: 'a' }, { value: 'b', extraHours: -5 }] }]);
		expect(result.ok).toBe(false);
	});

	test('a fractional surcharge is refused rather than rounded', () => {
		const result = parse([{ ...SIZE, choices: [{ value: 'a' }, { value: 'b', extraHours: 1.5 }] }]);
		expect(result.ok).toBe(false);
	});

	test('an absurd surcharge is refused', () => {
		const result = parse([
			{ ...SIZE, choices: [{ value: 'a' }, { value: 'b', extraHours: MAX_EXTRA_HOURS + 1 }] }
		]);
		expect(result.ok).toBe(false);
	});

	/* The rule the whole "from" display rests on: the base price has to be a
	   price somebody can actually pay. */
	test('a required option where every choice costs extra is refused', () => {
		const result = parse([
			{
				...SIZE,
				choices: [
					{ value: 'a', extraHours: 10 },
					{ value: 'b', extraHours: 40 }
				]
			}
		]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('nobody can pay');
	});

	test('an OPTIONAL option may charge for every choice, since it can be skipped', () => {
		const result = parse([
			{
				...SIZE,
				required: false,
				choices: [
					{ value: 'a', extraHours: 10 },
					{ value: 'b', extraHours: 40 }
				]
			}
		]);
		expect(result.ok).toBe(true);
	});

	test('a text option cannot carry a surcharge', () => {
		const result = parse([
			{ type: 'text', key: 'note', label: 'note', required: false, extraHours: 5 }
		]);
		expect(result.ok).toBe(false);
	});
});

describe('surchargeFor', () => {
	const options = optionsOf([
		SIZE,
		{
			type: 'select',
			key: 'color',
			label: 'color',
			required: true,
			choices: [{ value: 'silver' }, { value: 'midnight' }]
		}
	]);

	test('adds nothing when the free choices are picked', () => {
		expect(surchargeFor(options, { size: 'thirteen', color: 'silver' })).toBe(0);
	});

	test('adds the picked choice', () => {
		expect(surchargeFor(options, { size: 'fifteen', color: 'silver' })).toBe(50 * 3600);
	});

	test('adds nothing for an option left unanswered', () => {
		expect(surchargeFor(options, {})).toBe(0);
	});

	/* Total rather than throwing: the purchase path has already refused anything
	   unrecognised, and the product page calls this on a half-filled form. */
	test('an unrecognised value adds nothing', () => {
		expect(surchargeFor(options, { size: 'seventeen' })).toBe(0);
	});

	test('a value the buyer invented cannot be charged for, because validation refuses it first', () => {
		const validated = validateOptions(options, { size: 'seventeen', color: 'silver' });
		expect(validated.ok).toBe(false);
	});
});

describe('priceRange', () => {
	test('a product with no priced options does not vary', () => {
		const options = optionsOf([
			{
				type: 'select',
				key: 'color',
				label: 'color',
				required: true,
				choices: [{ value: 'silver' }, { value: 'midnight' }]
			}
		]);
		const range = priceRange(275 * 3600, options);
		expect(range.varies).toBe(false);
		expect(range.min).toBe(275 * 3600);
		expect(range.max).toBe(275 * 3600);
	});

	test('the floor is the base and the ceiling is every dearest choice', () => {
		const options = optionsOf([
			SIZE,
			{
				type: 'select',
				key: 'ram',
				label: 'memory',
				required: true,
				choices: [{ value: '16' }, { value: '24', extraHours: 40 }]
			}
		]);
		const range = priceRange(275 * 3600, options);
		expect(range.min).toBe(275 * 3600);
		expect(range.max).toBe((275 + 50 + 40) * 3600);
		expect(range.varies).toBe(true);
	});
});

describe('the MacBook Air schema, end to end', () => {
	/* The configuration actually being listed, priced at $4/hr: $1,099 for the
	   13-inch rounds to 275h, and the 15-inch's extra $200 is exactly 50h more.
	   Both figures are whole hours because the catalog cannot express anything
	   else - the price field and extraHours are both whole hours - and 275 at
	   $4 is $1,100, a dollar over retail rather than a dollar under it. */
	const options = optionsOf([
		SIZE,
		{
			type: 'select',
			key: 'color',
			label: 'color',
			required: true,
			choices: [
				{ value: 'sky_blue', label: 'sky blue' },
				{ value: 'midnight', label: 'midnight' },
				{ value: 'starlight', label: 'starlight' },
				{ value: 'silver', label: 'silver' }
			]
		}
	]);
	const base = 275 * 3600;

	test('a 13-inch costs the sticker price', () => {
		const picked = { size: 'thirteen', color: 'midnight' };
		expect(validateOptions(options, picked).ok).toBe(true);
		expect(base + surchargeFor(options, picked)).toBe(275 * 3600);
	});

	test('a 15-inch costs 50 hours more, which is the $200 difference at $4/hr', () => {
		const picked = { size: 'fifteen', color: 'sky_blue' };
		expect(validateOptions(options, picked).ok).toBe(true);
		expect(base + surchargeFor(options, picked)).toBe(325 * 3600);
	});

	test('colour never changes the price', () => {
		for (const color of ['sky_blue', 'midnight', 'starlight', 'silver']) {
			expect(surchargeFor(options, { size: 'thirteen', color })).toBe(0);
		}
	});

	test('the card advertises 275h and the ceiling is 325h', () => {
		expect(priceRange(base, options)).toEqual({
			min: 275 * 3600,
			max: 325 * 3600,
			varies: true
		});
	});
});

describe('quantity arithmetic', () => {
	/* The flat cap of ten is gone - it capped the stackable grants at $50 an
	   order and protected nothing the stock and balance checks did not already
	   cover. What is left is exactness: a total that cannot be represented
	   precisely must be refused, because the orders table checks
	   total_price = unit_price * quantity in exact integers and would answer a
	   drifted total with a constraint violation rather than a sentence. */
	const safeTotal = (unitPrice: number, quantity: number): number | null => {
		const total = unitPrice * quantity;
		return Number.isSafeInteger(total) ? total : null;
	};

	test('an ordinary stack of grants is priced, not refused', () => {
		const hardwareGrant = 1 * 3600;
		/* Two hundred units of a $5 grant is $1,000 - a laptop - and used to be
		   twenty separate orders. */
		expect(safeTotal(hardwareGrant, 200)).toBe(200 * 3600);
	});

	test('a quantity far past any real balance still prices exactly', () => {
		expect(safeTotal(275 * 3600, 1_000_000)).toBe(275 * 3600 * 1_000_000);
	});

	test('a total too large to represent exactly is refused rather than rounded', () => {
		expect(safeTotal(275 * 3600, Number.MAX_SAFE_INTEGER)).toBeNull();
	});

	test('the boundary is exactly where precision ends', () => {
		expect(safeTotal(2, Math.floor(Number.MAX_SAFE_INTEGER / 2))).not.toBeNull();
		expect(safeTotal(2, Number.MAX_SAFE_INTEGER)).toBeNull();
	});
});
