<script lang="ts">
	/**
	 * The landing page's two auth paths, offered once the site is open.
	 *
	 * Sign-up sends the entered address as HCA's login_hint. Log-in deliberately
	 * omits it, so an existing user goes straight to HCA without satisfying the
	 * sign-up field first. Both remain a plain form and a plain link, and work
	 * without scripts.
	 */
	import { resolve } from '$app/paths';

	let { configured, email = null }: { configured: boolean; email?: string | null } = $props();
</script>

{#if !configured}
	<!-- The variable names go to the server log, not here. This is the least
	     private page in the application - signed out, unauthenticated, the first
	     thing anyone pointing a scanner at the domain reads - and naming the
	     missing secrets would tell them which identity provider this is and that
	     the deployment is half-finished. -->
	<div class="notice is-bad" role="status">
		<span class="notice-title">signing in is not available yet</span>
		<span class="notice-body">nobody can sign in to this instance at the moment.</span>
	</div>
{:else}
	<!-- No `redirectTo` here. The route defaults to the dashboard, and naming it
	     in the markup would be a second place to keep it in step. -->
	<form class="landing-auth" method="get" action={resolve('/api/auth/hca/start')}>
		<label class="sr-only" for="landing-email">email</label>
		<input
			class="control-input"
			id="landing-email"
			name="email"
			type="email"
			autocomplete="email"
			placeholder="your@email.com"
			value={email ?? ''}
			required
		/>

		<button class="control-btn" type="submit">sign up</button>

		<a class="control-btn is-quiet" href={resolve('/api/auth/hca/start')}>log in</a>
	</form>
{/if}
