import { productKind, type ProductKind } from '$lib/server/db/schema';
import { parseJson } from '$lib/json';
import { FRAGMENT_SECONDS } from '$lib/fragments';
import type { ProductDraft } from '$lib/server/shop/catalog';

/**
 * Reading a product out of the form, shared by create and edit.
 *
 * The interesting decision is what this file does NOT do: it does not decide
 * whether an edit bumps the version. That is `updateProduct`'s job, made inside
 * the transaction by comparing against the row as it is at that moment - a
 * decision made out here, from the form, would be made against a row that may
 * have changed since it rendered, and two operators editing at once could both
 * conclude nothing material changed and skip the revision.
 *
 * Everything here is form parsing, which is genuinely all it should be.
 */

/**
 * A textarea of one value per line, as a list.
 *
 * Blank lines are dropped rather than kept as empty strings - an operator
 * pressing return twice between two URLs has not asked for a third picture -
 * and `\r` goes with them, because a textarea posted from Windows sends CRLF
 * and a trailing carriage return is not part of anybody's URL. What is left is
 * checked by `validateDraft`, which is where a line that is not a link earns
 * its sentence.
 */
function readLines(form: FormData, name: string): string[] {
	return String(form.get(name) ?? '')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
}

/** A number field, or null when it was left blank. Blank and zero are different
 *  answers for every numeric field on this form - blank stock means unlimited
 *  and zero means sold out - so an empty string must not become 0. */
function optionalInteger(form: FormData, name: string): number | null {
	const raw = String(form.get(name) ?? '').trim();
	if (!raw) return null;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : NaN;
}

function optionalDate(form: FormData, name: string): Date | null | undefined {
	const raw = String(form.get(name) ?? '').trim();
	if (!raw) return null;
	const parsed = new Date(raw);
	/* undefined signals "given but unreadable", which the caller turns into a
	   refusal. Returning null would silently mean "no date", and a typo would
	   quietly remove a deadline. */
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** The submitted kind, or the default. Anything unrecognised is not a kind. */
function readKind(value: FormDataEntryValue | null): ProductKind {
	const kind = String(value ?? 'digital');
	return productKind.enumValues.find((known) => known === kind) ?? 'digital';
}

/** A draft, or the sentence explaining why the form does not describe one. */
export type DraftResult = { ok: true; draft: ProductDraft } | { ok: false; error: string };

/**
 * The option schema is JSON typed into a textarea, so a parse failure is
 * routine rather than exceptional and has to come back as a sentence next to
 * the box. `parseOptionSchema` in $lib/shop/options.ts then checks its SHAPE -
 * this only checks that it is JSON at all.
 */
export function readDraft(form: FormData): DraftResult {
	/**
	 * Priced in FRAGMENTS, stored in seconds.
	 *
	 * Fragments because that is what the shop is denominated in (see $lib/fragments)
	 * - a sticker costs fifty fragments, and asking an operator
	 * to type 18000 is asking them to do the conversion the computer is for, in
	 * a box where a slipped zero is a product that costs ten times what it should
	 * and nothing on the page to catch it.
	 *
	 * Seconds because that is what the ledger is in, all the way down: a balance,
	 * an award, an order's frozen total, a refund. The unit changes at the form
	 * and nowhere else, which is why this conversion lives here rather than in
	 * the component - a page that reads a product back out gets seconds, like
	 * every other reader of the row.
	 *
	 * Whole fragments only: a price is a number people compare against their own
	 * balance, and a fraction of a fragment buys nothing but a rounding argument.
	 */
	const rawPrice = String(form.get('price') ?? '').trim();
	const priceFragments = Number(rawPrice);
	/* Read rather than truncated, unlike every other number on this form. The
	   forgiving parse turns a typed 2.5 into 2, which is harmless for a stock
	   count and is a silently different price here - and the one number on this
	   page that must never change by itself is the one people pay. */
	if (!rawPrice || !Number.isInteger(priceFragments) || priceFragments < 1) {
		return { ok: false, error: 'The price must be a whole number of fragments, and at least one.' };
	}
	const price = priceFragments * FRAGMENT_SECONDS;

	const stock = optionalInteger(form, 'stock');
	if (Number.isNaN(stock)) return { ok: false, error: 'Stock must be a whole number, or blank.' };

	const perUserLimit = optionalInteger(form, 'perUserLimit');
	if (Number.isNaN(perUserLimit)) {
		return { ok: false, error: 'The per-person limit must be a whole number, or blank.' };
	}

	/* Blank is zero, not null - unlike stock and the per-person limit above,
	   where blank means "no ceiling" and is a different answer from any number.
	   There is no unlimited padding: empty means none, which is the bleed the
	   card has always drawn. */
	const rawPadding = optionalInteger(form, 'imagePadding');
	if (Number.isNaN(rawPadding)) {
		return { ok: false, error: 'Image padding must be a whole number of pixels, or blank.' };
	}
	const imagePadding = rawPadding ?? 0;

	/* Blank is zero, the same as the padding: there is no "unpositioned", only
	   the default slot every untouched product shares. */
	const rawPosition = optionalInteger(form, 'position');
	if (Number.isNaN(rawPosition)) {
		return { ok: false, error: 'The position must be a whole number, or blank.' };
	}
	const position = rawPosition ?? 0;

	const availableFrom = optionalDate(form, 'availableFrom');
	if (availableFrom === undefined) {
		return { ok: false, error: 'That opening date could not be read.' };
	}
	const availableUntil = optionalDate(form, 'availableUntil');
	if (availableUntil === undefined) {
		return { ok: false, error: 'That closing date could not be read.' };
	}

	const rawSchema = String(form.get('optionSchema') ?? '').trim();
	const optionSchema = rawSchema ? parseJson(rawSchema) : null;
	if (optionSchema === undefined) {
		return { ok: false, error: 'The option schema is not valid JSON.' };
	}

	return {
		ok: true,
		draft: {
			slug: String(form.get('slug') ?? '').trim(),
			name: String(form.get('name') ?? '').trim(),
			description: String(form.get('description') ?? '').trim() || null,
			imageUrl: String(form.get('imageUrl') ?? '').trim() || null,
			imagePadding,
			position,
			images: readLines(form, 'images'),
			/* Checked against the enum, not cast to it. A string from a form
			   reaching a column typed as an enum is a 500 from Postgres rather than
			   a sentence from us. */
			kind: readKind(form.get('kind')),
			/* The empty option on the select is "unfiled", which is a real answer
			   rather than a missing one - so an empty string becomes null here, and
			   whether the id names a category that still exists is settled inside
			   the write transaction rather than out here against a list that
			   rendered some time ago. */
			categoryId: String(form.get('categoryId') ?? '').trim() || null,
			price,
			stock,
			perUserLimit,
			requiresEligibility: form.get('requiresEligibility') === 'on',
			optionSchema,
			availableFrom,
			availableUntil,
			/* One hidden field per picked country - see CountryPicker. Checked
			   against the list of codes in validateDraft, like everything else
			   here that reaches a column. */
			blockedCountries: form
				.getAll('blockedCountries')
				.map((value) => String(value).trim())
				.filter(Boolean),
			active: form.get('active') === 'on'
		}
	};
}

/** The stored schema, pretty-printed for editing. Falls back to the raw value
 *  if it will not stringify, so a row that somehow holds something unusual can
 *  still be seen and corrected rather than silently rendering as empty. */
export function schemaText(optionSchema: unknown): string {
	if (!optionSchema) return '';
	try {
		return JSON.stringify(optionSchema, null, 2);
	} catch {
		return String(optionSchema);
	}
}

/** The stored gallery, back in the textarea's own shape. */
export function galleryText(images: string[] | null | undefined): string {
	return (images ?? []).join('\n');
}

/** `datetime-local` wants `YYYY-MM-DDTHH:mm`. Rendered in UTC for the reason
 *  given on the settings page: the server's rendering is what comes back. */
export function forDateTimeInput(date: Date | null | undefined): string {
	return date ? date.toISOString().slice(0, 16) : '';
}

/** What the form needs to render a product, and nothing it must not send to
 *  the browser. Null is the create form. */
export type FormProduct = {
	name: string;
	slug: string;
	description: string;
	imageUrl: string;
	imagePadding: number | '';
	position: number | '';
	/** The gallery as the textarea holds it: one URL per line. */
	images: string;
	kind: ProductKind;
	/** Empty string for unfiled, which is what an unselected `<option value="">`
	 *  submits - so the form's idea of "no category" and the browser's are the
	 *  same one rather than two that have to be kept in step. */
	categoryId: string;
	price: number | '';
	stock: number | '';
	perUserLimit: number | '';
	availableFrom: string;
	availableUntil: string;
	/** Country codes it is hidden in. */
	blockedCountries: string[];
	active: boolean;
	requiresEligibility: boolean;
	optionSchema: string;
};

export const PRODUCT_KINDS = productKind.enumValues;

/** The shelves, as the form needs them: something to put in a select. Not the
 *  whole row - the create timestamp and the operator who made it are console
 *  facts, and nothing on this form shows them. */
export type FormCategory = { id: string; name: string };
