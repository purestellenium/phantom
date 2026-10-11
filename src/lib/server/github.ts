/**
 * Talking to GitHub: whether a repository is one Ari can read, asked at ship
 * time. Public repositories only; the token, when configured, is only ever
 * sent to api.github.com.
 */
import { PROVIDER_TIMEOUT_MS } from '$lib/server/auth/oauth';
import { githubToken } from '$lib/server/env';

/** `owner/name` from a GitHub URL, or null for anything that is not one. */
export function parseGithubRepo(url: string | null): { owner: string; name: string } | null {
	if (!url) return null;
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return null;
	}
	if (!/^(www\.)?github\.com$/i.test(parsed.hostname)) return null;
	const [owner, rawName] = parsed.pathname.split('/').filter(Boolean);
	const name = rawName?.replace(/\.git$/i, '');
	const safe = /^[A-Za-z0-9_.-]+$/;
	if (!owner || !name || !safe.test(owner) || !safe.test(name)) return null;
	return { owner, name };
}

export class GithubError extends Error {
	constructor(
		message: string,
		/** GitHub's status, when it answered at all. */
		readonly status: number | null = null
	) {
		super(message);
	}
}

const GITHUB_API = 'https://api.github.com';

/**
 * One request to GitHub's API, with the errors a reviewer can act on turned
 * into sentences. The configured token rides along when there is one, which
 * is what lifts the limit from sixty requests an hour to five thousand.
 */
export async function github(path: string, init: RequestInit = {}): Promise<unknown> {
	const token = githubToken();
	let response: Response;
	try {
		response = await fetch(`${GITHUB_API}${path}`, {
			...init,
			headers: {
				accept: 'application/vnd.github+json',
				'user-agent': 'phantom',
				'x-github-api-version': '2022-11-28',
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...init.headers
			},
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
			cache: 'no-store'
		});
	} catch {
		throw new GithubError('Could not reach GitHub.');
	}
	if (response.status === 404) {
		throw new GithubError('GitHub has no such repository, or it is private.', 404);
	}
	if (response.status === 403 || response.status === 429) {
		throw new GithubError(
			'GitHub is rate-limiting this server. Try again later, or set GITHUB_TOKEN.',
			response.status
		);
	}
	if (!response.ok) throw new GithubError(`GitHub answered ${response.status}.`, response.status);
	return response.json();
}

/**
 * Whether a repository is public on GitHub, as far as can be told right now.
 *
 * `missing` is GitHub's own 404 - no such repository, or a private one, which
 * it refuses to tell apart - and is the only answer a ship is refused on.
 * `unknown` is everything that is not an answer: not a GitHub URL at all, a
 * rate limit, an outage. A check that cannot be made lets the ship through
 * and leaves the repository to Ari.
 */
export async function repoVisibility(
	url: string | null
): Promise<'public' | 'missing' | 'unknown'> {
	const repo = parseGithubRepo(url);
	if (!repo) return 'unknown';
	try {
		const body = await github(`/repos/${repo.owner}/${repo.name}`);
		const isPrivate =
			typeof body === 'object' && body !== null && (body as { private?: unknown }).private === true;
		return isPrivate ? 'missing' : 'public';
	} catch (error) {
		return error instanceof GithubError && error.status === 404 ? 'missing' : 'unknown';
	}
}
