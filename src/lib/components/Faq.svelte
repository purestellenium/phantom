<script lang="ts">
	/**
	 * The FAQ, as a band of the page.
	 *
	 * It used to be a panel: a button at the end of the lede dissolved the bell out
	 * of the hero and the questions in over the same beat. That worked while the
	 * hero was the whole page. It is not any more - there are five bands under it
	 * now, and a set of questions that can only be reached by finding a control in
	 * a sentence is the one thing on a scrolling page nobody scrolls to. So it
	 * stands where the rest of the page stands and you arrive at it the way you
	 * arrive at everything else.
	 *
	 * What survives the move is the accordion, which is what a FAQ is: every
	 * question stays where it is and the answer opens under the one you pressed,
	 * one at a time.
	 *
	 * The slide is stepped and driven from JS rather than by a CSS transition. The
	 * rasteriser reads an element by toggling its paint off and back on inside one
	 * task, so a transition is caught part way and draws nothing - but a run of
	 * discrete heights is a run of DOM writes, and each one is a change
	 * DitheredText can see and redraw. Eight steps is enough to read as movement
	 * and few enough that a phone does not feel them.
	 */

	import { trackEvent } from '$lib/analytics/client';

	type FaqItem = { q: string; a: string };

	const FAQS: FaqItem[] = [
		{
			q: 'what is phantom?',
			a: "phantom is a 3-day escape room hackathon in Philadelphia, PA, where technical teens will build projects together, discover secrets hidden around the venue, and solve puzzles designed to get them out of their comfort zone. it's also completely free to attend - just code creative and unique projects for 50 hours in order to qualify for an invite to the event."
		},
		{
			q: 'can beginners come?',
			a: "of course! it'll take a bit of effort, but we have tons of resources and tutorials you can use to learn coding and get ready for the big event!"
		},
		{
			q: "who's eligible to participate?",
			a: "anyone aged 13–18 inclusive is eligible. there's no need to have shipped before, and no need to bring a team - plenty of people arrive solo and leave with friends for life."
		},
		{
			q: 'is this free?',
			a: 'if you qualify for an invite to the event, your stay and food in philadelphia will be completely covered! as for flights, once you reach 50 hours, you can code extra for flight stipends, at a rate of $8.50/hr.'
		},
		{
			q: 'what are fragments?',
			a: "fragments are what the shop runs on. every hour of coding that's approved earns 10 fragments - one for every 6 minutes - and each approval pays out in whole fragments, rounded down. spend 500 on your invite to the event, or on prizes in the shop."
		},
		{
			q: '"escape room hackathon?"',
			a: 'phantom will be a first-of-its-kind event. puzzles will be scattered across the venue for you to discover as you code and unlock different areas and clues. more details about the event will be revealed closer to the event date.'
		},
		{
			q: 'when is it?',
			a: "february 12-14, 2027 - you'll arrive friday and escape sunday night, with a full weekend of building, puzzles, and secrets to uncover in between."
		},
		{
			q: 'what is Hack Club?',
			a: "Hack Club is a 501(c)(3) nonprofit (ein: 81-2908499) that helps high school students learn to code and build projects. we're the largest teen-led coding community, with over 50,000 students building projects with their friends in Hack Club each year. in the past, we've run events like juice (a 2 month game jam leading to a pop-up cafe in shanghai, china), Hack Club: the game (a 2-day territory capture game across the entirety of manhattan, nyc), and undercity (a 4-day hardware hackathon at github hq)!"
		},
		{
			q: 'i have more questions...',
			a: 'feel free to ask us on the Hack Club slack, in the #phantom-help channel, or email us at phantom@hackclub.com.'
		}
	];

	const GROW_MS = 200;
	const GROW_STEPS = 8;
	const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);

	let selected = $state<number | null>(null);

	/* Which answer is mounted (`shown`) is not the same as which one is wanted
	   (`selected`): a section on its way out has to stay in the DOM until it has
	   finished closing. `grow` is that one section's height as a fraction of its
	   natural height, and switching questions runs it down to nothing before the
	   next one is mounted and run back up. */
	let shown = $state<number | null>(null);
	let grow = $state(0);
	// growRef stays non-reactive on purpose, mirroring the React ref: Effect B
	// reads it once when it starts, and if it were reactive the per-frame writes
	// in tick() would restart the animation effect every single frame.
	let growRef = 0;
	// heightRef is read in the template and answerRef inside an effect, so both are
	// $state - the equivalent of a React ref that a reactive read depends on.
	let heightRef = $state(0);
	let answerRef = $state<HTMLDivElement | undefined>(undefined);

	// Pick a question, or close the open one by pressing it again.
	const pick = (i: number) => {
		if (selected !== i) trackEvent('faq.opened', { question: FAQS[i].q });
		selected = selected === i ? null : i;
	};

	/* Measured, not guessed at, and re-measured every time a section is mounted:
	   the answers are different lengths and they rewrap with the column. Taken
	   from the padded inner box while the wrapper is still at zero height -
	   overflow does not constrain what is inside it, so the natural height is
	   there to be read before anything has been shown. */
	$effect(() => {
		if (shown === null) return;
		heightRef = answerRef?.offsetHeight ?? 0;
		growRef = 0;
		grow = 0;
	});

	/* The slide. One section is ever moving: the mounted one, up if it is the one
	   wanted and down if it is not. Landing at zero is what hands the slot to the
	   next question, so switching reads as one closing and another opening rather
	   than a swap. */
	$effect(() => {
		if (shown === null) {
			if (selected !== null) shown = selected;
			return;
		}
		const to = shown === selected ? 1 : 0;
		const from = growRef;
		if (from === to) {
			if (to === 0) shown = selected;
			return;
		}

		let raf = 0;
		let start = 0;
		const span = GROW_MS * Math.abs(to - from);
		const tick = (now: number) => {
			if (!start) start = now;
			const p = Math.min(1, (now - start) / span);
			const v = from + (to - from) * easeOut(p);
			growRef = v;
			grow = Math.round(v * GROW_STEPS) / GROW_STEPS;
			if (p < 1) raf = requestAnimationFrame(tick);
			else if (to === 0) shown = selected;
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	});
</script>

<section class="band band-faq" id="faq-section" aria-labelledby="faq">
	<h2 class="band-title" id="faq">questions?</h2>

	<div class="faq-list">
		{#each FAQS as f, i (f.q)}
			{@const isOpen = i === selected}
			<div class="faq-item" data-open={isOpen}>
				<button
					type="button"
					class="faq-q"
					aria-expanded={isOpen}
					aria-controls={`faq-a-${i}`}
					data-current={isOpen}
					onclick={() => pick(i)}
				>
					<span class="faq-q-idx">{String(i + 1).padStart(2, '0')}</span>
					<span class="faq-q-label">{f.q}</span>
					<!-- The state, said twice over: the sign changes and the row's
					     material steps up a level of the ramp. -->
					<span class="faq-q-sign" aria-hidden="true">{isOpen ? '−' : '+'}</span>
				</button>
				{#if shown === i}
					<div
						class="faq-a"
						id={`faq-a-${i}`}
						role="region"
						style:height={grow >= 1 ? 'auto' : `${Math.round(heightRef * grow)}px`}
						style:opacity={grow}
					>
						<div class="faq-a-inner" bind:this={answerRef}>
							<p class="faq-prose">{f.a}</p>
						</div>
					</div>
				{/if}
			</div>
		{/each}
	</div>
</section>
