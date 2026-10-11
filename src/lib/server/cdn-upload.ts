/**
 * The upload itself, with the key handed in.
 *
 * Split from cdn.ts so it can run outside SvelteKit: cdn.ts reads the key
 * through env.ts, which resolves `$env`, and that module does not exist under
 * plain bun. The seed uploads through this; the app goes through cdn.ts,
 * which is this plus the key.
 */

import sharp from 'sharp';

import {
	ALLOWED_IMAGE_TYPES,
	IMAGE_TOO_LARGE,
	MAX_IMAGE_BYTES,
	NOT_STILL_IMAGE
} from '$lib/images';

const CDN_ORIGIN = 'https://cdn.hackclub.com/';
const UPLOAD_URL = 'https://cdn.hackclub.com/api/v4/upload';

/* What the CDN accepts, matched here so a bad file is refused with a legible
   message before it costs an upload round-trip. The numbers live in
   $lib/images because the picker in the browser refuses the same files, and
   two ceilings that drift apart is a file the form takes and the server
   will not. */
const ALLOWED_TYPES = new Set<string>(ALLOWED_IMAGE_TYPES);

/* Longer than an ordinary API call: an upload carries megabytes, and the failure
   we are guarding against is a slow connection, not an unresponsive server. */
const UPLOAD_TIMEOUT_MS = 30_000;

export class CdnError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, { cause: options?.cause });
		this.name = 'CdnError';
	}
}

/** Whether a stored URL actually came from the CDN. */
export function isCdnUrl(value: string): boolean {
	return value.startsWith(CDN_ORIGIN);
}

/* How much of the file has to be read to know what it is. WebP needs the most:
   its marker sits at byte 8, after RIFF and a four-byte length. */
const SNIFF_BYTES = 12;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
	if (bytes.length < offset + signature.length) return false;
	return signature.every((byte, i) => bytes[offset + i] === byte);
}

/** A cheap format check before decoding untrusted image data. */
export function sniffImageType(bytes: Uint8Array): string | null {
	/* FF D8 FF - SOI followed by the first marker. */
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
	/* The PNG signature, all eight bytes: the newline pairs in it are there to
	   catch mangling, so checking fewer would be checking less. */
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
	/* GIF87a or GIF89a. */
	if (
		startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61
	) {
		return 'image/gif';
	}
	/* RIFF....WEBP - a container tag, a length we do not care about, then the
	   form type at byte 8. RIFF alone is not enough; it is also AVI and WAV. */
	if (
		startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
		startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
	) {
		return 'image/webp';
	}
	return null;
}

/** JPEG's extension is `jpg`, not `jpeg`; everything else takes the subtype
 *  verbatim. Only used to give the uploaded file a sensible name. */
function extForType(contentType: string): string {
	if (contentType === 'image/jpeg') return 'jpg';
	return contentType.split('/')[1] ?? 'bin';
}

/** A filename safe to hand the CDN: stripped to a small alphabet, length-capped,
 *  and re-suffixed to match the actual type so a `.png` renamed to `.exe` cannot
 *  travel through. */
function safeFilename(name: string, contentType: string): string {
	const cleaned =
		(name || 'screenshot').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'screenshot';
	const dot = cleaned.lastIndexOf('.');
	const stem = dot === -1 ? cleaned : cleaned.slice(0, dot);
	return `${stem}.${extForType(contentType)}`;
}

/**
 * Upload an image with the given key and return its permanent CDN URL.
 *
 * Throws a CdnError for every failure - wrong type, too big, empty, not
 * actually an image, unreachable, a non-200, or a response without a usable
 * URL. Type, size and content are all checked here, before the request, so the
 * common mistakes cost nothing and a hostile file costs nothing either.
 */
export async function uploadImageWithKey(
	apiKey: string,
	blob: Blob,
	filename: string
): Promise<string> {
	const contentType = (blob.type ?? '').split(';')[0].trim().toLowerCase();
	if (!ALLOWED_TYPES.has(contentType)) {
		throw new CdnError(`That is not an image we accept (got: ${contentType || 'unknown'}).`);
	}
	if (blob.size === 0) throw new CdnError('That file is empty.');
	if (blob.size > MAX_IMAGE_BYTES) throw new CdnError(IMAGE_TOO_LARGE);

	/* The bytes have to agree with the label. Everything above this line is the
	   sender's account of the file; this is the file's own. A mismatch is
	   refused rather than corrected to what was sniffed - somebody sending a
	   zip called a PNG is not making a mistake we should quietly fix, and the
	   name we hand the CDN is built from the type, so trusting one and naming
	   from the other is how a `.png` ends up holding something else. */
	const sniffed = sniffImageType(new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer()));
	if (sniffed !== contentType) {
		throw new CdnError(
			sniffed
				? `That file says it is ${contentType} but it is ${sniffed}.`
				: 'That file is not an image.'
		);
	}

	let frames: number;
	try {
		const image = sharp(new Uint8Array(await blob.arrayBuffer()), {
			animated: true,
			failOn: 'warning'
		});
		await image.stats();
		frames = (await image.metadata()).pages ?? 1;
	} catch {
		throw new CdnError('That image could not be decoded.');
	}
	/* An animated PNG or WebP is a still type in name only. */
	if (frames > 1) throw new CdnError(NOT_STILL_IMAGE);
	const body = new FormData();
	body.append('file', blob, safeFilename(filename, contentType));

	let response: Response;
	try {
		response = await fetch(UPLOAD_URL, {
			method: 'POST',
			headers: { authorization: `Bearer ${apiKey}` },
			body,
			signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
		});
	} catch (cause) {
		throw new CdnError('Could not reach the Hack Club CDN. Try again in a moment.', { cause });
	}

	if (!response.ok) {
		/* The CDN's own prose goes to the LOG and not to the caller. It is upstream
		   text we did not write, and the surface it was reaching is a form error any
		   participant can produce by uploading a file - which is the shape of thing
		   the rest of this codebase keeps to the log and answers with a code. The
		   status is the part that is actually theirs to act on. */
		let detail = '';
		try {
			detail = (await response.text()).slice(0, 200);
		} catch {
			/* No body to read; the status still says enough. */
		}
		console.error(`[cdn] upload refused with ${response.status}${detail ? `: ${detail}` : ''}`);
		throw new CdnError(`The CDN refused the upload (${response.status}). Try again in a moment.`);
	}

	let url: string | null = null;
	try {
		const data = (await response.json()) as { url?: unknown };
		if (typeof data.url === 'string') url = data.url;
	} catch {
		/* Falls through to the throw below. */
	}
	if (!url || !isCdnUrl(url)) throw new CdnError('The CDN returned no usable URL.');
	return url;
}
