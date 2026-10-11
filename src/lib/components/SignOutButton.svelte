<!--
	Sign out.

	A real form doing a real POST, with no enhancement anywhere in it. Signing
	out is the one action that has to work when everything else has failed -
	including the JavaScript - because the reason someone reaches for it may well
	be that they are on a machine that is not theirs. A button with an onclick
	that fetches would leave them signed in if the bundle never arrived.

	POST rather than a link, because a GET that destroys a session is a session
	any <img> on any page can destroy for you.

	Quiet, because it is never the primary action on the surface it sits on: the
	.is-quiet variant is the same geometry one level down the ramp.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
</script>

<form action={resolve('/api/auth/signout')} method="post">
	<button type="submit" class="control-btn is-quiet">sign out</button>
</form>
