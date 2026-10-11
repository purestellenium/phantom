import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => {
	const dev = command === 'serve';

	return {
		plugins: [
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},

				/* A plain Node server: `node build`, in the Dockerfile and on Orchard
				   alike. Named rather than left to adapter-auto, which only resolved
				   to this on Orchard's builder and produces no server at all in a
				   plain `docker build`. Reads PORT, BODY_SIZE_LIMIT, PROTOCOL_HEADER,
				   HOST_HEADER and the rest at runtime - see
				   https://svelte.dev/docs/kit/adapter-node. */
				adapter: adapter(),

				/* The content security policy.

				   The console has one-click destructive actions, so `frame-ancestors` is
				   the one that matters most: without it any page anywhere can load them
				   in an invisible iframe and collect the click.

				   Written here rather than as a header in hooks.server.ts because
				   SvelteKit attaches a nonce to every inline script it emits itself, so
				   `script-src` needs no 'unsafe-inline'. Styles still do: Svelte injects
				   component styles inline in development.

				   Everything else this app loads is its own: self-hosted fonts, two
				   images, a canvas. `default-src 'self'` is a description, not an
				   aspiration. The one outside origin it talks to is Plausible, in
				   connect-src. */
				csp: {
					mode: 'auto',
					directives: {
						'default-src': ['self'],
						'script-src': ['self'],
						'style-src': ['self', 'unsafe-inline'],
						/* `https:` so a project screenshot hosted anywhere can render as a
						   banner — images cannot execute, and the alternative is proxying
						   every screenshot. Still no `http:`, so nothing loads over plaintext. */
						'img-src': ['self', 'data:', 'blob:', 'https:'],
						'font-src': ['self'],
						/* Plausible is the analytics tracker's event endpoint - the
						   tracker itself is bundled, so script-src stays 'self'. A
						   PLAUSIBLE_ENDPOINT on another origin has to be added here too.
						   The websocket is Vite's hot reload, and only exists in
						   development. */
						'connect-src': dev
							? ['self', 'https://plausible.io', 'ws:', 'wss:']
							: ['self', 'https://plausible.io'],
						/* The providers are here because `form-action` is checked against
						   the whole redirect chain, not just the URL in the action
						   attribute. The landing page's form submits to /api/auth/hca/start
						   — same origin — which answers 302 to the provider's authorize
						   endpoint, and Chrome refuses that hop against 'self'. It refuses
						   it SILENTLY: no console error, no navigation, a button that does
						   nothing.

						   Named origins rather than a wildcard, and only the two we
						   actually hand a browser to. This does not let a page here post
						   anywhere else. */
						'form-action': ['self', 'https://auth.hackclub.com', 'https://hackatime.hackclub.com'],
						'frame-ancestors': ['none'],
						'base-uri': ['self'],
						'object-src': ['none']
					}
				},

				typescript: {
					config: (config) => {
						config.include.push('../drizzle.config.ts');
					}
				}
			})
		]
	};
});
