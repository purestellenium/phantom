/**
 * Which guides this reader has finished, kept in their own browser.
 *
 * A convenience, not a record: nothing depends on it, so it lives in
 * localStorage rather than the database, and every read and write is wrapped -
 * a private window, blocked storage or a full quota just means no ticks, never
 * a broken page.
 */

const KEY = 'phantom:guides-read';

export function readGuides(): Set<string> {
	try {
		const raw = localStorage.getItem(KEY);
		const list: unknown = raw ? JSON.parse(raw) : [];
		return new Set(Array.isArray(list) ? list.filter((item) => typeof item === 'string') : []);
	} catch {
		return new Set();
	}
}

export function markGuideRead(slug: string): void {
	try {
		const read = readGuides();
		if (read.has(slug)) return;
		read.add(slug);
		localStorage.setItem(KEY, JSON.stringify([...read]));
	} catch {
		/* No storage: no tick. */
	}
}
