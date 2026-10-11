/**
 * What a product asks the buyer to choose, and whether what they chose is
 * allowed.
 *
 * This file exists because a purchase that records whatever `option_*` JSON it
 * is sent, without checking labels and values against the catalog, lets an
 * order carry a size that was never offered, a colour that does not exist, or
 * an arbitrary key someone typed into a request - and it is indistinguishable,
 * forever after, from a real selection.
 *
 * The fix is that a product declares a schema, the schema is frozen onto the
 * revision an order buys, and every submitted value is checked against THAT
 * revision inside the purchase transaction. Editing a product's options later
 * cannot retroactively invalidate an order that was valid when it was placed,
 * and cannot retroactively validate one that was not.
 *
 * Deliberately not `zod` or any other validator. The schema is authored by an
 * operator in a textarea and stored as JSON, so it is data at runtime rather
 * than a type at build time - a schema library would still need this exact
 * function to turn the stored JSON into one of its schemas, and the parse would
 * be the same code with a dependency in front of it. Two shapes, one page of
 * checks, and nothing to keep in step with a library's major version.
 *
 * No "server-only": the product form imports the types and the labels to render
 * the fields, and both halves must agree about what a schema is.
 */

import {
	isJsonArray,
	isJsonObject,
	readArray,
	readBoolean,
	readNumber,
	readString,
	type JsonValue
} from '$lib/json';
import { cleanUrl } from '$lib/url';

/** One of a select's choices. */
export type SelectChoice = {
	/** Stored in the order's `options` object. Machine-facing. */
	value: string;
	/** What the buyer reads. */
	label: string;
	/**
	 * The picture the gallery switches to when this one is picked, or null.
	 *
	 * Optional everywhere and meaningful only on the product page: a colour is
	 * worth seeing before you buy it, and a size is not. A choice without one
	 * leaves whatever is showing alone rather than falling back to the cover,
	 * so a product that photographs only two of its five colours does not blink
	 * back to the cover as you page through the other three.
	 *
	 * A URL rather than an index into `products.images`, deliberately. An index
	 * is shorter to write and silently repoints at a different photograph the
	 * first time somebody reorders the gallery - and the schema is FROZEN onto
	 * every order's revision, so the drift would be written into the record of
	 * what people bought. It does not have to be a URL that is in the gallery;
	 * one that is not simply is not reachable by browsing, which is a reasonable
	 * thing to want for a variant nobody should stumble on.
	 *
	 * http(s) only, enforced by the same `cleanUrl` every other stored URL in
	 * the application goes through - this one is rendered into an `<img src>`.
	 */
	image: string | null;

	/**
	 * What picking this adds to the product's price, in SECONDS.
	 *
	 * Authored as `extraHours` and converted here, which is the only place the
	 * two units meet. Operators type hours - the price field on the product form
	 * is whole hours for the reason it gives, and a schema asking for 144000
	 * next to a price asking for 40 is a trap - while everything downstream of
	 * this parse is seconds, like the ledger and like `products.price`. The unit
	 * is in the authored key's NAME so neither side has to be remembered.
	 *
	 * Never negative, and the base price is therefore always the cheapest
	 * configuration: the shop advertises a number and then only ever adds to it,
	 * rather than showing a price that some choices quietly undercut. A discount
	 * is expressible as a lower base with the other choices adding to it, which
	 * says the same thing and reads honestly on the card.
	 */
	extraSeconds: number;
};

/** A choice from a fixed list. A size, a colour, a region. */
export type SelectOption = {
	type: 'select';
	/** Stored as the key in the order's `options` object. Machine-facing. */
	key: string;
	/** What the buyer reads. */
	label: string;
	required: boolean;
	choices: SelectChoice[];
};

/** A short free-text answer. A username to put on something, a note. */
export type TextOption = {
	type: 'text';
	key: string;
	label: string;
	required: boolean;
	/** Bounded, always. An unbounded text field on a public form is a way to put
	 *  a megabyte in a jsonb column. */
	maxLength: number;
};

export type ProductOption = SelectOption | TextOption;

/** The absolute ceiling on a text option, whatever a product asks for. An
 *  operator who types 100000 into the form gets 500. */
export const MAX_TEXT_LENGTH = 500;

/** How many options one product may have. Not a technical limit - a form with
 *  thirty questions on it is a product that has been modelled wrong. */
export const MAX_OPTIONS = 12;

/**
 * The ceiling on one choice's surcharge, in hours.
 *
 * A bound rather than a policy: the figure is typed into a textarea, and the
 * difference between `40` and `400` is one keystroke that would otherwise
 * produce a listing nobody can afford and no error anywhere. Ten thousand hours
 * is far past any real upgrade and well short of anything that could overflow
 * the arithmetic it feeds.
 */
export const MAX_EXTRA_HOURS = 10_000;

/* ── parsing a stored schema ─────────────────────────────────────────────── */

export type ParseResult = { ok: true; options: ProductOption[] } | { ok: false; error: string };

/**
 * Turn stored JSON into options, or say why it cannot be.
 *
 * Strict, and it returns a message rather than throwing, because both callers
 * want the message: the operator form shows it next to the textarea, and the
 * purchase path refuses the sale with it. A schema that cannot be parsed must
 * never be treated as "no options" - that would silently make a required choice
 * optional, which is how a T-shirt gets ordered with no size.
 */
export function parseOptionSchema(stored: JsonValue | undefined): ParseResult {
	/* Null and absent are legitimate: most products ask nothing. */
	if (stored === null || stored === undefined) return { ok: true, options: [] };

	if (!isJsonArray(stored)) {
		return { ok: false, error: 'The option schema must be a JSON array.' };
	}
	if (stored.length > MAX_OPTIONS) {
		return {
			ok: false,
			error: `A product may have at most ${MAX_OPTIONS} options.`
		};
	}

	const options: ProductOption[] = [];
	const seen = new Set<string>();

	for (const [index, raw] of stored.entries()) {
		const at = `option ${index + 1}`;
		if (!isJsonObject(raw)) {
			return { ok: false, error: `${at} is not an object.` };
		}

		const key = readString(raw, 'key');
		if (key === null || !/^[a-z][a-z0-9_]{0,31}$/.test(key)) {
			return {
				ok: false,
				error: `${at} needs a key of lowercase letters, digits and underscores, starting with a letter.`
			};
		}
		if (seen.has(key)) {
			return { ok: false, error: `${at} repeats the key "${key}".` };
		}
		seen.add(key);

		const label = readString(raw, 'label');
		if (label === null) {
			return { ok: false, error: `${at} needs a label.` };
		}

		/* Absent means not required. A missing `required` that defaulted to true
       would make every schema written without it unfillable. */
		const required = readBoolean(raw, 'required') === true;

		const type = readString(raw, 'type');

		if (type === 'select') {
			const choices = readArray(raw, 'choices');
			if (choices === null || choices.length === 0) {
				return { ok: false, error: `${at} is a select and needs choices.` };
			}
			const parsed: SelectChoice[] = [];
			const values = new Set<string>();
			for (const choice of choices) {
				if (!isJsonObject(choice)) {
					return { ok: false, error: `${at} has a choice that is not an object.` };
				}
				const value = readString(choice, 'value');
				if (value === null) {
					return { ok: false, error: `${at} has a choice with no value.` };
				}
				if (values.has(value)) {
					return { ok: false, error: `${at} repeats the choice "${value}".` };
				}
				values.add(value);

				/* Absent is the ordinary case and means "leave the picture alone".
				   Present and unusable is a MISTAKE and is said out loud rather than
				   dropped: a picture that silently never appears is the kind of bug
				   somebody spends an afternoon on, which is the same reasoning
				   validateDraft applies to the cover. */
				const rawImage = readString(choice, 'image');
				const image = rawImage === null ? null : cleanUrl(rawImage);
				if (rawImage !== null && image === null) {
					return {
						ok: false,
						error: `${at} has a choice "${value}" whose image is not an http or https URL.`
					};
				}

				/* Absent is free, which is what most choices are. Present and
				   unusable is refused rather than coerced: a surcharge that silently
				   became zero is money the shop stops charging and nothing says so. */
				const extraHours = readNumber(choice, 'extraHours');
				if (extraHours !== null) {
					if (!Number.isInteger(extraHours) || extraHours < 0) {
						return {
							ok: false,
							error: `${at} has a choice "${value}" whose extraHours is not a whole number of hours at or above zero.`
						};
					}
					if (extraHours > MAX_EXTRA_HOURS) {
						return {
							ok: false,
							error: `${at} has a choice "${value}" adding more than ${MAX_EXTRA_HOURS} hours.`
						};
					}
				}

				parsed.push({
					value,
					label: readString(choice, 'label') ?? value,
					image,
					extraSeconds: (extraHours ?? 0) * 3600
				});
			}

			/**
			 * A required option has to have a free choice, or the advertised price
			 * is one nobody can pay.
			 *
			 * The sticker price is the base and every choice only adds to it, so
			 * the base is what the cheapest configuration costs - that is the whole
			 * contract the card's price makes with a reader. If every choice on a
			 * REQUIRED option charges something, the cheapest configuration costs
			 * more than the base and the card is advertising a price that does not
			 * exist. The fix is always the same - lower the base by the smallest
			 * surcharge and take that much off each choice - so the refusal says
			 * it rather than leaving the operator to work it out.
			 *
			 * Only for required options: an optional one can be left unanswered,
			 * which costs nothing, so the base stays reachable however it is
			 * priced.
			 */
			if (required && parsed.every((choice) => choice.extraSeconds > 0)) {
				const least = Math.min(...parsed.map((choice) => choice.extraSeconds)) / 3600;
				return {
					ok: false,
					error:
						`${at} is required and every choice adds to the price, so the listed price is one ` +
						`nobody can pay. Add ${least} to the product's price and take ${least} off each choice.`
				};
			}

			options.push({ type: 'select', key, label: label.trim(), required, choices: parsed });
			continue;
		}

		if (type === 'text') {
			/* Refused rather than ignored, for the reason the choices above give
			   about their own: free text has nothing to price off, so a surcharge
			   here could only ever be a misunderstanding, and one that silently
			   charged nothing. */
			if (readNumber(raw, 'extraHours') !== null) {
				return { ok: false, error: `${at} is a text option and cannot carry extraHours.` };
			}
			const declared = readNumber(raw, 'maxLength');
			const maxLength =
				declared !== null && Number.isInteger(declared) && declared > 0
					? Math.min(declared, MAX_TEXT_LENGTH)
					: MAX_TEXT_LENGTH;
			options.push({ type: 'text', key, label: label.trim(), required, maxLength });
			continue;
		}

		return {
			ok: false,
			error: `${at} has type ${JSON.stringify(raw['type'])}; it must be "select" or "text".`
		};
	}

	return { ok: true, options };
}

/* ── what a configuration costs ──────────────────────────────────────────── */

/**
 * What the chosen options add to the base price, in seconds.
 *
 * Takes VALIDATED values - the output of `validateOptions` - so a value that is
 * not one of the declared choices cannot reach here and be charged for. A value
 * this does not recognise adds nothing rather than throwing, which is the total
 * behaviour the rest of this module keeps: the purchase path has already
 * refused anything unrecognised, and the product page calls this on every
 * keystroke with a half-filled form.
 *
 * Callers on the purchase path must pass the options parsed from the FROZEN
 * revision, exactly as they already do for validation. Pricing a sale off the
 * live product while validating it against the revision would be two different
 * answers to "what is this product", which is the bug the revision exists for.
 */
export function surchargeFor(
	options: ProductOption[],
	values: Record<string, string | undefined>
): number {
	let extra = 0;
	for (const option of options) {
		if (option.type !== 'select') continue;
		const chosen = values[option.key];
		if (!chosen) continue;
		extra += option.choices.find((choice) => choice.value === chosen)?.extraSeconds ?? 0;
	}
	return extra;
}

/**
 * The cheapest and dearest this product can be configured to cost.
 *
 * `min` is the base by construction - surcharges are never negative and a
 * required option always has a free choice, both enforced at parse - so it is
 * returned rather than computed, and `varies` is what a card reads to decide
 * between "40h" and "from 40h".
 *
 * `max` assumes the dearest choice of every option, including the optional
 * ones, which is the honest ceiling even though a buyer who answers nothing
 * optional would pay less.
 */
export function priceRange(
	basePrice: number,
	options: ProductOption[]
): { min: number; max: number; varies: boolean } {
	let max = basePrice;
	for (const option of options) {
		if (option.type !== 'select') continue;
		max += Math.max(0, ...option.choices.map((choice) => choice.extraSeconds));
	}
	return { min: basePrice, max, varies: max > basePrice };
}

/* ── validating a submission ─────────────────────────────────────────────── */

export type ValidationResult =
	{ ok: true; values: Record<string, string> } | { ok: false; error: string };

/**
 * Check what the buyer sent against what the product asks for.
 *
 * Two properties beyond the obvious, and both are the point:
 *
 * UNKNOWN KEYS ARE REFUSED, not ignored. Ignoring them means a request with
 * `size=xl&size_actually=xxxl` succeeds and the order records only what the
 * schema knew about - which reads afterwards as if nothing unusual was
 * submitted. Refusing means the attempt is visible.
 *
 * THE RETURNED OBJECT IS REBUILT from the schema rather than filtered from the
 * input. Filtering keeps the input's own key order, prototype and any exotic
 * property somebody managed to attach; rebuilding produces a plain object with
 * exactly the declared keys, which is what goes into the column.
 */
export function validateOptions(
	options: ProductOption[],
	submitted: Record<string, string | undefined>
): ValidationResult {
	const declared = new Set(options.map((option) => option.key));
	for (const key of Object.keys(submitted)) {
		if (!declared.has(key)) {
			return { ok: false, error: `"${key}" is not an option on this product.` };
		}
	}

	const values: Record<string, string> = {};

	for (const option of options) {
		const value = submitted[option.key]?.trim() ?? '';

		if (!value) {
			if (option.required) {
				return { ok: false, error: `${option.label} is required.` };
			}
			/* Omitted rather than stored as an empty string. An absent key and a key
         holding "" read differently in every later query, and only one of them
         is true. */
			continue;
		}

		if (option.type === 'select') {
			if (!option.choices.some((choice) => choice.value === value)) {
				return {
					ok: false,
					error: `${value} is not one of the choices for ${option.label}.`
				};
			}
			values[option.key] = value;
			continue;
		}

		if (value.length > option.maxLength) {
			return {
				ok: false,
				error: `${option.label} must be ${option.maxLength} characters or fewer.`
			};
		}
		values[option.key] = value;
	}

	return { ok: true, values };
}

/** The submitted options as a plain object, pulled out of a form body. Kept
 *  here so the prefix is defined once and the purchase path does not have to
 *  know it. */
export const OPTION_FIELD_PREFIX = 'option_';

export function readOptionFields(form: FormData): Record<string, string> {
	return Object.fromEntries(
		[...form.entries()].flatMap(([name, value]) =>
			name.startsWith(OPTION_FIELD_PREFIX) && typeof value === 'string'
				? [[name.slice(OPTION_FIELD_PREFIX.length), value]]
				: []
		)
	);
}

/** Render an order's frozen options for a human. Falls back to the raw key when
 *  the schema no longer describes it, which happens when a product's options
 *  changed after the order was placed - the order keeps what it bought, and
 *  saying `size: xl` is more honest than hiding a value we cannot label. */
export function describeOptions(
	options: ProductOption[],
	values: Record<string, string> | null
): { label: string; value: string }[] {
	if (!values) return [];
	return Object.entries(values).map(([key, value]) => {
		const option = options.find((candidate) => candidate.key === key);
		if (!option) return { label: key, value };
		if (option.type === 'select') {
			const choice = option.choices.find((entry) => entry.value === value);
			return { label: option.label, value: choice?.label ?? value };
		}
		return { label: option.label, value };
	});
}
