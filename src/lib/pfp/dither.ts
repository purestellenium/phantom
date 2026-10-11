/**
 * The platform's photograph filter, as a pixel loop, with one change.
 *
 * lib/components/Dither.svelte is this same filter as an SVG one, and it is
 * what every picture on the site actually renders through: grey it, add an
 * ordered Bayer threshold, then snap to the page's own ground-to-ink ramp. That
 * version is the right shape for the browser's compositor and the wrong shape
 * here, because a filter the compositor applies cannot be read back out. A
 * profile picture has to leave as a PNG, so the pixels have to be ours before
 * anything encodes them.
 *
 * This is therefore a deliberate SECOND implementation of one effect, and the
 * matrix, the arithmetic and the ramp below are copied from that file rather
 * than shared with it. An SVG filter states its matrix as a tiled image and its
 * quantiser as a discrete transfer table; neither is a number this loop could
 * import. They have to be kept in step by hand, and the test for "in step" is
 * that a picture dithered here and the same picture behind `filter:
 * url(#dither)` are made of the same tones.
 *
 * The one thing deliberately NOT copied is the cell size. A card photograph is
 * looked at three hundred pixels wide, where a 2px cell is the right pitch. An
 * avatar is looked at thirty-two pixels wide in a list of other people's faces,
 * and a 2px cell is a quarter of a cell by the time it has been scaled that far
 * down - which is a grey average, so the one thing that made the picture ours
 * is the first thing to go. Four keeps it, and keeps it legibly: at four the
 * matrix stops being a texture you infer and becomes one you can count.
 *
 * The TONES are the site's exactly, and were tried louder and put back: a
 * picture made here should be the same material as a picture on a card, it
 * should only survive being small.
 */

/** The 4×4 Bayer matrix, in the order Dither.svelte writes it, normalised to
 *  the 0–1 thresholds that file encodes as the greys of a tile. */
const BAYER = [
	[0, 8, 2, 10],
	[12, 4, 14, 6],
	[3, 11, 1, 9],
	[15, 7, 13, 5]
].map((row) => row.map((n) => (n + 0.5) / 16));

/** Output pixels per threshold cell - the one number here that is not the
 *  site's. Four rather than two, for the reason at the top: a 2px cell does not
 *  survive an avatar being scaled to the size a chat window shows it at.
 *
 *  It is the only dial worth turning if this wants to be blockier again. The
 *  tile is 4×4 cells, so this many pixels times four is the repeat - sixteen
 *  pixels of a 512px picture, which is about where a pattern reads as a pattern
 *  without the face inside it starting to come apart. */
const CELL = 4;

/**
 * The output levels - Dither.svelte's own table.
 *
 * This is the whole reason a photograph here sits ON the page rather than on top
 * of it: the darkest cell is the ground and the lightest is the ink, so the
 * picture never goes past either end of a page that has no pure black and no
 * pure white anywhere in it.
 */
const RAMP = [0.05, 0.16, 0.27, 0.4, 0.55, 0.72, 0.9];

/** The ramp's own middle - the tone `intensity` pivots the other six around, so
 *  turning it does not also turn brightness. Taken from the ends rather than
 *  written down, so it follows the ramp if the ramp is ever changed. */
const MID = (RAMP[0] + RAMP[RAMP.length - 1]) / 2;

/**
 * What the sliders on the page may move, and the deliberate limit on them.
 *
 * All three are TONE. None of them touches the structure of the dither - the
 * Bayer matrix, the cell pitch and the seven levels are what makes a picture
 * made here the same material as a picture on a card, and they are not a
 * setting. What a person gets to choose is where their own photograph sits
 * inside that material: a backlit face that came out as five cells of ground
 * needs lifting, and a flat grey one needs contrast, and neither is a reason to
 * make the pattern coarser.
 *
 * `brightness` and `contrast` act on the grey BEFORE the threshold, so they
 * change which level each pixel falls into. `intensity` acts on the levels
 * themselves, AFTER, so it changes what those levels are worth.
 */
export type Tone = {
	/** Added to the grey, in ramp units. Positive lifts the picture. */
	brightness: number;
	/** Multiplies the grey's distance from mid. 1 is the photograph's own. */
	contrast: number;
	/** How far the output levels spread from `MID`. 1 is the site's ramp. */
	intensity: number;
};

/** The site's own filter, exactly: the identity for all three. A picture made
 *  with these is byte-for-byte the picture this file made before there were any
 *  sliders, which is what keeps the "in step with Dither.svelte" test above
 *  meaningful. */
export const TONE_DEFAULT: Tone = { brightness: 0, contrast: 1, intensity: 1 };

/**
 * How far each may be pushed, and why it stops there.
 *
 * Brightness and contrast stop where a photograph stops being one: past about a
 * third of the ramp every mid-tone has been pushed onto an end, and the picture
 * is two levels and a silhouette.
 *
 * Intensity stops at 1.1 for a sharper reason - that is the last value at which
 * all seven levels are still seven different tones. The ramp pivots around its
 * middle, so above about 1.11 the darkest level has been pushed below black and
 * the lightest past white, and the two ends flatten into their neighbours: a
 * slider that quietly removes levels is the dithering control this is not meant
 * to be. Below 1 it washes toward flat grey, which is a look rather than a
 * fault, so it is allowed to go much further that way.
 */
export const TONE_RANGE = {
	brightness: { min: -0.35, max: 0.35, step: 0.01 },
	contrast: { min: 0.5, max: 1.8, step: 0.01 },
	intensity: { min: 0.3, max: 1.1, step: 0.01 }
} as const;

/** Whether a tone is the site's own - what the reset button greys itself out
 *  against. Exact equality is right here: every value comes off a range input
 *  with a hundredth-wide step, so there is no arithmetic to have drifted. */
export function toneIsDefault(tone: Tone): boolean {
	return (
		tone.brightness === TONE_DEFAULT.brightness &&
		tone.contrast === TONE_DEFAULT.contrast &&
		tone.intensity === TONE_DEFAULT.intensity
	);
}

/**
 * Grey, by the coefficients `feColorMatrix type="saturate" values="0"` uses.
 *
 * These are the sRGB luma weights, and they are applied to the encoded values
 * rather than to linearised ones because the filter carries
 * `color-interpolation-filters="sRGB"` - which is a deliberate choice over
 * there, not an oversight: linear-light averaging produces a visibly different
 * and much paler grey, and the ramp above was chosen against these numbers.
 */
const R = 0.213;
const G = 0.715;
const B = 0.072;

/**
 * Dither one frame in place. The alpha channel is left alone.
 *
 * `amp` is the one number derived rather than copied. Dither.svelte writes it
 * as a literal 1/6, which reads as a magic number and is not one: it is one step
 * of a seven-level ramp, and the threshold has to swing by exactly one step, or
 * the matrix cannot carry a tone between two levels at all. Taken from the
 * ramp's own length it stays true to that if the ramp is ever changed - where a
 * literal sixth would quietly stop dithering and leave a hard cut instead.
 *
 * `tone` is the page's three sliders, and defaults to the site's own filter, so
 * every caller that does not care reads exactly as it did before.
 */
export function ditherImageData(frame: ImageData, tone: Tone = TONE_DEFAULT): void {
	const levels = RAMP.length;
	const amp = 1 / (levels - 1);
	const bias = amp / 2;

	/* The ramp in bytes, once, rather than a multiply and a round per pixel -
	   which is also what makes `intensity` free: it moves the seven values in
	   this table and not one of the quarter-million pixels below. Clamped
	   because the table is bytes, though TONE_RANGE's ceiling is set so that a
	   slider cannot actually reach a value that needs it. */
	const out = RAMP.map((v) =>
		Math.max(0, Math.min(255, Math.round((MID + (v - MID) * tone.intensity) * 255)))
	);

	const px = frame.data;
	const width = frame.width;

	for (let i = 0, p = 0; i < px.length; i += 4, p++) {
		const x = p % width;
		const y = (p / width) | 0;

		const grey = (R * px[i] + G * px[i + 1] + B * px[i + 2]) / 255;

		/* Contrast around mid-grey rather than around zero, so it pivots the
		   picture instead of darkening it; brightness after, so the two read as
		   independent on the page even though they are one line of arithmetic.
		   Left unclamped: the quantiser's own clamp below is where a tone that
		   has been pushed past either end lands, and clamping twice would only
		   be slower. */
		const toned = (grey - 0.5) * tone.contrast + 0.5 + tone.brightness;

		const threshold = BAYER[((y / CELL) | 0) & 3][((x / CELL) | 0) & 3];

		/* The same arithmetic the filter's feComposite does: k2·grey + k3·t + k4. */
		const mixed = toned + amp * threshold - bias;

		/* And the same quantiser feComponentTransfer's discrete type applies:
		   floor(C · n), held inside the table. */
		let k = Math.floor(mixed * levels);
		if (k < 0) k = 0;
		else if (k > levels - 1) k = levels - 1;

		const value = out[k];
		px[i] = value;
		px[i + 1] = value;
		px[i + 2] = value;
	}
}
