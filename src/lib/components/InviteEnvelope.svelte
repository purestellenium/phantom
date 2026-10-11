<script module lang="ts">
	import { BAYER4 } from '$lib/dither-kit/pixel';

	// Match main's field shader: seven quantization steps through its warm grey ramp.
	const palette = Array.from({ length: 8 }, (_, i) => {
		const q = i / 7;
		const a = q < 0.5 ? [0.02, 0.02, 0.028] : [0.34, 0.32, 0.33];
		const b = q < 0.5 ? [0.34, 0.32, 0.33] : [0.94, 0.92, 0.89];
		const t = q < 0.5 ? q * 2 : (q - 0.5) * 2;
		return `rgb(${a.map((v, j) => Math.round((v + (b[j] - v) * t) * 255)).join(',')})`;
	});

	function texture(width: number, height: number, shade: (x: number, y: number) => number | null) {
		const paths = palette.map(() => '');
		for (let y = 0; y < height; y += 2) {
			for (let x = 0; x < width; x += 2) {
				const light = shade(x, y);
				if (light === null) continue;
				const value = Math.max(0, Math.min(1, light)) * 7;
				const level = Math.min(
					7,
					Math.floor(value) + (value % 1 > BAYER4[(y / 2) % 4][(x / 2) % 4] ? 1 : 0)
				);
				paths[level] += `M${x} ${y}h2v2h-2z`;
			}
		}
		return paths;
	}

	const paper = texture(
		500,
		280,
		(x, y) => 0.84 - y / 1700 - x / 5000 + 0.045 * Math.sin(x / 65 + y / 80)
	);
	const flap = texture(500, 160, (x, y) => 0.95 - y / 630 - Math.abs(x - 250) / 3000);
	const wax = texture(100, 100, (x, y) => {
		const dx = x - 50,
			dy = y - 50;
		const r = Math.hypot(dx, dy),
			angle = Math.atan2(dy, dx);
		const edge = 45 + 2 * Math.sin(angle * 7) + 1.5 * Math.cos(angle * 11);
		if (r > edge) return null;
		const bevel = Math.exp(-Math.pow((r - 39) / 3, 2));
		const ring = Math.exp(-Math.pow((r - 30) / 1.5, 2));
		return 0.36 - dx / 360 - dy / 300 + bevel * (0.26 - (dx + dy) / 160) - ring * 0.2;
	});
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { day, ORDER_STATE } from '$lib/status';
	import { resolve } from '$app/paths';
	import { EVENT_DAY } from '$lib/shop/invite';
	import { trackEvent } from '$lib/analytics/client';
	let {
		orderId,
		recipient,
		boughtAt,
		orderState,
		dealt = false,
		onarrive
	}: {
		orderId: string;
		recipient: string;
		boughtAt: Date;
		orderState: 'placed' | 'on_hold' | 'fulfilled' | 'unfulfilled';
		dealt?: boolean;
		onarrive?: () => void;
	} = $props();
	const id = $props.id();
	let group: HTMLDivElement;
	let dialog: HTMLDialogElement;
	let sheet: HTMLDivElement;
	let paperSlot: SVGForeignObjectElement;
	let letterGroup: SVGGElement;
	let art: SVGSVGElement;
	let marks: SVGRectElement[] = [];
	let extracted = $state(false);
	let closing = $state(false);
	// Keeps the envelope open after the dialog closes while the pointer is still on it.
	let held = $state(false);
	let lastPointer = { x: -1, y: -1 };

	const duration = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 560);
	const easeOut = (u: number) => 1 - Math.pow(1 - u, 4);
	const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

	// 0 is folded in the envelope, 1 is fully out. One number drives the sheet's
	// position, its clip and the dimming, so they can never get out of step.
	let progress = 0;
	let raf = 0;
	let run = 0;

	// The sheet's untransformed box inside the dialog.
	function natural() {
		const d = dialog.getBoundingClientRect();
		return {
			x: d.x + sheet.offsetLeft,
			y: d.y + sheet.offsetTop,
			w: sheet.offsetWidth,
			h: sheet.offsetHeight
		};
	}
	function apply(p: number) {
		const from = paperSlot.getBoundingClientRect();
		const n = natural();
		const sx0 = from.width / n.w;
		const sy0 = from.height / n.h;
		const tx = (from.x - n.x) * (1 - p);
		const ty = (from.y - n.y) * (1 - p);
		const sx = sx0 + (1 - sx0) * p;
		const sy = sy0 + (1 - sy0) * p;
		sheet.style.transform = `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`;
		// The envelope's front edge, measured live and mapped into the sheet's own
		// space, so the paper is cut exactly where the envelope covers it. Once the
		// sheet is well on its way the cut slides off the bottom to reveal the rest.
		const drop = n.h * 1.4 * Math.pow(Math.max(0, (p - 0.25) / 0.75), 2);
		const [l, m, r] = marks.map((mark) => {
			const box = mark.getBoundingClientRect();
			return {
				x: (box.x + box.width / 2 - n.x - tx) / sx,
				y: (box.y + box.height / 2 - n.y - ty) / sy + drop
			};
		});
		// Where the edge's two straight runs cross the sheet's own sides.
		const at = (x: number, a: typeof l, b: typeof l) =>
			a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
		sheet.style.clipPath = `polygon(0 0, 100% 0, 100% ${at(n.w, m, r)}px, ${m.x}px ${m.y}px, 0 ${at(0, l, m)}px)`;
		dialog.style.backgroundColor = `rgb(5 5 7 / ${0.78 * (1 - Math.pow(1 - p, 2))})`;
	}
	function animateTo(target: number, ease: (u: number) => number) {
		cancelAnimationFrame(raf);
		const mine = ++run;
		const start = progress;
		const total = duration() * Math.abs(target - start);
		const t0 = performance.now();
		return new Promise<boolean>((resolve) => {
			const step = (now: number) => {
				if (mine !== run) return resolve(false);
				const u = total === 0 ? 1 : Math.min(1, (now - t0) / total);
				progress = start + (target - start) * ease(u);
				apply(progress);
				if (u < 1) raf = requestAnimationFrame(step);
				else resolve(true);
			};
			raf = requestAnimationFrame(step);
		});
	}
	// Resolves once the element's transform has finished transitioning to `target`.
	function settled(el: Element, target: string) {
		return new Promise<void>((resolve) => {
			if (getComputedStyle(el).transform === target) return resolve();
			const done = () => {
				clearTimeout(timer);
				el.removeEventListener('transitionend', done);
				resolve();
			};
			const timer = setTimeout(done, 700);
			el.addEventListener('transitionend', done);
		});
	}
	async function openLetter() {
		if (extracted || closing) return;
		extracted = true;
		trackEvent('invite.ticket_opened', { state: orderState });
		held = false;
		rx = 0;
		ry = 0;
		await tick();
		// The sheet in the dialog is flat, so the envelope must be flat and open
		// before the hand-off or the paper would snap at the seam.
		await Promise.all([
			settled(art, 'matrix(1, 0, 0, 1, 0, 0)'),
			settled(letterGroup, 'matrix(1, 0, 0, 1, 0, -56)')
		]);
		if (!extracted) return;
		// Move this stable node so the invitation stays the same sheet during extraction.
		// eslint-disable-next-line svelte/no-dom-manipulating
		dialog.appendChild(sheet);
		dialog.showModal();
		progress = 0;
		apply(0);
		if (!(await animateTo(1, easeOut))) return;
		sheet.style.transform = '';
		sheet.style.clipPath = '';
	}
	async function closeLetter(event?: Event) {
		const pointerClose = event instanceof MouseEvent && event.detail > 0;
		if (closing || !extracted) return;
		closing = true;
		if (!(await animateTo(0, easeInOut))) return;
		sheet.style.transform = '';
		sheet.style.clipPath = '';
		dialog.style.backgroundColor = '';
		// Restore the node to its original Svelte-owned parent before the next interaction.
		// eslint-disable-next-line svelte/no-dom-manipulating
		paperSlot.appendChild(sheet);
		dialog.close();
		if (pointerClose && document.activeElement instanceof HTMLElement)
			document.activeElement.blur();
		const under = document.elementFromPoint(lastPointer.x, lastPointer.y);
		held = under !== null && group.contains(under);
		extracted = false;
		closing = false;
	}
	$effect(() => () => cancelAnimationFrame(raf));

	let rx = $state(0);
	let ry = $state(0);
	function tilt(event: PointerEvent) {
		lastPointer = { x: event.clientX, y: event.clientY };
		if (event.pointerType !== 'mouse' || extracted) return;
		const rect = art.getBoundingClientRect();
		rx = ((event.clientY - rect.top) / rect.height - 0.5) * -7;
		ry = ((event.clientX - rect.left) / rect.width - 0.5) * 9;
	}
</script>

<div
	role="group"
	class="invite-envelope"
	class:is-open={extracted || held}
	class:is-dealt={dealt}
	bind:this={group}
	onpointermove={tilt}
	onpointerleave={() => {
		rx = 0;
		ry = 0;
		held = false;
	}}
	onanimationend={(event) => {
		if (event.target === event.currentTarget) onarrive?.();
	}}
	style:--rx={`${rx}deg`}
	style:--ry={`${ry}deg`}
>
	<button
		class="envelope-trigger"
		type="button"
		onclick={openLetter}
		aria-label="Open your Phantom invitation"
		aria-haspopup="dialog"
	></button>
	<svg viewBox="40 74 520 321" fill="none" aria-hidden="true" class="envelope-art" bind:this={art}>
		<defs>
			<filter id={`${id}-shadow`} x="-30%" y="-30%" width="160%" height="180%"
				><feDropShadow
					dx="0"
					dy="3"
					stdDeviation="3"
					flood-color="#050507"
					flood-opacity=".35"
				/></filter
			>
			<clipPath id={`${id}-pocket`}><path d="M-60 -400H560V0H500L250 126L0 0H-60Z" /></clipPath>
			<clipPath id={`${id}-paper`}><path d="M0 0L250 126L500 0V280H0Z" /></clipPath>
			<clipPath id={`${id}-flap`}><path d="M0 0H500L274 151Q250 168 226 151Z" /></clipPath>
		</defs>
		<g class="envelope-object">
			<path class="ground-shadow" d="M66 371H534L556 385H46Z" fill="#050507" />
			<g transform="translate(50 90)">
				<path d="M0 0H500V280H0Z" fill="#575254" />
				<g class="back-flap" filter={`url(#${id}-shadow)`}>
					<g clip-path={`url(#${id}-flap)`}
						><path d="M0 0H500V170H0Z" fill={palette[5]} />{#each flap as d, i (i)}<path
								{d}
								fill={palette[i]}
							/>{/each}</g
					>
					<path d="M2 2H498" stroke="#efeae3" stroke-width="2" />
				</g>
				<g clip-path={`url(#${id}-pocket)`}
					><g class="letter" bind:this={letterGroup}
						><foreignObject x="28" y="12" width="444" height="660" bind:this={paperSlot}
							><div class="invitation-paper" bind:this={sheet} inert={!extracted}>
								<button
									type="button"
									class="paper-close"
									aria-label="Close invitation"
									onclick={closeLetter}
									disabled={closing}>×</button
								>
								<h2 id={`${id}-title`}>see you there</h2>
								<p class="paper-date">philadelphia · {EVENT_DAY}</p>
								<p class="recipient">{recipient}</p>
								<p>You're invited to Phantom, a three-day escape room hackathon in Philadelphia.</p>
								<dl>
									<div>
										<dt>when</dt>
										<dd>{EVENT_DAY}</dd>
									</div>
									<div>
										<dt>where</dt>
										<dd>Philadelphia, Pennsylvania</dd>
									</div>
									<div>
										<dt>included</dt>
										<dd>Your stay and food</dd>
									</div>
									<div>
										<dt>issued</dt>
										<dd>{day(boughtAt)}</dd>
									</div>
									<div>
										<dt>order</dt>
										<dd>{ORDER_STATE[orderState].label}</dd>
									</div>
								</dl>
								<a
									class="control-btn paper-order"
									href={resolve('/(app)/orders/[id]', { id: orderId })}>view your order</a
								>
							</div>
						</foreignObject></g
					></g
				>
				<g clip-path={`url(#${id}-paper)`}>
					<path d="M0 0H500V280H0Z" fill={palette[5]} />
					{#each paper as d, i (i)}<path {d} fill={palette[i]} />{/each}
					<path d="M0 0L259 164L0 280Z" fill="#575254" opacity=".2" />
					<path d="M500 0L241 164L500 280Z" fill="#050507" opacity=".18" />
					<path d="M0 280L234 129Q250 119 266 129L500 280" stroke="#575254" stroke-width="2" />
					<path
						d="M2 278L234 132Q250 122 266 132L498 278"
						stroke="#efeae3"
						stroke-opacity=".45"
						stroke-width="2"
					/>
				</g>
				<g class="flap" filter={`url(#${id}-shadow)`}>
					<g clip-path={`url(#${id}-flap)`}
						><path d="M0 0H500V170H0Z" fill={palette[5]} />{#each flap as d, i (i)}<path
								{d}
								fill={palette[i]}
							/>{/each}</g
					>
					<path d="M2 2H498" stroke="#efeae3" stroke-width="2" />
				</g>
				<g class="seal" filter={`url(#${id}-shadow)`}>
					<g transform="translate(200 105)">
						<circle cx="50" cy="50" r="43" fill={palette[2]} />
						{#each wax as d, i (i)}<path {d} fill={palette[i]} />{/each}
						<text x="50" y="68" text-anchor="middle" class="seal-mark" fill="#17161a">P</text>
						<text x="49" y="66" text-anchor="middle" class="seal-mark" fill="#bcb5b0">P</text>
					</g>
				</g>
				<g class="edge-marks">
					{#each [[0, 0], [250, 126], [500, 0]] as [x, y], i (i)}
						<rect x={x - 0.5} y={y - 0.5} width="1" height="1" bind:this={marks[i]} />
					{/each}
				</g>
			</g>
		</g>
	</svg>
</div>

<dialog
	bind:this={dialog}
	aria-labelledby={`${id}-title`}
	onpointermove={(event) => {
		lastPointer = { x: event.clientX, y: event.clientY };
	}}
	onclick={(event) => {
		if (event.target === dialog) void closeLetter(event);
	}}
	oncancel={(event) => {
		event.preventDefault();
		void closeLetter();
	}}
></dialog>

<style>
	.envelope-trigger {
		position: absolute;
		inset: 0;
		z-index: 1;
		border: 0;
		padding: 0;
		background: none;
		cursor: pointer;
	}
	.invite-envelope {
		position: relative;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		display: block;
		width: min(100%, 680px);
		margin: 0 auto;
		perspective: 1000px;
		text-decoration: none;
		-webkit-tap-highlight-color: transparent;
	}
	.envelope-art {
		display: block;
		width: 100%;
		overflow: visible;
		transform: rotateX(var(--rx)) rotateY(var(--ry));
		transition: transform 480ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	/* Flatten quickly on the way out: the hand-off waits for this. */
	.is-open .envelope-art {
		transition-duration: 160ms;
	}
	.envelope-object {
		transform-origin: 300px 240px;
		transform: translateY(0) rotate(-3deg);
		transition: transform 480ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.back-flap {
		transform-origin: 250px 0;
		transform: rotateX(0deg);
		transition: transform 240ms ease-in-out 240ms;
	}
	.flap {
		transform-origin: 250px 0;
		transform: rotateX(0deg);
		visibility: visible;
		transition:
			transform 240ms ease-in-out 240ms,
			visibility 0s 360ms;
	}
	.letter {
		transition: transform 240ms ease-in-out;
	}
	.invite-envelope:is(:hover, :has(.envelope-trigger:focus-visible), .is-open) .back-flap {
		transform: rotateX(180deg);
		transition-delay: 0s;
	}

	.edge-marks {
		fill: none;
		pointer-events: none;
	}
	.seal-mark {
		font:
			italic 56px var(--font-instrument),
			Georgia,
			serif;
	}
	.ground-shadow {
		filter: blur(7px);
		opacity: 0.4;
		transition: opacity 480ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.invite-envelope:is(:hover, :has(.envelope-trigger:focus-visible), .is-open) .envelope-object {
		transform: translateY(-4px) rotate(0deg);
	}
	.invite-envelope:is(:hover, :has(.envelope-trigger:focus-visible), .is-open) .flap {
		visibility: hidden;
		transform: rotateX(180deg);
		transition-delay: 0s, 120ms;
	}
	.invite-envelope:is(:hover, :has(.envelope-trigger:focus-visible), .is-open) .letter {
		transform: translateY(-56px);
		transition-delay: 240ms;
	}
	.invite-envelope:is(:hover, :has(.envelope-trigger:focus-visible), .is-open) .ground-shadow {
		opacity: 0.3;
	}
	.invite-envelope:focus-visible {
		outline: 2px dashed var(--ink);
		outline-offset: -8px;
	}
	.invite-envelope.is-dealt {
		animation: arrive 850ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
	}
	@keyframes arrive {
		from {
			opacity: 0;
			transform: translateY(-55px) rotate(-8deg);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.invite-envelope.is-dealt {
			animation: arrive 1ms;
		}
		.envelope-art {
			transform: none;
		}
		.envelope-art,
		.envelope-object,
		.back-flap,
		.flap,
		.letter,
		.ground-shadow {
			transition: none;
		}
	}
	dialog {
		border: 0;
		padding: 24px;
		background: transparent;
		color: #17161a;
		margin: 0;
		inset: 0;
		width: 100%;
		height: 100%;
		max-width: none;
		max-height: none;
		overflow: clip;
	}
	dialog[open] {
		display: grid;
		place-items: center;
	}
	:global(dialog > .invitation-paper) {
		width: min(444px, 100%);
		min-height: min(660px, calc(100dvh - 48px));
		max-height: calc(100dvh - 48px);
		overflow: auto;
		scrollbar-width: none;
	}

	dialog::backdrop {
		background: transparent;
	}
	/* Nothing inside the foreignObject may get a layer of its own. WebKit paints
	   a layered box in a foreignObject outside the SVG's coordinate space - no
	   viewBox scale, no clip-path - so on Safari the letter drew full size on
	   top of the envelope instead of tucked into it. A positioned box is what
	   makes the layer, so while the sheet sits in the envelope it is static and
	   the absolutely placed close button is gone rather than just hidden. Both
	   come back the moment the sheet moves into the dialog. */
	foreignObject .invitation-paper {
		position: static;
	}
	foreignObject .paper-close {
		display: none;
	}
	.paper-close:disabled {
		visibility: hidden;
	}
	.invitation-paper {
		color: #17161a;
		position: relative;
		box-sizing: border-box;
		min-height: 660px;
		display: flex;
		flex-direction: column;
		padding: 36px 30px 30px;
		background-color: #efeae3;
		background-image: var(--weave-bayer);
		box-shadow: 0 16px 48px rgb(5 5 7 / 0.35);
		transform-origin: top left;
	}
	.invitation-paper h2 {
		font:
			italic 48px var(--font-instrument),
			Georgia,
			serif;
		margin: 0 0 8px;
		text-align: center;
	}
	.invitation-paper p {
		margin: 0 0 20px;
		line-height: 1.5;
	}
	.recipient {
		font-family: var(--font-geist-pixel-square), monospace;
	}
	.paper-close {
		position: absolute;
		top: 8px;
		right: 8px;
		width: 40px;
		height: 40px;
		background: none;
		border: 0;
		color: #17161a;
		font-size: 28px;
		cursor: pointer;
	}
	dl {
		margin: 28px 0;
	}
	dl div {
		display: grid;
		grid-template-columns: 80px 1fr;
		gap: 16px;
		padding: 10px 0;
		border-top: 1px dashed #aaa49f;
	}
	dt {
		font-family: var(--font-geist-pixel-square), monospace;
	}
	dd {
		margin: 0;
	}
	.paper-date {
		margin-bottom: 64px;
		text-align: center;
		font-family: var(--font-geist-pixel-square), monospace;
		font-size: 13px;
	}
	.paper-order {
		width: 100%;
		justify-content: center;
		text-align: center;
		margin-top: auto;
	}

	.paper-order:focus-visible,
	.paper-close:focus-visible {
		outline: 2px dashed #575254;
		outline-offset: 3px;
	}
	@media (max-width: 480px) {
		dialog {
			padding: 16px;
		}
		.invitation-paper {
			padding: 44px 24px 28px;
		}
	}
</style>
