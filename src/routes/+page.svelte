<script lang="ts">
	import '$lib/site-styles';

	import { onMount } from 'svelte';

	import { page } from '$app/state';

	import Bell from '$lib/components/Bell.svelte';
	import Controls from '$lib/components/Controls.svelte';
	import Faq from '$lib/components/Faq.svelte';
	import Field from '$lib/components/Field.svelte';
	import { drawBloom } from '$lib/field/bloom';
	import LandingAuth from '$lib/components/LandingAuth.svelte';
	import LandingNotice from '$lib/components/LandingNotice.svelte';
	import SignOutButton from '$lib/components/SignOutButton.svelte';

	let { data } = $props();

	/* The spill around the title, drawn once (see $lib/field/bloom) and again
	   when the font arrives or the layout changes. */
	let title: HTMLHeadingElement | undefined;
	let halo: HTMLCanvasElement | undefined;
	onMount(() => {
		const draw = () => {
			if (title && halo) drawBloom(title, halo);
		};
		draw();
		void document.fonts.ready.then(draw);
		window.addEventListener('resize', draw);

		/**
		 * The halo is placed in absolute pixels, so it has to be redrawn whenever
		 * the title MOVES - and the title moves for reasons no resize event
		 * reports. Dismissing a notice below it is the plain case: a node leaves
		 * the column, the column recentres what is left, the heading slides down,
		 * and a halo pinned to where the heading used to be slides out from under
		 * it.
		 *
		 * A ResizeObserver cannot see this, on any element. .hero is 100svh and
		 * .inner-page is 100% of it, centring its children - so when the notice
		 * goes, every box here keeps the size it had and only the contents move.
		 * The one thing that genuinely changed is the DOM, so that is what is
		 * watched: childList over the subtree, which fires for the notice going
		 * and for the sign-in block swapping between its three shapes.
		 *
		 * `attributes` is deliberately not observed. drawBloom's last act is to set
		 * this canvas's left, top, width and height, and watching attribute changes
		 * would make that redraw trip the observer that caused it.
		 */
		const block = title?.offsetParent ?? null;

		/* Coalesced into one redraw per frame: a single Svelte update can remove a
		   node and add another, and the halo is rasterised rather than cheap. */
		let queued = 0;
		const redraw = () => {
			cancelAnimationFrame(queued);
			queued = requestAnimationFrame(draw);
		};

		const observer = block ? new MutationObserver(redraw) : null;
		if (block) observer?.observe(block, { childList: true, subtree: true });

		return () => {
			window.removeEventListener('resize', draw);
			observer?.disconnect();
			cancelAnimationFrame(queued);
		};
	});

	/* The path from an idea to a seat in Philadelphia, one row per move.

	   One path, not two. The program is a single track - build something, log the
	   time, ship it - so there is nothing here to branch on and a fork drawn across
	   it would be a diagram of a decision nobody is being asked to make. */
	const STEPS: { t: string; d: string }[] = [
		{ t: 'get an idea', d: 'anything you want to make.' },
		{ t: 'start building', d: 'plan it, sketch it, or just start writing code.' },
		{ t: 'log your hours', d: 'hackatime counts the time you spend coding.' },
		{ t: 'ship it', d: 'submit the project for review.' },
		{ t: 'earn fragments', d: 'every approved hour turns into fragments.' },
		{
			t: 'become a phantom',
			d: "spend 50 hours' worth of fragments on your invite, or on prizes in the shop instead."
		}
	];

	/* Whether the projects band exists at all.

	   Read from the environment rather than written as a literal, so it is a build
	   input: Vite substitutes import.meta.env.VITE_SHOW_PROJECTS as a literal at
	   build time (the equivalent of Next's NEXT_PUBLIC_ inlining), so with the
	   value inlined the branch folds to a constant and the section, the list it
	   maps over and every project name in it are dropped from the output entirely
	   instead of being carried in a chunk nobody serves.

	   Off unless explicitly switched on: VITE_SHOW_PROJECTS=true in .env, or on the
	   build command. Off is the default because these are not Phantom projects -
	   nothing has been built for this yet - so shipping them is a decision to make
	   on purpose rather than one to forget to undo. Changing it needs a rebuild,
	   which is the point. */
	const SHOW_PROJECTS = import.meta.env.VITE_SHOW_PROJECTS === 'true';

	/* Projects built by teenagers in Hack Club. Not Phantom projects - Phantom has
	   not run yet - which is why the band says whose they are rather than implying
	   they came out of this. */
	const PROJECTS: { t: string; d: string; by: string }[] = [
		{
			t: 'doompdf',
			d: 'a source port of doom (1993) that runs inside a pdf document',
			by: 'allen, 18, us'
		},
		{
			t: 'librepods',
			d: "airpods liberated from apple's ecosystem",
			by: 'kavish, 17, india'
		},
		{
			t: 'vert',
			d: 'a file converter that uses webassembly to convert files on your device',
			by: 'maya, 17, qatar'
		},
		{
			t: 'the biblically accurate macropad',
			d: 'a macropad in the form of a biblically accurate angel',
			by: 'alex, 16, us'
		},
		{
			t: 'specter',
			d: 'a game about a knight escaping a cave, haunted by his own ghost',
			by: 'ayessa, 18, philippines'
		},
		{
			t: 'blind defusal',
			d: 'a two-player cooperative bomb defusal game',
			by: 'joshua, 17, australia'
		},
		{
			t: 'cyberboard v2',
			d: 'a cyberpunk-themed stm32 dev board with bluetooth 5.1',
			by: 'nathan, 18, colombia'
		},
		{
			t: 'killersplit',
			d: 'an ergonomic, wireless, split low-profile keyboard',
			by: 'shaunak, 13, india'
		},
		{
			t: 'cyberpad',
			d: 'a sleek, cyberpunk inspired macropad',
			by: 'kai, 17, canada'
		},
		{ t: 'glowpad', d: 'a glowing macropad', by: 'raygen, 17, us' },
		{
			t: 'meko',
			d: 'a high definition music player',
			by: 'marcell, 17, romania'
		},
		{
			t: 'bitlace',
			d: 'a retro accessory with an 8x8 monochrome screen',
			by: 'vladislav, 17, russia'
		},
		{
			t: '3dp motherboard',
			d: 'a powerful, yet affordable 3d printer motherboard',
			by: 'kai, 17, canada'
		},
		{ t: 'twoswap', d: 'an epic wearable tv head', by: 'nick, 18, us' },
		{
			t: 'picat',
			d: 'an rp2040-based devboard with 16mb of flash memory',
			by: 'silas, 17, us'
		}
	];
</script>

<svelte:head>
	<title>PHANTOM — a Hack Club escape room hackathon in Philadelphia</title>
	<meta
		name="description"
		content="Build creative projects for 50 hours, then fly to an escape room hackathon in Philadelphia."
	/>
	<meta name="theme-color" content="#0a0a0c" />

	<meta property="og:site_name" content="PHANTOM - Hack Club" />
	<meta property="og:title" content="PHANTOM — a Hack Club escape room hackathon in Philadelphia" />
	<meta
		property="og:description"
		content="Build creative projects for 50 hours, then fly to an escape room hackathon in Philadelphia."
	/>
	<meta property="og:type" content="website" />
	<!-- Absolute, as the spec requires. A bare "/og-image.png" left each
	     crawler to resolve it itself, and some only managed that when the
	     shared link already ended in a slash. og:url names the page without
	     any ?ref= a link carried, so every invite previews as the same page. -->
	<meta property="og:url" content="{page.url.origin}/" />
	<meta property="og:image" content="{page.url.origin}/og-image.png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />

	<meta name="twitter:card" content="summary_large_image" />
	<meta
		name="twitter:title"
		content="PHANTOM — a Hack Club escape room hackathon in Philadelphia"
	/>
	<meta
		name="twitter:description"
		content="Build creative projects for 50 hours, then fly to an escape room hackathon in Philadelphia."
	/>
	<meta name="twitter:image" content="{page.url.origin}/og-image.png" />
	<!-- The hero's body face. Preloaded here rather than in app.html because
	     this is the one page that sets type above the fold in it - the lede, the
	     bands and the footer all inherit it from .inner-page. Everywhere else it
	     reaches only .shell-foot, at the bottom of the page, where waiting for
	     the ordinary discovery pass costs nothing. Only the latin-range serif
	     and Geist Sans are preloaded globally, in app.html, because every page
	     sets them above the fold. `crossorigin` is required even same-origin:
	     fonts are fetched in CORS mode, and a preload without it is a different
	     request, so the file would download twice. -->
	<link
		rel="preload"
		href="/fonts/GeistPixel-Square.woff2"
		as="font"
		type="font/woff2"
		crossorigin="anonymous"
	/>
</svelte:head>

<Field />
<!-- The page, painted by the browser above the field.

     It scrolls. #content is in the flow rather than pinned over the viewport,
     so the hero is one screen and the bands are what is under it; the field
     itself stays fixed, so scrolling moves the page across a backdrop that does
     not move. -->
<main id="content">
	<section class="hero">
		<div class="inner-page">
			<a class="page-mark" href="https://hackclub.com" aria-label="Hack Club">
				<img src="/hack-club-flag.png" alt="" width="522" height="181" />
			</a>
			<!-- The halo sits behind the title, drawn once into this canvas. -->
			<canvas bind:this={halo} class="hero-bloom" aria-hidden="true"></canvas>
			<h1 bind:this={title}>PHANTOM</h1>
			<!-- A byline tucked under the wordmark. Its rules live in
			     styles/landing.css under .hero-by, so this line is the whole of it. -->
			<p class="hero-by">by archer, david, and santi</p>
			<!-- The mark at the end of the lede is a link to the questions band, not
				     a control that opens one. It works with no JavaScript, offers "open
				     in new tab", and tells a screen reader where it goes. -->
			<p class="lede">
				build creative projects for 50 hours, then fly to an escape room hackathon in Philadelphia <a
					class="faq-mark"
					href="#faq">FAQ</a
				>
			</p>
			<!-- What the hero offers depends on whether the doors are open.

				     Before launch the field is the waiting list, exactly as it was
				     before the platform arrived: an address, a button, Airtable. Once
				     the switch in the console is on, the same slot offers the real
				     thing - sign up through Hack Club, or log in. The switch is a row
				     in the database, so opening is not a deploy.

				     A visitor who is already signed in only reaches this page when the
				     launch gate has refused them, so signing in again is the one thing
				     that cannot help: the start route refuses the same session and
				     sends them back here. Sign out is offered instead, and it is the
				     only copy of it they can reach - the other two live inside the
				     shell the gate is keeping them out of. -->
			<div class="landing-actions">
				<LandingNotice
					authError={data.authError}
					closed={data.closed}
					signedOut={data.signedOut}
					prelaunchMessage={data.prelaunchMessage}
					inviter={data.inviter}
				/>
				{#if data.signedIn}
					<SignOutButton />
				{:else if data.launched}
					<LandingAuth configured={data.configured} email={data.email} />
				{:else}
					<!-- Closed: the waiting list and nothing else. The staff door is
					     /login, typed, not offered. -->
					<Controls email={data.email} />
				{/if}
			</div>
		</div>
		<Bell />
	</section>

	<!-- Under the fold: what the thing is, how you get in, what fifty hours buys,
		     what people have already built, and the questions. One column of bands. -->
	<section class="band" id="about" aria-labelledby="about-title">
		<h2 class="band-title" id="about-title">what is phantom?</h2>
		<div class="band-prose">
			<p>
				phantom is a 3-day escape room hackathon in philadelphia. build creative projects for 50
				hours to earn an invite, then spend a long weekend in a venue full of puzzles with everyone
				else who earned theirs.
			</p>
			<p>
				your stay and your food are covered. any work you do after getting your ticket counts toward
				a flight stipend at $8.50/hr, or prizes in the shop if you can't make the weekend.
			</p>
		</div>
	</section>

	<section class="band" id="how" aria-labelledby="how-title">
		<h2 class="band-title" id="how-title">how it works</h2>
		<ol class="steps">
			{#each STEPS as s, i (s.t)}
				<li class="step">
					<span class="step-idx">{String(i + 1).padStart(2, '0')}</span>
					<span class="step-body">
						<span class="step-t">{s.t}</span>
						<span class="step-d">{s.d}</span>
					</span>
				</li>
			{/each}
		</ol>
	</section>

	<!-- The number, at the size the thing it is asking for deserves. Ramped
		     rather than flat: --dither-ink-to is read by the rasteriser and the
		     seven-level quantiser downstream turns the smooth ramp into bands of
		     dither, so a figure this large comes out as structure instead of a slab. -->
	<section class="band band-hours" id="hours" aria-labelledby="hours-title">
		<p class="hours-fig" aria-hidden="true">50</p>
		<div class="hours-say">
			<!-- The figure next to it is aria-hidden, so the number is said here
				     instead - the heading is "50 hours" to a screen reader and "hours" to
				     everyone else, who can already see the 50. -->
			<h2 class="band-title" id="hours-title"><span class="sr-only">50 </span>hours</h2>
			<p>
				code for fifty hours, on a single project or across multiple. ship your projects, get your
				hours approved, and trade 50 hours' worth of fragments for your invite. build a game about
				being a philosophical fridge or a tui to monitor your computer's usb ports.
			</p>
		</div>
	</section>

	{#if SHOW_PROJECTS}
		<section class="band" id="projects" aria-labelledby="projects-title">
			<h2 class="band-title" id="projects-title">projects</h2>
			<p class="band-say">built by teenagers in Hack Club</p>
			<ul class="cards">
				{#each PROJECTS as p (p.t)}
					<li class="card">
						<h3>{p.t}</h3>
						<p>{p.d}</p>
						<p class="card-by">{p.by}</p>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<Faq />

	<!-- Who runs this and where to go next, the credit under the links, then the
		     wordmark the page ends on. -->
	<footer class="page-foot">
		<div class="foot-cols">
			<div class="foot-about">
				<h2>a project by <a href="https://hackclub.com/?utm_source=phantom">Hack Club</a></h2>
				<p>
					Hack Club is a 501(c)(3) nonprofit and network of 100k+ technical high schoolers. we
					believe you learn best by building, so we're creating community and providing grants so
					you can make awesome projects. in the past few years, we've <a
						href="https://www.youtube.com/watch?v=ufMUJ9D1fi8"
						>sent 30 teen hackers hiking the pacific crest trail</a
					>,
					<a href="https://www.youtube.com/watch?v=8iM1W8kXrQA"
						>hosted a hackathon for the worst ideas</a
					>, and
					<a href="https://www.youtube.com/watch?v=kaEFv7e49mo"
						>ran the largest teen hardware hackathon at github hq</a
					>.
				</p>
				<p>
					read about Hack Club in <a
						href="https://www.wsj.com/articles/teen-hackers-try-to-convince-parents-they-are-up-to-good-11569922200"
						>the wall street journal</a
					>,
					<a
						href="https://www.cbsnews.com/sanfrancisco/news/hack-club-hosts-teen-coders-san-francisco/"
						>cbs news</a
					>, and
					<a
						href="https://www.nasa.gov/learning-resources/space-out-this-summer-with-variety-of-nasa-stem-activities/"
						>nasa.gov</a
					>, or watch us
					<a href="https://www.youtube.com/live/UbfAhFxDomE?si=5DiK1_hGqKrB_r50&amp;t=7033"
						>on stage with amd ceo lisa su at ces</a
					>.
				</p>
			</div>

			<div class="foot-side">
				<nav class="foot-nav" aria-label="Footer">
					<div class="foot-col">
						<h3>community</h3>
						<ul>
							<li><a href="https://slack.hackclub.com/">join our slack</a></li>
							<li><a href="https://events.hackclub.com/">community events</a></li>
							<li><a href="https://workshops.hackclub.com/">workshops</a></li>
							<li><a href="https://forms.hackclub.com/bounty">bounty</a></li>
							<li><a href="https://hackclub.com/conduct/">code of conduct</a></li>
						</ul>
					</div>
					<div class="foot-col">
						<h3>Hack Club</h3>
						<ul>
							<li><a href="https://hackclub.com/philosophy/">philosophy</a></li>
							<li><a href="https://hackclub.com/team/">our team &amp; board</a></li>
							<li><a href="https://hackclub.com/brand/">branding</a></li>
							<li><a href="https://hackclub.com/philanthropy/">donate</a></li>
							<li><a href="https://hackclub.com/privacy-and-terms">privacy and terms</a></li>
						</ul>
					</div>
				</nav>

				<p class="page-credit">made with &lt;3 by natey and stelle</p>
			</div>
		</div>

		<!-- The title again, at the size the page ends on. Hidden from assistive
			     tech because it says nothing the h1 has not already said - it is the
			     wordmark, not a heading. -->
		<div class="foot-mark" aria-hidden="true">PHANTOM</div>
	</footer>
</main>
