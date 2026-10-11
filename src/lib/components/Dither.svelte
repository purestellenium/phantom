<script lang="ts">
	/**
	 * The ordered-dither filter every photograph on the platform goes through.
	 *
	 * A photo is the one thing on the page that arrives in continuous tone, and
	 * left alone it sits on the seven-level field like a sticker. This runs it
	 * through the same idea the field is built on: grey it, add a Bayer
	 * threshold tile, then snap to seven levels - so the picture is made of the
	 * same material as the ground it sits on.
	 *
	 * An SVG filter, so it is the browser's compositor doing the work once per
	 * paint and nothing runs per frame. Referenced as `filter: url(#dither)`.
	 */

	/* The 4x4 Bayer matrix, as an 8x8 tile of 2px cells - the field's own
	   cell size. Each cell's grey is its threshold, (n + 0.5) / 16. */
	const BAYER = [
		[0, 8, 2, 10],
		[12, 4, 14, 6],
		[3, 11, 1, 9],
		[15, 7, 13, 5]
	];
	const CELL = 2;
	const rects = BAYER.flatMap((row, y) =>
		row.map((n, x) => {
			const g = Math.round(((n + 0.5) / 16) * 255);
			return `<rect x="${x * CELL}" y="${y * CELL}" width="${CELL}" height="${CELL}" fill="rgb(${g},${g},${g})"/>`;
		})
	).join('');
	const size = BAYER.length * CELL;
	const tile = `data:image/svg+xml,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${rects}</svg>`
	)}`;

	/* The same tile as an alpha mask: white cells whose opacity is the
	   threshold. Added in premultiplied space it offsets colour AND coverage
	   per cell, which is what lets a soft edge or a glow dither instead of
	   fade. */
	const alphaRects = BAYER.flatMap((row, y) =>
		row.map((n, x) => {
			const a = ((n + 0.5) / 16).toFixed(4);
			return `<rect x="${x * CELL}" y="${y * CELL}" width="${CELL}" height="${CELL}" fill="#fff" fill-opacity="${a}"/>`;
		})
	).join('');
	const alphaTile = `data:image/svg+xml,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${alphaRects}</svg>`
	)}`;

	/* Seven output levels, spread over the ramp the page actually uses: ground
	   to ink rather than black to white. */
	const LEVELS = '0.05 0.16 0.27 0.4 0.55 0.72 0.9';
	/* For things that keep their colour: seven levels per channel, full range. */
	const FULL = '0 0.1667 0.3333 0.5 0.6667 0.8333 1';
	/* One level is 1/6 of the range, so the threshold tile is scaled to swing
	   the input by exactly one level either way. */
	const AMP = 1 / 6;
</script>

<svg aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0">
	<filter id="dither" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
		<feColorMatrix in="SourceGraphic" type="saturate" values="0" result="grey" />
		<feImage
			href={tile}
			x="0"
			y="0"
			width={size}
			height={size}
			preserveAspectRatio="none"
			result="cell"
		/>
		<feTile in="cell" result="threshold" />
		<feComposite
			in="grey"
			in2="threshold"
			operator="arithmetic"
			k1="0"
			k2="1"
			k3={AMP}
			k4={-AMP / 2}
			result="mixed"
		/>
		<feComponentTransfer in="mixed" result="quantised">
			<feFuncR type="discrete" tableValues={LEVELS} />
			<feFuncG type="discrete" tableValues={LEVELS} />
			<feFuncB type="discrete" tableValues={LEVELS} />
		</feComponentTransfer>
		<feComposite in="quantised" in2="SourceGraphic" operator="in" />
	</filter>
	<!-- The same idea in colour: no greying, and coverage is dithered too, so
	     a soft glow or a blurred edge comes out as ordered dots rather than a
	     fade. For the danger buttons. -->
	<filter
		id="dither-colour"
		x="-30%"
		y="-30%"
		width="160%"
		height="160%"
		color-interpolation-filters="sRGB"
	>
		<feImage
			href={alphaTile}
			x="0"
			y="0"
			width={size}
			height={size}
			preserveAspectRatio="none"
			result="cell"
		/>
		<feTile in="cell" result="threshold" />
		<feComposite
			in="SourceGraphic"
			in2="threshold"
			operator="arithmetic"
			k1="0"
			k2="1"
			k3={AMP}
			k4={-AMP / 2}
			result="mixed"
		/>
		<feComponentTransfer in="mixed">
			<feFuncR type="discrete" tableValues={FULL} />
			<feFuncG type="discrete" tableValues={FULL} />
			<feFuncB type="discrete" tableValues={FULL} />
			<feFuncA type="discrete" tableValues={FULL} />
		</feComponentTransfer>
	</filter>
</svg>
