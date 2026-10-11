/**
 * A link typed without its scheme - "github.com/you/project", which is what
 * people paste - given `https://`, and anything else handed back as it was.
 *
 * Only when what is there has the shape of a host: a dot in its first
 * segment and no spaces. Something with a scheme of its own is never touched,
 * so `javascript:...` stays exactly what it was and is refused below as it
 * always was. Shared by `cleanUrl` and by every link field's `autoScheme`
 * (see $lib/auto-scheme), so the browser fixes the value the same way the
 * server would.
 */
export function withScheme(value: string | null | undefined): string {
	const trimmed = value?.trim() ?? '';
	if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
	return /^[^\s/]+\.[^\s/]+/.test(trimmed) ? `https://${trimmed}` : trimmed;
}

/**
 * Normalise a user-supplied URL, allowing ONLY http(s). A missing scheme is
 * filled in first (`withScheme`) rather than refused. Empty, malformed, or
 * any other scheme → null.
 *
 * This is the authoritative gate for every URL this application stores and
 * later renders. A project's repo and demo links reach reviewers and the
 * explore page as `<a href>`; a product's picture reaches the shop as
 * `<img src>`. Svelte escapes text and does not strip schemes from either, so
 * a stored `javascript:` URL is stored XSS the moment something renders it.
 *
 * The content security policy sits under this and is not a substitute for it.
 * `img-src` refuses a `javascript:` source today - but the policy protects the
 * ELEMENT, and nothing stops the same column being rendered into an `href` by
 * a page written next month. The column is the right place to be sure.
 *
 * At $lib rather than beside one of its callers because it has two that have no
 * business importing each other: projects and the shop catalog. One definition
 * is what stops those two drifting into different ideas of a safe URL - which
 * is exactly what had happened, the catalog having no idea at all.
 */
export function cleanUrl(value: string | null | undefined): string | null {
	const trimmed = withScheme(value);
	if (!trimmed) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}
