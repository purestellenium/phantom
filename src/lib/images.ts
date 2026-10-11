/**
 * What counts as a screenshot, on both sides of the wire.
 *
 * One number, read in three places, because the three have to agree: the
 * picker refuses an over-size file before it is sent, the CDN upload refuses it
 * again on the server, and the node server's BODY_SIZE_LIMIT is set above it
 * (see .env.example) so a file the picker accepts is never dropped while the
 * request body is still being read. That last failure is the one worth naming:
 * it happens before any action runs, so there is no form to put a message on -
 * only an error page.
 */

/** What a screenshot may be: a still image. Not a GIF, and not an animated
 *  PNG or WebP either (the upload checks the frames) - a reviewer, the
 *  explore card and the YSWS record all want one picture of the project. The
 *  file input offers these, and the upload accepts nothing else. */
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** The extensions a stored screenshot's address may end in - for a ship,
 *  which has only the address of a picture uploaded before this rule (or
 *  from somewhere else) to judge by. */
const STILL_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

/** Whether a screenshot's address names a still image (PNG, JPG or WebP). */
export function isStillImageUrl(url: string): boolean {
	let path: string;
	try {
		path = new URL(url).pathname;
	} catch {
		return false;
	}
	const ext = path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
	return STILL_EXTENSIONS.has(ext);
}

/** The refusal for anything else, worded once for the upload and the ship. */
export const NOT_STILL_IMAGE =
	'Your screenshot has to be a still image - a PNG, JPG or WebP, not a GIF or video.';

/** The CDN's own ceiling. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** The refusal, worded once: the picker shows it, the upload throws it, and the
 *  error page prints it when a body got past the picker anyway. */
export const IMAGE_TOO_LARGE = `That image is too large - ${MAX_IMAGE_BYTES / 1024 / 1024} MB max.`;
