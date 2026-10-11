/**
 * Everything that turns a picked photograph into the 512px square that leaves.
 *
 * Kept out of the page component because it is geometry and drawing rather than
 * interface: the component owns the pointer, the sliders and the buttons, and
 * calls in here for every pixel.
 */
import { TONE_DEFAULT, ditherImageData, type Tone } from './dither';

/** The edge of the picture that leaves, in pixels. Square, because that is what
 *  every service this is for crops an avatar to anyway - better to do it here,
 *  where the person can see which square they are choosing. */
export const SIZE = 512;

/** The square of the source that ends up in the frame, in source pixels. */
export type Crop = { sx: number; sy: number; side: number };

/** The side of the largest square the source can give - what zoom 1 means, and
 *  the reason zoom never has to go below it: at 1 the whole of the short edge
 *  is in frame, so there is no position that shows a gap. */
export function coverSide(image: HTMLImageElement): number {
	return Math.min(image.naturalWidth, image.naturalHeight);
}

/** How far in the zoom slider goes. Past about here a photograph off a phone is
 *  being enlarged more than it has pixels for, and the dither stops reading as
 *  texture and starts reading as damage. */
export const MAX_ZOOM = 4;

/**
 * The crop square for a zoom and a centre, held inside the source.
 *
 * The clamp is on the CENTRE rather than on the resulting rectangle, so a drag
 * that runs off the edge stops against it and stays there. Clamping the
 * rectangle instead lets the centre wander on past the edge while the picture
 * appears stuck, and the picture then does not move for however long it takes
 * to drag the centre back - which reads as the control having died.
 */
export function cropFor(
	image: HTMLImageElement,
	zoom: number,
	centreX: number,
	centreY: number
): Crop {
	const side = coverSide(image) / zoom;
	const half = side / 2;
	const sx = clamp(centreX, half, image.naturalWidth - half) - half;
	const sy = clamp(centreY, half, image.naturalHeight - half) - half;
	return { sx, sy, side };
}

export function clamp(value: number, low: number, high: number): number {
	return value < low ? low : value > high ? high : value;
}

/* ── the wordmark ────────────────────────────────────────────────────────── */

const WORD = 'PHANTOM';

/**
 * Where the wordmark sits and how big it is.
 *
 * All three are fractions of the frame rather than pixels - the centre of the
 * mark's ink, and its width. Fractions because they describe the same picture
 * whatever the frame turns out to be: the export is 512 today, and nothing
 * about a placement somebody chose should have to be rescaled if that changes.
 */
export type Mark = { x: number; y: number; width: number };

/**
 * The bounds of the mark's ink in frame pixels.
 *
 * Handed back by the render so the page can lay a drag handle exactly over the
 * wordmark and hold it inside the frame. It has to come from here because it is
 * not knowable without measuring the face: the width is asked for, but the
 * height is whatever the capitals of Instrument Serif italic turn out to be at
 * that width.
 */
export type MarkBox = { x: number; y: number; width: number; height: number };

/** How small and how large the mark may be set, as a fraction of the frame. The
 *  floor is where it stops reading at avatar size; the ceiling is where it has
 *  stopped being a mark on a picture and become the picture. */
export const MARK_MIN_WIDTH = 0.22;
export const MARK_MAX_WIDTH = 0.9;

/** Where a mark starts: centred, and low, which is where it sat when the
 *  placement was a choice between two fixed ones. */
export const MARK_DEFAULT: Mark = { x: 0.5, y: 0.89, width: 0.56 };

/** The wordmark's face, at a size. Instrument Serif italic is the wordmark -
 *  the nav, the landing title and the ticket all set it in this. */
function face(size: number): string {
	return `italic 400 ${size}px "Instrument Serif", ui-serif, Georgia, serif`;
}

/**
 * Wait for the wordmark's face before anything draws it.
 *
 * A canvas does not wait: `fillText` in a font the document has not finished
 * loading silently draws the fallback, and the result is a Georgia PHANTOM
 * baked into somebody's profile picture with nothing on screen to say it went
 * wrong. `document.fonts.load` resolves once THIS face at THIS size is usable,
 * which is the only signal that means what is needed here.
 */
export async function readyWordmark(): Promise<void> {
	try {
		await document.fonts.load(face(64), WORD);
	} catch {
		/* A refusal here means the face is unavailable, which the fallback in
		   `face()` already answers. Drawing the mark in a serif is worse than not
		   drawing it; failing the whole render is worse than both. */
	}
}

/**
 * The size and the box the mark works out to, measured rather than assumed.
 *
 * The type size comes from a measurement at a reference size and a scale, so
 * the mark is the WIDTH it was asked for whatever the face's metrics are. Text
 * metrics are linear in the size, so one measurement is enough to solve for it.
 *
 * The box is taken from the ink's own extent rather than the font's line box,
 * because the handle the page lays over this has to sit on the letters. PHANTOM
 * is all capitals, and its line box carries a descender space that nothing
 * draws into - a handle sized to that would hang visibly below the word.
 */
function layOut(
	ctx: CanvasRenderingContext2D,
	mark: Mark
): { box: MarkBox; size: number; baseline: number } | null {
	const REFERENCE = 100;
	ctx.font = face(REFERENCE);
	const reference = ctx.measureText(WORD).width;
	if (!reference) return null;

	const size = (REFERENCE * (SIZE * mark.width)) / reference;
	ctx.font = face(size);

	const metrics = ctx.measureText(WORD);
	const ascent = metrics.actualBoundingBoxAscent;
	const descent = metrics.actualBoundingBoxDescent;
	const height = ascent + descent;
	const width = metrics.width;

	const box: MarkBox = {
		x: SIZE * mark.x - width / 2,
		y: SIZE * mark.y - height / 2,
		width,
		height
	};
	return { box, size, baseline: box.y + ascent };
}

/**
 * Print the wordmark, after the dither rather than before it.
 *
 * Deliberately the one thing on the picture that is NOT made of cells, and more
 * deliberately since the cells got bigger. Run through the filter with
 * everything else it comes out as a wide serif chewed into 3px steps, which at
 * the size an avatar is actually displayed - thirty-two pixels beside a message
 * - is a grey smudge. Crisp, it still reads at that size, which is the entire
 * job of a mark.
 *
 * The dark outline under the light fill is what makes it survive a photograph
 * it knows nothing about, and it matters more now that the mark can be dragged
 * anywhere: a wordmark in the ink alone disappears against a bright sky, and one
 * in the ground disappears against a dark coat. An outline is also the honest
 * way to do it here - a soft drop shadow is a smooth gradient, and there is not
 * one of those anywhere else on this site.
 */
export function drawWordmark(ctx: CanvasRenderingContext2D, mark: Mark): MarkBox | null {
	const laid = layOut(ctx, mark);
	if (!laid) return null;

	ctx.font = face(laid.size);
	ctx.textAlign = 'center';
	ctx.textBaseline = 'alphabetic';
	ctx.lineJoin = 'round';
	ctx.lineWidth = laid.size * 0.09;
	ctx.strokeStyle = 'rgba(10, 10, 12, 0.8)';
	ctx.strokeText(WORD, SIZE * mark.x, laid.baseline);
	ctx.fillStyle = '#f2efe9';
	ctx.fillText(WORD, SIZE * mark.x, laid.baseline);

	return laid.box;
}

/* ── the whole picture ───────────────────────────────────────────────────── */

/**
 * Crop, resample, dither, mark - into a context that is already SIZE square.
 * Returns where the mark landed, or null when there is not one.
 *
 * `imageSmoothingQuality` matters more than it looks: the crop square is
 * usually LARGER than 512 and is being reduced, and the browser's cheap
 * resampler drops rows rather than averaging them. Fine detail then arrives at
 * the dither as aliasing, and the dither faithfully renders the aliasing.
 *
 * The tone is passed through to the dither and stops there. The wordmark is
 * printed afterwards in its own two fixed colours and is deliberately not
 * subject to it: it is the one thing on the picture that is not the
 * photograph, and a mark that dimmed with the sliders would be a mark somebody
 * could accidentally turn off.
 */
export function renderPicture(
	ctx: CanvasRenderingContext2D,
	image: HTMLImageElement,
	crop: Crop,
	mark: Mark | null,
	tone: Tone = TONE_DEFAULT
): MarkBox | null {
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.clearRect(0, 0, SIZE, SIZE);
	ctx.drawImage(image, crop.sx, crop.sy, crop.side, crop.side, 0, 0, SIZE, SIZE);

	const frame = ctx.getImageData(0, 0, SIZE, SIZE);
	ditherImageData(frame, tone);
	ctx.putImageData(frame, 0, 0);

	return mark ? drawWordmark(ctx, mark) : null;
}
