<script lang="ts">
	/**
	 * Starting a project, one question at a time - the screens, wherever they
	 * are shown.
	 *
	 * Two places start a project: the projects page, which puts these screens
	 * in a fullscreen dialog (NewProjectFlow.svelte), and the last step of
	 * onboarding, which lays them out inline. They are one component so that
	 * the first project somebody makes and every one after it are made the same
	 * way - the same questions, in the same order, looking the same.
	 *
	 * It asks in the order people actually think: what it is made of, what it
	 * is, what it is called, then anything worth pointing at, then a last look.
	 * A blank "name" box first is exactly the question somebody with half an
	 * idea cannot answer yet.
	 *
	 * The screens are this component's own state, not routes: nothing is written
	 * until the last press, so somebody who wanders off at the name leaves no
	 * half-made project behind.
	 *
	 * The visible fields carry no `name`. Each screen is torn down as the next
	 * slides in, and a field that is not in the document is not submitted, so
	 * the form posts the hidden copies at the bottom instead.
	 *
	 * `fill` is the dialog's layout: the screens take the box and scroll in
	 * it, with the nav row pinned to the foot. Without it the screens and the
	 * nav row sit in the page's own flow, as onboarding lays them out.
	 */
	import { tick, untrack, type Snippet } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { fade, fly } from 'svelte/transition';

	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';

	import { browser } from '$app/environment';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import Card from '$lib/components/Card.svelte';
	import Hours from '$lib/components/Hours.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { trackEvent } from '$lib/analytics/client';
	import { FLOW_STEP, FLOW_STEPS, type FlowValues } from '$lib/project-flow';
	import type { HackatimeChoices } from '$lib/server/auth/hackatime';
	import { withScheme } from '$lib/url';
	import PixelIcon from '$lib/components/PixelIcon.svelte';

	type Kind = 'software' | 'hardware';

	let {
		action,
		submitLabel = 'create project',
		error = null,
		step: refusedAt = null,
		values = null,
		active = true,
		linkReturn,
		onstep,
		submitting = $bindable(false),
		firstBack,
		intro,
		introAction = "let's start",
		fill = false,
		children
	}: {
		/** The form action the last screen posts to. */
		action: string;
		submitLabel?: string;
		/** A refusal from that action, with the screen it belongs on and
		 *  everything that was typed. */
		error?: string | null;
		step?: number | null;
		values?: FlowValues | null;
		/** Whether the screens are in front of anybody - the dialog's `open`.
		 *  The Hackatime list is only asked for once they are. */
		active?: boolean;
		/** Where linking Hackatime from the links screen comes back to. */
		linkReturn: string;
		/** Told the screen showing, for a progress drawing outside this
		 *  component. */
		onstep?: (step: number) => void;
		submitting?: boolean;
		/** What stands where "back" would on the first screen - onboarding's
		 *  way to the step before. Nothing, when there is nowhere to go back to. */
		firstBack?: Snippet;
		/** A screen before the first question - onboarding's "let's create
		 *  your first project". Shown in the same frame with the same buttons
		 *  in the same places, so it reads as the flow's first screen; back
		 *  from the first question returns to it. `onstep` is told -1 while it
		 *  shows. */
		intro?: Snippet;
		/** The forward button's word on the intro. */
		introAction?: string;
		/** Take the whole box, nav pinned to the foot - see above. */
		fill?: boolean;
		/** More inside the form, under the nav row. */
		children?: Snippet;
	} = $props();

	const LAST = FLOW_STEPS.length - 1;

	let step = $state(0);
	/* Which way the screens slide: forward pushes the old one off to the left,
	   back pulls it off to the right. */
	let dir = $state(1);

	/* On the intro, when there is one - but not when a refusal has brought the
	   flow back: then the person is mid-flow and goes to the screen at fault. */
	let onIntro = $state(untrack(() => !!intro && refusedAt === null));

	$effect(() => {
		onstep?.(onIntro ? -1 : step);
	});

	/* Where people stop in the flow. Which flow - onboarding's or a new
	   project's - is on the event already, as its route. */
	$effect(() => {
		trackEvent('project_flow.step', { step: onIntro ? 'intro' : FLOW_STEPS[step] });
	});

	async function start() {
		dir = 1;
		onIntro = false;
		await focusStep();
	}

	let kind = $state<Kind | null>(null);
	let description = $state('');
	let name = $state('');
	let repoUrl = $state('');
	let demoUrl = $state('');
	let hackatime = $state<string[]>([]);

	/* A refusal lands on the screen the problem is on, words still in place. */
	$effect(() => {
		if (!error || !values) return;
		kind = values.kind === 'software' || values.kind === 'hardware' ? values.kind : null;
		description = values.description;
		name = values.name;
		repoUrl = values.repoUrl;
		demoUrl = values.demoUrl;
		hackatime = values.hackatimeProjects
			.split(',')
			.map((n) => n.trim())
			.filter(Boolean);
		dir = -1;
		step = refusedAt ?? 0;
		submitting = false;
	});

	/* Motion only where it is wanted. Only read by transitions and timers,
	   which never run on the server, so false there costs nothing. */
	const still = browser && matchMedia('(prefers-reduced-motion: reduce)').matches;

	/* ── hackatime ───────────────────────────────────────────────────── */

	/**
	 * The picker on the links screen, asked for as soon as the screens are in
	 * front of somebody, so it is usually there by the time they reach it -
	 * and not in a page load, which would call Hackatime on every visit to the
	 * projects grid. Once per page: reopening keeps the list it already has.
	 */
	let choices = $state<{ state: 'idle' | 'loading' } | HackatimeChoices>({ state: 'idle' });

	async function loadHackatime() {
		choices = { state: 'loading' };
		try {
			const response = await fetch('/api/projects/hackatime');
			if (!response.ok) throw new Error(String(response.status));
			choices = (await response.json()) as HackatimeChoices;
		} catch {
			choices = { state: 'error' };
		}
	}

	$effect(() => {
		if (active && choices.state === 'idle') loadHackatime();
	});

	/**
	 * Marks the list while there is more of it out of sight, above or below,
	 * so the edge fades (see `.np-hk-grid`) instead of cutting a tile in half
	 * as if that were the end. Re-read on scroll and whenever the list or its
	 * box changes size - a narrower screen is more rows, and more to hide.
	 */
	/**
	 * Inline, the screens sit in the page's own flow, so the page was as tall
	 * as whichever one was up - and the nav row under them, and "skip" under
	 * that, jumped up and down a hundred pixels with every step. So the stage
	 * holds the height of the tallest screen shown so far and never gives it
	 * back (CSS sets a floor that covers every screen on a wide window; this
	 * is for a narrow one, where wrapping makes the heights anybody's guess).
	 * Forgotten when the window changes width, since the heights change with
	 * it. The dialog needs none of this: its nav is pinned to the foot.
	 */
	let tallest = $state(0);
	let measuredAt = 0;

	function measure(node: HTMLElement) {
		const observer = new ResizeObserver(([entry]) => {
			if (window.innerWidth !== measuredAt) {
				measuredAt = window.innerWidth;
				tallest = 0;
			}
			const height = entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight;
			if (height > tallest) tallest = Math.ceil(height);
		});
		observer.observe(node);
		return { destroy: () => observer.disconnect() };
	}

	function scrollHints(node: HTMLElement) {
		const update = () => {
			node.classList.toggle('has-above', node.scrollTop > 1);
			node.classList.toggle(
				'has-below',
				node.scrollTop + node.clientHeight < node.scrollHeight - 1
			);
		};
		const observer = new ResizeObserver(update);
		observer.observe(node);
		node.addEventListener('scroll', update, { passive: true });
		update();
		return {
			destroy() {
				observer.disconnect();
				node.removeEventListener('scroll', update);
			}
		};
	}

	/* One already claimed by another of their projects cannot be picked - the
	   server refuses it too (see createProject) - but one picked before it was
	   claimed can still be let go of. */
	function toggleHackatime(name: string, taken: boolean) {
		if (hackatime.includes(name)) hackatime = hackatime.filter((n) => n !== name);
		else if (!taken) hackatime = [...hackatime, name];
	}

	/* ── moving through ─────────────────────────────────────────────────── */

	let ideaEl: HTMLTextAreaElement | undefined = $state();
	let nameEl: HTMLInputElement | undefined = $state();
	let repoEl: HTMLInputElement | undefined = $state();
	let demoEl: HTMLInputElement | undefined = $state();
	let formEl: HTMLFormElement | undefined = $state();
	let kindEls: HTMLInputElement[] = $state([]);
	let createEl: HTMLButtonElement | undefined = $state();

	/** The keyboard follows the flow, rather than being left on a button that
	 *  has just slid away. Exported for the dialog, which calls it on open. */
	export async function focusStep() {
		await tick();
		const target = [kindEls[kind === 'hardware' ? 1 : 0], ideaEl, nameEl, repoEl, createEl][step];
		target?.focus({ preventScroll: true });
	}

	/* ── links ──────────────────────────────────────────────────────── */

	/**
	 * The two url fields say what is wrong with them under themselves, rather
	 * than through the browser's validation bubble - that bubble was easy to
	 * miss entirely, and "next" just not working reads as a broken button, not
	 * as "that link is wrong". Checked when you leave a field and when you try
	 * to move on; once a field has said something is wrong, it re-checks as
	 * you type, so the message goes the moment it is fixed.
	 */
	let linkErrors = $state<{ repo: string | null; demo: string | null }>({
		repo: null,
		demo: null
	});

	const BAD_LINK =
		"that doesn't look like a link - it should look like https://github.com/you/project";

	/* What the server keeps (cleanUrl) is any http or https url. This asks a
	   little more - a dotted host - because a link a reviewer has to open is
	   never `http://localhost`, and "https://myproject" is a typo, not a
	   link. */
	function linkError(value: string): string | null {
		if (!value.trim()) return null;
		try {
			const url = new URL(value.trim());
			return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.')
				? null
				: BAD_LINK;
		} catch {
			return BAD_LINK;
		}
	}

	/* A missing https:// is filled in (withScheme) rather than refused. */
	function leaveLink(which: 'repo' | 'demo') {
		if (which === 'repo') repoUrl = withScheme(repoUrl);
		else demoUrl = withScheme(demoUrl);
		linkErrors[which] = linkError(which === 'repo' ? repoUrl : demoUrl);
	}

	function typeLink(which: 'repo' | 'demo') {
		if (linkErrors[which]) linkErrors[which] = linkError(which === 'repo' ? repoUrl : demoUrl);
	}

	/* Each screen's field has to hold up before moving past it. The idea and
	   the name use their own `required`, in the browser's words; the links say
	   it themselves (above), and the first wrong one takes the focus. */
	function valid(): boolean {
		if (step === FLOW_STEP.kind) return kind !== null;
		if (step === FLOW_STEP.idea) return ideaEl?.reportValidity() ?? false;
		if (step === FLOW_STEP.name) return nameEl?.reportValidity() ?? false;
		if (step === FLOW_STEP.links) {
			leaveLink('repo');
			leaveLink('demo');
			if (linkErrors.repo) repoEl?.focus();
			else if (linkErrors.demo) demoEl?.focus();
			return !linkErrors.repo && !linkErrors.demo;
		}
		return true;
	}

	async function go(to: number) {
		if (to === step || to < 0 || to > LAST) return;
		if (to > step && !valid()) return;
		dir = to > step ? 1 : -1;
		step = to;
		await focusStep();
	}

	const next = () => (onIntro ? start() : step === LAST ? formEl?.requestSubmit() : go(step + 1));
	const back = () => {
		if (step === 0 && intro && !onIntro) {
			dir = -1;
			onIntro = true;
			return;
		}
		go(step - 1);
	};

	const KINDS = [
		{
			value: 'software',
			icon: 'code',
			body: 'games, websites, apps, tools, bots - anything that runs on a screen.'
		},
		{
			value: 'hardware',
			icon: 'cpu',
			body: 'circuits, pcbs, keyboards, robots - anything you can hold in your hand.'
		}
	] as const;

	/* Picking one is the whole of the first screen, so a click moves on - after
	   a beat, so the choice is seen landing before it leaves. Only a pointer's
	   click: arrowing through a radio group fires clicks too (with a `detail`
	   of zero), and being carried off the screen mid-arrow is not choosing.
	   The keyboard picks, then presses Enter. */
	let advancing: ReturnType<typeof setTimeout> | undefined;
	function pick(choice: Kind, event: MouseEvent) {
		kind = choice;
		if (event.detail === 0) return;
		clearTimeout(advancing);
		advancing = setTimeout(() => step === FLOW_STEP.kind && go(FLOW_STEP.idea), still ? 0 : 380);
	}

	/**
	 * Enter moves on from a one-line field; in the idea box it is just a new
	 * line, and the next button moves on. Never a submit from anywhere but the
	 * last screen - a stray Enter on the name must not skip the look the review
	 * screen exists to give.
	 */
	function onKey(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.isComposing) return;
		const target = event.target as HTMLElement;
		if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement) return;
		if (target instanceof HTMLTextAreaElement) return;
		event.preventDefault();
		next();
	}

	/* ── sparks ─────────────────────────────────────────────────────────── */

	/**
	 * Somewhere to start, for somebody who has nothing yet - one list per
	 * kind, since a macropad is no help to someone making a website. A press
	 * fills the idea box: a sentence already there is easier to rewrite into
	 * your own than a blank one is to fill.
	 *
	 * Shuffled each time the idea screen comes up, so somebody who opens the
	 * flow twice is not shown the same three; "more ideas" then walks on
	 * through that order. The shuffle runs in an effect, which the server never
	 * does - it renders the list's own order, and only ever renders the first
	 * screen anyway.
	 */
	const SPARKS: Record<Kind, string[]> = {
		software: [
			'a puzzle game where the interface itself is the puzzle.',
			'a tool that fixes one annoying thing in my day.',
			'a website about something i am completely obsessed with.',
			'a tiny multiplayer game to play with my friends.',
			'a fake operating system you can poke around in and find secrets.',
			'a bot that does something silly in my group chat.',
			'a browser extension that changes how a website i use works.',
			'a generative art toy that makes something new every time.',
			'a text adventure set somewhere i know really well.'
		],
		hardware: [
			'a macropad with keys for the shortcuts i use most.',
			'a plant monitor that tells me when it is thirsty.',
			'a tiny handheld game console.',
			'a desk clock that shows something more interesting than the time.',
			'a pcb badge covered in blinking leds.',
			'a split mechanical keyboard, designed from scratch.',
			'a little robot that follows a line (or my cat).',
			'a weather station for my window.',
			'a synth you play by waving your hands over it.'
		]
	};
	const SHOWN = 3;
	let sparkAt = $state(0);
	let order = $state<number[]>([]);
	const pool = $derived(SPARKS[kind ?? 'software']);
	const sparks = $derived(
		Array.from({ length: SHOWN }, (_, i) => {
			const at = (sparkAt + i) % pool.length;
			return pool[order.length === pool.length ? order[at] : at];
		})
	);

	/* A fresh shuffle every time the idea screen is reached (Fisher-Yates). */
	$effect(() => {
		if (step !== FLOW_STEP.idea || onIntro) return;
		const next = Array.from({ length: pool.length }, (_, i) => i);
		for (let i = next.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[next[i], next[j]] = [next[j], next[i]];
		}
		untrack(() => {
			order = next;
			sparkAt = 0;
		});
	});

	/* Only replaces what is not the person's own - empty, or a spark they have
	   not touched - so a press never throws away something they typed. */
	function useSpark(spark: string) {
		const all = [...SPARKS.software, ...SPARKS.hardware];
		if (description.trim() && !all.includes(description)) return;
		description = spark;
		ideaEl?.focus();
	}

	/* The preview is the real projects-page Card. With no picture it draws the
	   field seeded by the name, so the thumbnail reshuffles as the name is
	   typed - the name making its own cover is the point of showing it live. */

	const ideaPlaceholder = $derived(kind === 'hardware' ? 'a little device that…' : 'a game where…');

	/* The screens slide sideways and fade. The pieces inside travel the same
	   way and trail a little behind, settling one after another (see
	   `.np-rise`) - one direction of motion for everything, the way things
	   carried along together actually move. */
	const slideIn = (node: Element) =>
		fly(node, { x: 56 * dir, duration: still ? 0 : 420, delay: still ? 0 : 90, easing: cubicOut });
	const slideOut = (node: Element) =>
		fly(node, { x: -56 * dir, duration: still ? 0 : 220, easing: cubicOut });
</script>

<!-- The keydown is delegation, not interaction: it catches Enter from the
     fields inside so every screen moves on the same way (see onKey). -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form
	bind:this={formEl}
	class={['np-flow', fill && 'is-fill']}
	method="POST"
	{action}
	onkeydown={onKey}
	use:enhance={() => {
		submitting = true;
		return async ({ result, update }) => {
			/* A redirect is the project page: leave the button saying so until
			   it arrives, rather than flashing back to "create". */
			if (result.type !== 'redirect') submitting = false;
			await update({ reset: false });
		};
	}}
>
	<div
		class="np-stage"
		style={fill || !tallest ? undefined : `--tallest: ${tallest}px`}
		use:scrollHints
	>
		{#key onIntro ? 'intro' : step}
			<section class="np-screen" style="--dir: {dir}" use:measure in:slideIn out:slideOut>
				{#if onIntro && intro}
					{@render intro()}
				{:else if error && step === (refusedAt ?? 0)}
					<div class="np-rise" style="--d: 0"><Notice bad alert body={error} /></div>
				{/if}

				{#if onIntro}
					<!-- the intro above -->
				{:else if step === FLOW_STEP.kind}
					<h1 class="np-question np-rise" id="np-question" style="--d: 0">
						what kind of project is it?
					</h1>
					<div class="np-kinds np-rise" role="radiogroup" aria-label="kind" style="--d: 1">
						{#each KINDS as choice, i (choice.value)}
							<label
								class={[
									'np-kind',
									kind === choice.value && 'is-picked',
									kind && kind !== choice.value && 'is-other'
								]}
							>
								<input
									class="np-sr"
									type="radio"
									name="kind-choice"
									value={choice.value}
									checked={kind === choice.value}
									bind:this={kindEls[i]}
									onclick={(event) => pick(choice.value, event)}
								/>
								<span class="np-kind-icon"><PixelIcon name={choice.icon} size={36} /></span>
								<span class="np-kind-title">{choice.value}</span>
								<span class="np-kind-body">{choice.body}</span>
							</label>
						{/each}
					</div>
				{:else if step === FLOW_STEP.idea}
					<h1 class="np-question np-rise" id="np-question" style="--d: 0">what's your idea?</h1>
					<p class="np-lede np-rise" style="--d: 1">
						it doesn't have to be big, or clever, or finished - just something you'd actually enjoy
						building. a sentence or two is plenty.
					</p>
					<div class="np-rise" style="--d: 2">
						<label class="np-sr" for="np-idea">your idea</label>
						<textarea
							id="np-idea"
							class="np-textarea"
							maxlength="2000"
							rows="4"
							placeholder={ideaPlaceholder}
							required
							bind:this={ideaEl}
							bind:value={description}></textarea>
					</div>
					<div class="np-sparks np-rise" style="--d: 3">
						<div class="np-sparks-head">
							<span class="np-label">need a spark?</span>
							<button
								type="button"
								class="np-text-btn"
								onclick={() => (sparkAt = (sparkAt + SHOWN) % pool.length)}>more ideas</button
							>
						</div>
						<ul class="np-spark-list">
							{#each sparks as spark, i (spark)}
								<li in:fade={{ duration: still ? 0 : 240, delay: still ? 0 : i * 50 }}>
									<button type="button" class="np-spark" onclick={() => useSpark(spark)}
										>{spark}</button
									>
								</li>
							{/each}
						</ul>
					</div>
				{:else if step === FLOW_STEP.name}
					<h1 class="np-question np-rise" id="np-question" style="--d: 0">what's it called?</h1>
					<p class="np-lede np-rise" style="--d: 1">
						a working title is fine - you can rename it whenever you like.
					</p>
					<div class="np-rise" style="--d: 2">
						<label class="np-sr" for="np-name">project name</label>
						<input
							id="np-name"
							class="np-big-input"
							type="text"
							maxlength="120"
							autocomplete="off"
							placeholder="untitled"
							required
							bind:this={nameEl}
							bind:value={name}
						/>
					</div>
					<div class="np-preview np-rise" style="--d: 3" aria-hidden="true">
						<Card name={name.trim() || 'untitled'} {description} aside={kind} image={null} />
					</div>
				{:else if step === FLOW_STEP.links}
					<h1 class="np-question np-rise" id="np-question" style="--d: 0">link it up</h1>
					<p class="np-lede np-rise" style="--d: 1">
						this step is optional - skip it if you like, and add any of it from the project page
						later.
					</p>

					<div class="np-links np-rise" style="--d: 2">
						<div class="np-field">
							<label class="np-label" for="np-repo">repository url</label>
							<input
								id="np-repo"
								class="np-small-input"
								type="url"
								inputmode="url"
								autocomplete="off"
								aria-invalid={linkErrors.repo ? 'true' : undefined}
								aria-describedby={linkErrors.repo ? 'np-repo-error' : undefined}
								bind:this={repoEl}
								bind:value={repoUrl}
								onblur={() => leaveLink('repo')}
								oninput={() => typeLink('repo')}
							/>
							{#if linkErrors.repo}
								<p class="np-field-error" id="np-repo-error" role="alert">
									{linkErrors.repo}
								</p>
							{/if}
						</div>
						<div class="np-field">
							<label class="np-label" for="np-demo">demo url</label>
							<input
								id="np-demo"
								class="np-small-input"
								type="url"
								inputmode="url"
								autocomplete="off"
								aria-invalid={linkErrors.demo ? 'true' : undefined}
								aria-describedby={linkErrors.demo ? 'np-demo-error' : undefined}
								bind:this={demoEl}
								bind:value={demoUrl}
								onblur={() => leaveLink('demo')}
								oninput={() => typeLink('demo')}
							/>
							{#if linkErrors.demo}
								<p class="np-field-error" id="np-demo-error" role="alert">
									{linkErrors.demo}
								</p>
							{/if}
						</div>
					</div>

					<div class="np-field np-hk-field np-rise" style="--d: 3">
						<span class="np-label" id="np-hk-label">hackatime projects</span>
						{#if choices.state === 'idle' || choices.state === 'loading'}
							<div class="np-hk-grid" aria-busy="true" aria-label="loading hackatime projects">
								{#each [0, 1, 2, 3] as i (i)}
									<span class="np-hk is-ghost" style="--d: {i}"></span>
								{/each}
							</div>
						{:else if choices.state === 'ok' && choices.projects.length}
							<div class="np-hk-grid" role="group" aria-labelledby="np-hk-label" use:scrollHints>
								{#each choices.projects as choice, i (choice.name)}
									{@const picked = hackatime.includes(choice.name)}
									{@const taken = choice.disabled && !picked}
									<label
										class={['np-hk', picked && 'is-picked', taken && 'is-taken']}
										style="--i: {i}"
									>
										<input
											class="np-sr"
											type="checkbox"
											checked={picked}
											disabled={taken}
											onchange={() => toggleHackatime(choice.name, choice.disabled)}
										/>
										<span class="np-hk-check" aria-hidden="true"
											><PixelIcon name="check" size={12} /></span
										>
										<span class="np-hk-name">{choice.name}</span>
										<span class="np-hk-hours">
											{#if taken}in use{:else}<Hours seconds={choice.totalSeconds} />{/if}
										</span>
									</label>
								{/each}
							</div>
						{:else if choices.state === 'ok'}
							<p class="np-empty">
								nothing tracked yet. once you start working with hackatime running, your project
								shows up here - you can link it from the project page then.
							</p>
						{:else if choices.state === 'unlinked'}
							<p class="np-empty">
								hackatime isn't linked to your account.
								<a
									class="np-text-btn"
									href={resolve(
										`/api/auth/hackatime/start?redirectTo=${encodeURIComponent(linkReturn)}`
									)}>link it</a
								> - or skip this and do it later.
							</p>
						{:else}
							<p class="np-empty">
								couldn't reach hackatime just now.
								<button type="button" class="np-text-btn" onclick={loadHackatime}>try again</button>
								- or skip this and link it later.
							</p>
						{/if}
					</div>
				{:else}
					<h1 class="np-question np-rise" id="np-question" style="--d: 0">ready to start?</h1>
					<div class={['np-final np-rise', submitting && 'is-launching']} style="--d: 1">
						<Card name={name.trim() || 'untitled'} {description} aside={kind} image={null} />
					</div>
				{/if}
			</section>
		{/key}
	</div>

	<div class="np-bottom">
		{#if (onIntro || (step === 0 && !intro)) && firstBack}
			{@render firstBack()}
		{:else}
			{@const nowhere = step === 0 && !intro}
			<button
				type="button"
				class={['control-btn is-quiet np-back', nowhere && 'is-gone']}
				onclick={back}
				tabindex={nowhere ? -1 : undefined}
				aria-hidden={nowhere}
			>
				<ArrowLeft size={16} /> back
			</button>
		{/if}

		{#if onIntro}
			<button type="button" class="control-btn is-large np-next" onclick={start}>
				{introAction}
				<ArrowRight size={16} />
			</button>
		{:else if step === LAST}
			<button
				type="submit"
				class="control-btn is-large np-next"
				disabled={submitting}
				bind:this={createEl}
			>
				{submitting ? 'creating…' : submitLabel}
			</button>
		{:else if step === FLOW_STEP.links}
			<button type="button" class="control-btn is-large np-next" onclick={next}>
				{repoUrl || demoUrl || hackatime.length ? 'next' : 'skip'}
				<ArrowRight size={16} />
			</button>
		{:else}
			<button
				type="button"
				class="control-btn is-large np-next"
				onclick={next}
				disabled={step === FLOW_STEP.kind && !kind}
			>
				next <ArrowRight size={16} />
			</button>
		{/if}
	</div>

	{@render children?.()}

	<input type="hidden" name="kind" value={kind ?? ''} />
	<input type="hidden" name="description" value={description} />
	<input type="hidden" name="name" value={name} />
	<input type="hidden" name="repo_url" value={repoUrl} />
	<input type="hidden" name="demo_url" value={demoUrl} />
	<input type="hidden" name="hackatime_projects" value={hackatime.join(',')} />
</form>

<style>
	/* ── the frame ────────────────────────────────────────────────────── */

	/* Inline, as onboarding lays it out: the screens, then the nav row under
	   them, in the page's own flow. */
	.np-flow {
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	/* Filling a box, as the dialog lays it out: the screens take the room and
	   scroll inside it, the nav row stays pinned to the foot. */
	.np-flow.is-fill {
		display: grid;
		grid-template-rows: 1fr auto;
		gap: 0;
		height: 100%;
		min-height: 0;
	}

	/* One grid cell for every screen, so the outgoing one and the incoming one
	   overlap while they cross instead of stacking and jumping.

	   It clips sideways, so what slides in from the edge does not widen the
	   page - and so it is given room to clip in: a margin's worth of padding
	   on each side, handed back by a negative margin, so a kind card that
	   grows as it is picked has somewhere to grow into before the edge. */
	.np-stage {
		position: relative;
		display: grid;
		align-items: start;
		/* Plus the 16px of its own padding: sizes here are border-box, and a
		   screen's measured height is only the screen. */
		min-height: calc(var(--tallest, 0px) + 16px);
		padding: 8px 20px;
		margin: -8px -20px;
		overflow-x: clip;
	}

	/* The floor on a wide window: the links screen, the tallest of them,
	   with the hackatime list at its full height. The measured height above
	   takes over wherever a screen turns out taller. */
	@media (min-width: 720px) {
		.np-stage {
			min-height: max(calc(var(--tallest, 0px) + 16px), 596px);
		}
	}

	/* In the dialog, the one part of the room that scrolls - and only when a
	   screen is taller than the window. Its edges fade where there is more,
	   the way the hackatime list's do, so a scroll here reads as meant. */
	.is-fill .np-stage {
		/* One row, exactly the stage's height, that every screen fills. */
		grid-template-rows: minmax(0, 1fr);
		align-items: stretch;
		min-height: 0;
		padding: 0;
		margin: 0;
		overflow-x: hidden;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: none;
		mask-image: linear-gradient(
			to bottom,
			transparent,
			#000 var(--fade-top),
			#000 calc(100% - var(--fade-bottom)),
			transparent
		);
		transition:
			--fade-top 240ms ease,
			--fade-bottom 240ms ease;
	}

	.is-fill .np-stage:global(.has-above) {
		--fade-top: 32px;
	}

	.is-fill .np-stage:global(.has-below) {
		--fade-bottom: 48px;
	}

	.np-screen {
		grid-area: 1 / 1;
		display: flex;
		flex-direction: column;
		gap: 20px;
		min-width: 0;
	}

	/* In the dialog the column is centred in the room, with the room's own
	   padding doing what the inline stage's does. */
	/* Exactly the height the room has between its bars - not its content's
	   height, centred - so nothing can hang over the edge by a few pixels and
	   make the whole screen scrollable, which an estimate of each screen's
	   height always ended up doing. Its pieces keep their size and the
	   hackatime list gives way (see .np-hk-field); the auto margins on the
	   first and last piece centre what is there, and unlike centring with
	   justify-content they never push the top out of reach.

	   Only a little padding of its own: the bars already hold the room's
	   margins. Enough at the top for a kind card's lift, at the sides for its
	   pop. */
	.is-fill .np-screen {
		width: min(640px, 100%);
		min-height: 0;
		margin: 0 auto;
		padding: 8px 20px 16px;
	}

	.is-fill .np-screen > :global(*) {
		flex-shrink: 0;
	}

	.is-fill .np-screen > :global(:first-child) {
		margin-top: auto;
	}

	.is-fill .np-screen > :global(:last-child) {
		margin-bottom: auto;
	}

	/* Each piece of a screen follows the screen in from the side it is coming
	   from, a beat after the one above it, and eases to a stop - momentum and
	   friction, not a fade up out of a haze. */
	/* Written `.np-screen :global(...)` so they reach an intro screen passed
	   in as a snippet (onboarding's), whose markup belongs to the page that
	   wrote it, as well as this component's own screens. */
	.np-screen :global(.np-rise) {
		animation: np-rise 620ms cubic-bezier(0.22, 1, 0.36, 1) both;
		animation-delay: calc(var(--d, 0) * 45ms + 60ms);
	}

	@keyframes -global-np-rise {
		from {
			opacity: 0;
			transform: translateX(calc(var(--dir, 1) * 28px));
		}
	}

	.np-screen :global(.np-question) {
		font-family: var(--font-instrument), ui-serif, Georgia, serif;
		font-style: italic;
		font-weight: 400;
		font-size: clamp(38px, 7vw, 64px);
		line-height: 1;
		color: var(--fg);
	}

	.np-screen :global(.np-lede) {
		max-width: 52ch;
		font-size: var(--text-sm);
		line-height: 1.6;
		color: var(--ink-mid);
	}

	.np-label {
		font-size: var(--text-xs);
		color: var(--ink-dim);
	}

	/* A field's own label names what goes in it, so it reads a step brighter
	   than the asides ("need a spark?") that share the style. */
	.np-field .np-label {
		color: var(--ink-mid);
	}

	/* Visually hidden, still there for the keyboard and a screen reader. It
	   sits where it would in the flow, so anything holding one inside a box
	   that scrolls has to be positioned itself, or it escapes that box's clip
	   (see .np-hk). */
	.np-sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	/* ── the bottom bar ───────────────────────────────────────────────── */

	.np-bottom {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}

	.is-fill .np-bottom {
		width: min(760px, 100%);
		margin: 0 auto;
		/* The dialog's edge margin (--np-edge), matching the space above its
		   progress bar - or a phone's home-bar inset, where that is bigger. */
		padding: 16px 16px max(var(--np-edge, 22px), env(safe-area-inset-bottom));
	}

	.np-back,
	.np-next {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
	}

	.np-back {
		transition:
			opacity 200ms ease,
			transform 200ms ease;
	}

	.np-back.is-gone {
		opacity: 0;
		transform: translateX(-8px);
		pointer-events: none;
	}

	.np-next :global(svg),
	.np-back :global(svg) {
		transition: transform 160ms ease;
	}

	.np-next:hover:not(:disabled) :global(svg) {
		transform: translateX(3px);
	}

	.np-back:hover :global(svg) {
		transform: translateX(-3px);
	}

	/* ── kind ─────────────────────────────────────────────────────────── */

	.np-kinds {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 14px;
		margin-top: 8px;
	}

	.np-kind {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 22px;
		background-color: var(--surface);
		background-image: var(--weave-grid), var(--shade-inset);
		border: 1px solid var(--line);
		border-radius: calc(var(--control-radius) + 4px);
		cursor: pointer;
		transition:
			transform 260ms cubic-bezier(0.2, 0.7, 0.2, 1),
			border-color 160ms ease,
			background-color 160ms ease,
			opacity 200ms ease;
	}

	@media (hover: hover) {
		.np-kind:hover {
			transform: translateY(-4px);
			border-color: var(--panel-line);
		}
	}

	.np-kind:has(input:focus-visible) {
		border-color: var(--ink);
	}

	.np-kind.is-picked {
		border-color: var(--ink);
		background-color: var(--level-panel);
		animation: np-pop 380ms cubic-bezier(0.3, 1.5, 0.5, 1);
	}

	.np-kind.is-other {
		opacity: 0.5;
	}

	@keyframes np-pop {
		40% {
			transform: scale(1.035);
		}
	}

	.np-kind-icon {
		display: grid;
		place-items: center;
		width: 54px;
		height: 54px;
		color: var(--ink);
		/* A well a step below the card: halfway between the card's surface
		   and the page ground, so it sits in the card without reading as a
		   hole (the ground itself) or a button (the panel grey). */
		background-color: color-mix(in srgb, var(--surface) 55%, var(--bg));
		background-image: var(--weave-bayer), var(--shade-inset);
		border: 1px solid var(--line);
		border-radius: 14px;
		transition: transform 300ms cubic-bezier(0.3, 1.5, 0.5, 1);
	}

	.np-kind:hover .np-kind-icon,
	.np-kind.is-picked .np-kind-icon {
		transform: rotate(-6deg) scale(1.06);
	}

	.np-kind-title {
		margin-top: 6px;
		font-family: var(--font-instrument), ui-serif, Georgia, serif;
		font-style: italic;
		font-size: 32px;
		line-height: 1;
	}

	.np-kind-body {
		font-size: var(--text-xs);
		line-height: 1.5;
		color: var(--ink-mid);
	}

	/* ── idea ─────────────────────────────────────────────────────────── */

	.np-textarea {
		width: 100%;
		min-height: 140px;
		padding: 16px 18px;
		font: inherit;
		font-size: var(--text-md);
		line-height: 1.5;
		color: var(--ink);
		background-color: var(--surface);
		background-image: var(--weave-grid), var(--shade-inset);
		border: 1px solid var(--line);
		border-radius: calc(var(--control-radius) + 2px);
		resize: vertical;
		transition: border-color 140ms ease;
	}

	.np-textarea:focus {
		border-color: var(--panel-line);
		outline: none;
	}

	.np-textarea::placeholder,
	.np-big-input::placeholder {
		color: var(--ink-dim);
		opacity: 0.6;
	}

	.np-sparks {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.np-sparks-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.np-spark-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		list-style: none;
	}

	.np-spark {
		width: 100%;
		padding: 10px 14px;
		font: inherit;
		font-size: var(--text-xs);
		line-height: 1.4;
		text-align: left;
		color: var(--ink-mid);
		background-color: transparent;
		/* --panel-line, for the reason the hackatime tiles give: a suggestion
		   has no fill, so its edge is all there is of it, and a dashed --line
		   all but disappeared against the ground. */
		border: 2px dashed var(--panel-line);
		border-radius: var(--control-radius);
		cursor: pointer;
		transition:
			border-color 120ms ease,
			color 120ms ease,
			transform 160ms ease,
			background-color 120ms ease;
	}

	.np-spark:hover,
	.np-spark:focus-visible {
		color: var(--ink);
		background-color: var(--surface);
		border-color: var(--ink-mid);
		border-style: solid;
		transform: translateX(4px);
		outline: none;
	}

	/* ── name ─────────────────────────────────────────────────────────── */

	/* The name typed at the size it will be read at, on a line rather than in a
	   box - the question is the whole screen, the answer should be too. */
	.np-big-input {
		width: 100%;
		padding: 6px 0 10px;
		font-family: var(--font-instrument), ui-serif, Georgia, serif;
		font-style: italic;
		font-size: clamp(30px, 5vw, 44px);
		line-height: 1.1;
		color: var(--ink);
		background: none;
		border: 0;
		border-bottom: 2px solid var(--line);
		border-radius: 0;
		transition: border-color 160ms ease;
	}

	.np-big-input:focus {
		border-bottom-color: var(--ink);
		outline: none;
	}

	.np-preview,
	.np-final {
		width: min(340px, 100%);
	}

	.np-preview {
		margin-top: 4px;
		transform: rotate(-1.2deg);
	}

	.np-preview :global(.card-desc),
	.np-final :global(.card-desc) {
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.np-preview :global(.card h3),
	.np-final :global(.card h3) {
		overflow-wrap: anywhere;
	}

	/* ── links ────────────────────────────────────────────────────────── */

	.np-field {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	/* Side by side and a size down: they are the afterthought on this screen,
	   not the question. */
	.np-links {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 12px;
	}

	.np-small-input {
		width: 100%;
		padding: 8px 12px;
		font: inherit;
		font-size: var(--text-xs);
		color: var(--ink);
		background-color: var(--surface);
		background-image: var(--weave-bayer), var(--shade-inset);
		border: 1px solid var(--line);
		border-radius: var(--control-radius);
		transition:
			border-color 140ms ease,
			background-color 140ms ease;
	}

	.np-small-input:focus {
		background-color: var(--panel);
		border-color: var(--panel-line);
		outline: none;
	}

	/* The alarm red the bad badge wears, on the edge of the field that is
	   wrong, with the reason directly under it. */
	.np-small-input[aria-invalid='true'] {
		border-color: #c2414c;
	}

	.np-field-error {
		font-size: var(--text-xs);
		line-height: 1.5;
		color: #f3ccd0;
		animation: np-appear 200ms ease both;
	}

	.np-empty {
		font-size: var(--text-xs);
		line-height: 1.6;
		color: var(--ink-mid);
	}

	/* ── hackatime ────────────────────────────────────────────────────── */

	/* Tiles rather than the project page's dropdown: there is a whole screen
	   here, and seeing every folder at once with its hours beside it is the
	   quickest way to spot the right one. Bounded, and scrolls inside that, for
	   somebody with forty of them. */
	/* Positioned for the same reason as the tiles: a scroll box that is not a
	   containing block lets absolute children out past its own clip. */
	.np-hk-grid {
		position: relative;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
		gap: 8px;
		/* Shorter on a short window, so the links screen still fits it. */
		max-height: min(232px, 28vh);
		padding: 2px;
		margin: -2px;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
		/* The tiles fade out toward an edge with more beyond it. A mask rather
		   than a gradient laid over the top, so it fades into whatever is
		   behind - the drifting glow included - rather than into a flat colour
		   that has to match it. The lengths are registered below so the fade
		   eases in and out instead of snapping. */
		mask-image: linear-gradient(
			to bottom,
			transparent,
			#000 var(--fade-top),
			#000 calc(100% - var(--fade-bottom)),
			transparent
		);
		transition:
			--fade-top 240ms ease,
			--fade-bottom 240ms ease;
	}

	/* In the dialog the list is the one thing on a screen that gives way: it
	   shrinks into whatever height the screen has left (see .np-screen under
	   is-fill), down to about two rows, and its own scroll and fades take it
	   from there. */
	/* `.np-screen >` so it outranks the rule that holds every other piece of
	   a screen at its size, rather than winning only by coming later. */
	.is-fill .np-screen > .np-hk-field {
		flex-shrink: 1;
		min-height: 0;
	}

	.is-fill .np-hk-grid {
		flex: 0 1 auto;
		min-height: 100px;
		max-height: 232px;
	}

	.np-hk-grid:global(.has-above) {
		--fade-top: 40px;
	}

	.np-hk-grid:global(.has-below) {
		--fade-bottom: 64px;
	}

	@property --fade-top {
		syntax: '<length>';
		inherits: false;
		initial-value: 0px;
	}

	@property --fade-bottom {
		syntax: '<length>';
		inherits: false;
		initial-value: 0px;
	}

	/* Positioned so the hidden checkbox inside (.np-sr, absolute) is placed
	   in its own tile. Unpositioned, every tile's checkbox escaped the list:
	   placed where its tile would sit if the list did not scroll, and
	   measured by nothing that clipped it - so forty projects meant a column
	   of invisible checkboxes hanging hundreds of pixels below the list, and
	   the whole screen scrolled to reach them. */
	.np-hk {
		position: relative;
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 46px;
		padding: 10px 12px;
		font-size: var(--text-xs);
		background-color: var(--surface);
		background-image: var(--weave-grid), var(--shade-inset);
		/* --panel-line, not the fields' --line: a tile is only its edge, and at
		   --line an unpicked one all but vanished into the ground. */
		border: 1px solid var(--panel-line);
		border-radius: var(--control-radius);
		cursor: pointer;
		transition:
			border-color 140ms ease,
			background-color 140ms ease;
	}

	/* Arriving, they only fade up, one after the next: they sit in a box that
	   clips, so anything sliding would be cut at its edge. Capped, so the
	   thirtieth does not keep somebody waiting. */
	.np-hk:not(.is-ghost) {
		animation: np-appear 280ms ease both;
		animation-delay: calc(min(var(--i, 0), 10) * 35ms);
	}

	@keyframes np-appear {
		from {
			opacity: 0;
		}
	}

	/* The tile itself never moves: the grid scrolls, so it clips, and anything
	   that grows or lifts gets its edge cut off against the box. The fill and
	   the edge say picked; the checkbox does the moving. */
	@media (hover: hover) {
		.np-hk:not(.is-taken, .is-ghost):hover {
			border-color: var(--ink-mid);
		}
	}

	.np-hk:has(input:focus-visible) {
		border-color: var(--ink);
	}

	.np-hk.is-picked {
		background-color: var(--level-panel);
		border-color: var(--ink);
	}

	.np-hk.is-taken {
		color: var(--ink-dim);
		cursor: not-allowed;
		opacity: 0.6;
	}

	/* The loading shape: the tiles to come, breathing. */
	.np-hk.is-ghost {
		cursor: default;
		animation: np-breathe 1.2s ease-in-out infinite alternate;
		animation-delay: calc(var(--d, 0) * 120ms);
	}

	@keyframes np-breathe {
		from {
			opacity: 0.35;
		}
		to {
			opacity: 0.8;
		}
	}

	.np-hk-check {
		display: grid;
		flex: none;
		place-items: center;
		width: 18px;
		height: 18px;
		color: transparent;
		border: 1.5px solid var(--ink-dim);
		border-radius: 5px;
		transition:
			color 140ms ease,
			background-color 140ms ease,
			border-color 140ms ease;
	}

	.np-hk.is-picked .np-hk-check {
		color: var(--on-light);
		background-color: var(--ink);
		border-color: var(--ink);
		animation: np-check 260ms cubic-bezier(0.3, 1.4, 0.5, 1);
	}

	@keyframes np-check {
		from {
			transform: scale(0.7);
		}
	}

	.np-hk-name {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ink);
	}

	.np-hk.is-taken .np-hk-name {
		color: inherit;
	}

	.np-hk-hours {
		flex: none;
		font-family: var(--font-geist-mono), ui-monospace, monospace;
		color: var(--ink-dim);
	}

	/* ── review ───────────────────────────────────────────────────────── */

	.np-final {
		transition:
			transform 500ms cubic-bezier(0.2, 0.7, 0.2, 1),
			opacity 500ms ease;
	}

	/* Created: the card lifts away toward the page it is about to become. */
	.np-final.is-launching {
		transform: translateY(-10px) scale(1.02);
		animation: np-glow 1.2s ease-in-out infinite alternate;
	}

	@keyframes np-glow {
		to {
			filter: drop-shadow(0 0 22px rgba(233, 230, 225, 0.18));
		}
	}

	/* Text, not a button: dotted, small. Stated here rather than borrowed from
	   the shell, which onboarding resets out of. */
	.np-text-btn,
	.np-text-btn:visited {
		padding: 0;
		font: inherit;
		font-size: var(--text-xs);
		color: var(--ink-mid);
		background: none;
		border: 0;
		text-decoration: underline dotted;
		text-underline-offset: 2px;
		cursor: pointer;
	}

	.np-text-btn:hover,
	.np-text-btn:focus-visible {
		color: var(--ink);
		outline: none;
	}

	/* ── less motion ──────────────────────────────────────────────────── */

	@media (prefers-reduced-motion: reduce) {
		.np-flow,
		.np-flow * {
			animation: none !important;
			transition-duration: 0ms !important;
		}
	}
</style>
