import { cdnApiKey } from '$lib/server/env';
import { CdnError, uploadImageWithKey } from '$lib/server/cdn-upload';
import { staging } from '$lib/server/staging';

/**
 * Uploading a project screenshot to the Hack Club CDN.
 *
 * A screenshot is a FILE the owner picks, not a URL they paste - the same choice
 * OneKey made. Pasting a URL let the banner point at any host: a link that rots,
 * an image that swaps itself out after a reviewer has seen it, a tracking pixel
 * on someone else's server. Handing the bytes to cdn.hackclub.com instead gives
 * back a permanent https URL under an origin we control, which is what gets
 * stored and what a reviewer and the explore page render.
 *
 * The token stays on the server. This module is only ever reached from a form
 * action, the key is read through env.ts (never client-reachable), and the file
 * goes straight from our server to the CDN - the browser never sees the key and
 * the CDN never sees our session. The upload itself lives in cdn-upload.ts so
 * the seed can use it without SvelteKit's environment.
 */

export { CdnError, isCdnUrl } from '$lib/server/cdn-upload';

/** Upload an image and return its permanent CDN URL. Throws a CdnError for
 *  every failure, including the key not being configured. */
export async function uploadImageBlob(blob: Blob, filename: string): Promise<string> {
	const apiKey = cdnApiKey();
	/* Staging mode without a key stands in a placeholder, the one the local demo
	   seed uses, so a project can still be shipped. Not the picture that was
	   picked: that would mean storing it somewhere, and nothing here should. */
	if (!apiKey && staging) {
		return `https://picsum.photos/seed/${encodeURIComponent(`${filename}-${blob.size}`)}/1280/720`;
	}
	if (!apiKey) throw new CdnError('Screenshot uploads are not available right now.');
	return uploadImageWithKey(apiKey, blob, filename);
}
