/**
 * A table of strings, as a file a spreadsheet will open.
 *
 * RFC 4180 quoting, and one thing on top of it that is not cosmetic: a cell
 * whose first character is `=`, `+`, `-`, `@`, a tab or a carriage return is
 * prefixed with an apostrophe. Excel, Sheets and LibreOffice all read a leading
 * `=` as the start of a formula, so a reviewer who types `=1+1` into a
 * justification has written a formula into every operator's spreadsheet - and
 * the interesting versions of that reach out over the network rather than doing
 * arithmetic. The export carries reviewer prose and project names, all of which
 * came from somebody's keyboard, so it is exactly the shape of data this
 * applies to.
 *
 * The apostrophe is consumed by the spreadsheet as "this is text" and shows up
 * in nothing that reads the file as CSV, which is the trade: a visible quote in
 * one rare cell, against a formula in any of them.
 */

const RISKY = /^[=+\-@\t\r]/;

function cell(value: string): string {
	const guarded = RISKY.test(value) ? `'${value}` : value;
	/* Quote when the cell contains anything the parser would otherwise treat as
	   structure. Doubling the quote is how RFC 4180 escapes one. */
	return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** A value as the text of a cell. Null and undefined are an empty cell rather
 *  than the words "null" and "undefined", which is what a reader summing a
 *  column needs them to be. */
export function csvValue(value: string | number | boolean | Date | null | undefined): string {
	if (value === null || value === undefined) return '';
	if (value instanceof Date) return value.toISOString();
	return String(value);
}

/** Header row plus body, CRLF-separated as the RFC asks. */
export function toCsv(
	header: readonly string[],
	rows: readonly (readonly (string | number | boolean | Date | null | undefined)[])[]
): string {
	const lines = [header.map(cell).join(',')];
	for (const row of rows) lines.push(row.map((value) => cell(csvValue(value))).join(','));
	return lines.join('\r\n') + '\r\n';
}

/**
 * The CSV as a download.
 *
 * `no-store` because every one of these is a snapshot of a moving table behind
 * a capability check, and a cached copy in a shared proxy is the kind of thing
 * that outlives the permission that fetched it. The BOM is there so Excel on
 * Windows reads the file as UTF-8 rather than as the local code page, which is
 * the difference between a name rendering and a name turning into mojibake.
 */
export function csvResponse(filename: string, body: string): Response {
	return new Response('﻿' + body, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${filename}"`,
			'cache-control': 'no-store'
		}
	});
}

/** `reviewers-2026-09-13.csv`. The date is in the name because these get saved
 *  in a folder and compared, and two files called `reviewers.csv` do not. */
export function stampedName(stem: string): string {
	return `${stem}-${new Date().toISOString().slice(0, 10)}.csv`;
}
