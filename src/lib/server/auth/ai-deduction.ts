/**
 * How AI-coded time counts toward the hours tile on the home page.
 *
 * Time in Hackatime's "ai coding" category counts at a third: the tile shows
 * the raw total minus two thirds of the AI split. Ships and reviews still
 * freeze and grant the raw claim, so the tile deliberately reads lower than a
 * submission's frozen claim wherever AI did some of the typing. The fraction
 * lives here so the home page and the fetch below cannot drift apart.
 */
export const AI_KEPT_FRACTION = 1 / 3;

/**
 * The adjusted total from a sanitized pair.
 *
 * Takes inputs with `0 <= aiSeconds <= totalSeconds` and both non-negative.
 * Clamping a skewed pair (separate stats calls racing, a hand-rolled test) is
 * the caller's job at the fetch boundary, where the race can be named - this
 * function does the arithmetic and nothing else.
 */
export function applyAiDeduction(totalSeconds: number, aiSeconds: number): number {
	return Math.max(0, Math.round(totalSeconds - aiSeconds + aiSeconds * AI_KEPT_FRACTION));
}
