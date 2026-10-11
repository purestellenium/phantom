import { Marked } from 'marked';
import type { Tokens } from 'marked';

/**
 * The guides, from the markdown copies in $lib/guides/content.
 *
 * Those files are copied verbatim from horizons-guides, a Starlight site, so
 * they can be copied over again when it changes. What Starlight did for them
 * is done here instead: the frontmatter is read and `:::caution` asides become
 * boxes.
 *
 * Rendered once, when the module loads. The HTML is trusted: it comes from
 * files in this repository, never from a user.
 */

export type GuideHeading = { id: string; text: string };

/** Where a guide sits on the index: the two that decide how a review goes,
 *  the starter tutorials, and the rest. */
export type GuideGroup = 'ship' | 'build' | 'more';

export type Guide = {
	slug: string;
	title: string;
	description: string;
	group: GuideGroup;
	/** What it is about, in a word or two - web, python, game dev, git. */
	topic: string;
	/** Reading time at 200 words a minute, at least one. */
	minutes: number;
	headings: GuideHeading[];
	html: string;
};

export type GuideSummary = Pick<
	Guide,
	'slug' | 'title' | 'description' | 'group' | 'topic' | 'minutes'
> & { sections: number };

/* Each guide's group and topic, by slug. A guide not named here is "more". */
const PLACES: Record<string, { group: GuideGroup; topic: string }> = {
	readme: { group: 'ship', topic: 'docs' },
	git: { group: 'ship', topic: 'git' },
	website: { group: 'build', topic: 'web' },
	flask: { group: 'build', topic: 'python' },
	godot: { group: 'build', topic: 'game dev' },
	gamemaker: { group: 'build', topic: 'game dev' },
	'more-resources': { group: 'more', topic: 'links' }
};

const WORDS_PER_MINUTE = 200;

const files = import.meta.glob('../guides/content/*.md', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

/* The horizons-guides sidebar order, with gamemaker (not in that sidebar)
   next to godot. A new file not named here sorts after these, by name. */
const ORDER = ['readme', 'git', 'website', 'godot', 'gamemaker', 'flask', 'more-resources'];

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function safeUrl(href: string, kind: 'link' | 'image'): string | null {
	const value = href.trim();
	if (!value) return null;
	if (/[\u0000-\u001f\u007f]/.test(value)) return null;
	if (value.startsWith('#') || value.startsWith('/')) return value;
	const explicitScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
	if (!explicitScheme && !value.startsWith('//')) return value;
	try {
		const protocol = new URL(value, 'https://phantom.hackclub.com').protocol.toLowerCase();
		if (protocol === 'http:' || protocol === 'https:') return value;
		if (kind === 'link' && protocol === 'mailto:') return value;
		return null;
	} catch {
		return null;
	}
}

function plain(html: string): string {
	return html
		.replace(/<[^>]*>/g, '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&')
		.trim();
}

function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '') || 'section'
	);
}

/* Only the top-level `key: value` pairs. The nested `sidebar:` block is
   indented, so it never matches, and ORDER above replaces it. */
function frontmatter(source: string): { meta: Record<string, string>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
	if (!match) return { meta: {}, body: source };
	const meta: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
		if (pair && pair[2]) meta[pair[1]] = pair[2].replace(/^(['"])(.*)\1$/, '$2').trim();
	}
	return { meta, body: source.slice(match[0].length) };
}

/* Starlight's asides, `:::caution` or `:::caution[a title]` through `:::`.
   The blank lines around the inner text let marked parse it as markdown
   inside the HTML block. */
function prepare(body: string): string {
	return body
		.replace(
			/^:::(note|tip|caution|danger)(?:\[(.*?)\])?[ \t]*\r?\n([\s\S]*?)^:::[ \t]*$/gm,
			(_, kind: string, title: string | undefined, inner: string) =>
				[
					'',
					`<aside class="guide-aside is-${kind}">`,
					`<p class="guide-aside-title">${escapeAttr(title || kind)}</p>`,
					'',
					inner.trim(),
					'',
					'</aside>',
					''
				].join('\n')
		);
}

function render(body: string): { html: string; headings: GuideHeading[] } {
	const headings: GuideHeading[] = [];
	const seen = new Map<string, number>();
	const marked = new Marked({
		gfm: true,
		renderer: {
			/* The page title is the page's only h1, so a guide's own h1s
			   step down to h2. Every h2 is listed under "on this page". */
			heading({ tokens, depth }: Tokens.Heading) {
				const inner = this.parser.parseInline(tokens);
				const text = plain(inner);
				const base = slugify(text);
				const count = seen.get(base) ?? 0;
				seen.set(base, count + 1);
				const id = count ? `${base}-${count + 1}` : base;
				const level = Math.min(Math.max(depth, 2), 4);
				if (level === 2) headings.push({ id, text });
				return `<h${level} id="${id}">${inner}</h${level}>\n`;
			},
			link({ href, title, tokens }: Tokens.Link) {
				const inner = this.parser.parseInline(tokens);
				const safeHref = safeUrl(href, 'link');
				if (!safeHref) return inner;
				const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
				const target = /^https?:\/\//.test(safeHref)
					? ' target="_blank" rel="noopener noreferrer"'
					: '';
				return `<a href="${escapeAttr(safeHref)}"${titleAttr}${target}>${inner}</a>`;
			},
			/* A code block, with a copy button. The button is drawn here and
			   wired up by the guide page, which listens for clicks on any
			   `.guide-copy` - most of these blocks are commands to paste. */
			code({ text, lang }: Tokens.Code) {
				const language = lang?.trim().split(/\s+/)[0];
				const langAttr = language ? ` class="language-${escapeAttr(language)}"` : '';
				return (
					`<div class="guide-code"><button type="button" class="guide-copy">copy</button>` +
					`<pre><code${langAttr}>${escapeHtml(text)}</code></pre></div>\n`
				);
			},
			image({ href, title, text }: Tokens.Image) {
				const safeHref = safeUrl(href, 'image');
				if (!safeHref) return escapeAttr(text);
				const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
				return `<img src="${escapeAttr(safeHref)}" alt="${escapeAttr(text)}"${titleAttr} loading="lazy" />`;
			}
		}
	});
	const html = marked.parse(body, { async: false });
	return { html, headings };
}

function rank(slug: string): number {
	const index = ORDER.indexOf(slug);
	return index === -1 ? ORDER.length : index;
}

const guides: Guide[] = Object.entries(files)
	.map(([path, source]) => {
		const slug = (path.split('/').pop() ?? path).replace(/\.md$/, '').replace(/-guide$/, '');
		const { meta, body } = frontmatter(source);
		const prepared = prepare(body);
		const rendered = render(prepared);
		const words = plain(rendered.html).split(/\s+/).filter(Boolean).length;
		const place = PLACES[slug] ?? { group: 'more' as const, topic: 'guide' };
		return {
			slug,
			/* Lowercase, like every other page title here. */
			title: (meta.title ?? slug).toLowerCase(),
			description: meta.description ?? '',
			group: place.group,
			topic: place.topic,
			minutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
			...rendered
		};
	})
	.sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug));

function summary(guide: Guide): GuideSummary {
	const { slug, title, description, group, topic, minutes } = guide;
	return { slug, title, description, group, topic, minutes, sections: guide.headings.length };
}

export function listGuides(): GuideSummary[] {
	return guides.map(summary);
}

export function findGuide(
	slug: string
): { guide: Guide; previous: GuideSummary | null; next: GuideSummary | null } | null {
	const index = guides.findIndex((guide) => guide.slug === slug);
	if (index === -1) return null;
	return {
		guide: guides[index],
		previous: index > 0 ? summary(guides[index - 1]) : null,
		next: index < guides.length - 1 ? summary(guides[index + 1]) : null
	};
}
