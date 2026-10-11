<script lang="ts">
	/**
	 * The signed-in nav.
	 *
	 * aria-current follows the URL, read from `$app/state` so it moves with every
	 * client-side navigation. Nothing else in here is interactive - the links are
	 * links.
	 *
	 * "You are here" is carried by the fill rather than by an underline or a rule,
	 * because .nav-link[aria-current="page"] takes a step up the ramp (see
	 * globals.css). That means the accessibility attribute and the visual state
	 * are the same fact rather than two things that can drift apart: there is no
	 * way to light a tab up without also announcing it.
	 */
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import DitherAvatar from '$lib/components/dither/DitherAvatar.svelte';

	let {
		onboarded,
		me
	}: {
		/** Who is signed in: drawn on the account tab. */
		me: { avatarUrl: string | null; handle: string };
		/** Whether the user has finished onboarding.
		 *
		 *  Not decoration. Before they have, /home and /account both redirect
		 *  straight back to /onboarding - so offering them is offering links that
		 *  bounce, which reads as the app being broken rather than as a step being
		 *  unfinished. While onboarding, the only route is the one they are on. */
		onboarded: boolean;
	} = $props();

	/* Orders lives off the shop page itself now (a button, top right), not
	   here - it is standing for one product's status, not for a section of the
	   app the way every other tab is. */
	const LINKS = [
		{ href: '/home', label: 'home' },
		{ href: '/projects', label: 'projects' },
		{ href: '/explore', label: 'explore' },
		{ href: '/guides', label: 'guides' },
		{ href: '/shop', label: 'shop' },
		{ href: '/account', label: 'account' }
	] as const;

	/* The review queue and the console are not tabs: they are the red doors
	   bottom right (DangerZone.svelte). */
	const SETUP_LINK = { href: '/onboarding', label: 'setup' } as const;

	const links = $derived(onboarded ? LINKS : [SETUP_LINK]);

	function isActive(href: string): boolean {
		const path = page.url.pathname;
		return path === href || path.startsWith(`${href}/`);
	}
</script>

<nav class="nav" aria-label="Primary">
	<!-- Home is /home, not "/" - "/" is the signed-out door and redirects back
	     here anyway. -->
	<a class="nav-mark" href={resolve(onboarded ? '/home' : '/onboarding')}>PHANTOM</a>

	<div class="nav-links">
		{#each links as link (link.href)}
			<!-- undefined rather than false: aria-current="false" is a value screen
			     readers announce, and "not the current page" is not something worth
			     saying out loud on every other tab. -->
			<a
				class={['nav-link', link.href === '/account' && 'nav-me']}
				href={resolve(link.href)}
				aria-current={isActive(link.href) ? 'page' : undefined}
			>
				{#if link.href === '/account'}
					<!-- The account tab is you: just the picture, round, dithered like
					     every photograph here. -->
					{#if me.avatarUrl}
						<img class="nav-avatar" src={me.avatarUrl} alt="" />
					{:else}
						<DitherAvatar name={me.handle} class="nav-avatar" />
					{/if}
				{:else}
					{link.label}
				{/if}
			</a>
		{/each}
	</div>
</nav>
