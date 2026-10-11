/**
 * Fill a database with projects in every review state, a shop with orders in
 * every state, an audit trail and a job log, so the dashboard, the projects
 * page, the review queue, the explore gallery and the console all have
 * something to show.
 *
 * Refuses to run against anything but localhost unless `--remote` is passed:
 * the rows it writes are fiction, and the ledger it writes into is append-only.
 *
 * Idempotent: seeded people are keyed on a `seed:` subject, seeded projects on
 * their name per owner, orders on an idempotency key, job runs on a marker in
 * their result, so a second run adds nothing.
 *
 *   bun run db:seed:demo:local    pictures linked from picsum, nothing uploaded
 *   bun run db:seed:demo          pictures uploaded to the Hack Club CDN
 *   DATABASE_URL=postgres://... bun run db:seed:demo --remote
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql as raw } from 'drizzle-orm';
import postgres from 'postgres';

import {
	auditEvents,
	jobRuns,
	ledgerAccounts,
	ledgerEntries,
	orderTransitions,
	orders,
	productCategories,
	productRevisions,
	products,
	projectShowcase,
	projects,
	submissionTransitions,
	submissions,
	users,
	type OrderState,
	type SubmissionState,
	type UserRole
} from './schema';
import { databaseUrl } from './url';
import { uploadImageWithKey } from '../cdn-upload';

const url = databaseUrl();
const host = new URL(url).hostname;
const remote = process.argv.includes('--remote');
if (host !== 'localhost' && host !== '127.0.0.1' && !remote) {
	console.error(`refusing to seed demo data into ${host}: pass --remote to allow it.`);
	process.exit(1);
}
console.log(`seeding ${host}`);

const sql = postgres(url);
const db = drizzle(sql);

/**
 * Where a seeded picture comes from, which is the one thing about this script
 * that reaches outside the database.
 *
 * Two modes, because they answer different questions. The default uploads to
 * the Hack Club CDN, the same way the app itself does, so a seeded row is
 * byte-for-byte the row the app would have written - which is what you want
 * when the thing being tested is the picture pipeline, and what a staging
 * database should hold. `--local` points the rows straight at picsum instead
 * and uploads nothing: nothing is written to shared infrastructure, no API key
 * is needed, and every page renders identically, because nothing outside the
 * upload path checks that a stored URL is on the CDN.
 *
 * `--local` is the one to reach for on a laptop. A full run is about 130
 * distinct pictures, and uploading them puts 130 permanent public files on
 * infrastructure a lot of other people share, every time somebody reseeds.
 */
const local = process.argv.includes('--local');

const CDN_KEY = process.env.CDN_API_KEY?.trim();
if (!local && !CDN_KEY) {
	console.error(
		'CDN_API_KEY is not set; seeded pictures are CDN uploads. Pass --local to link them instead.'
	);
	process.exit(1);
}
console.log(local ? 'pictures: linked from picsum (no uploads)' : 'pictures: uploaded to the CDN');

/* A stock photograph for a seed name, resolved once per name and remembered
   for the run. In the uploading mode the source is only ever the bytes and
   what is stored is the CDN's url; in `--local` the source url IS what is
   stored. */
const pictures = new Map<string, string>();
async function picture(name: string, w: number, h: number): Promise<string> {
	const hit = pictures.get(name);
	if (hit) return hit;

	const from = `https://picsum.photos/seed/${encodeURIComponent(name)}/${w}/${h}.jpg`;

	/* Not fetched at all here: the row holds the url, and picsum serves it to
	   the browser the same as any other host would. Fetching it only to throw
	   the bytes away would make a local seed as slow as a real one for nothing. */
	if (local) {
		pictures.set(name, from);
		return from;
	}

	const source = await fetch(from);
	if (!source.ok) throw new Error(`could not fetch a stock picture for ${name}: ${source.status}`);
	const blob = new Blob([await source.arrayBuffer()], { type: 'image/jpeg' });
	const uploaded = await uploadImageWithKey(CDN_KEY as string, blob, `${name}.jpg`);
	pictures.set(name, uploaded);
	return uploaded;
}

type Db = typeof db;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const HOUR = 3600;
const DAY = 24 * HOUR * 1000;
const now = Date.now();
const daysAgo = (days: number) => new Date(now - days * DAY);
const hoursAfter = (at: Date, hours: number) => new Date(at.getTime() + hours * HOUR * 1000);

/** A small stable hash, so every run makes the same choices for the same name. */
function hash(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h;
}
const pick = <T>(list: readonly T[], seed: string): T => list[hash(seed) % list.length];

/* ── people ──────────────────────────────────────────────────────────────── */

type Role = Exclude<UserRole, 'owner' | 'admin'>;
type Person = { subject: string; email: string; name: string; role: Role; days: number };

function person(slug: string, name: string, role: Role = 'participant'): Person {
	return {
		subject: `seed:${slug}`,
		email: `${slug}@example.com`,
		name,
		role,
		days: 20 + (hash(slug) % 70)
	};
}

const PEOPLE: Person[] = [
	person('reviewer', 'Wren Okafor', 'reviewer'),
	person('reviewer2', 'Ines Farrow', 'reviewer'),
	person('reviewer3', 'Bao Nguyen', 'reviewer'),
	person('p1', 'Mira Tanaka'),
	person('p2', 'Devika Rao'),
	person('p3', 'Theo Lindqvist'),
	person('p4', 'Sol Ibarra'),
	person('p5', 'Ayo Bello'),
	person('p6', 'Kit Marlowe'),
	person('p7', 'June Park'),
	person('p8', 'Rafael Mendes'),
	person('p9', 'Priya Natarajan'),
	person('p10', 'Oskar Weiss'),
	person('p11', 'Amara Diallo'),
	person('p12', 'Leo Castellano'),
	person('p13', 'Hana Sato'),
	person('p14', 'Tomas Novak'),
	person('p15', 'Zara Hussain'),
	person('p16', 'Elias Berg'),
	person('p17', 'Noor Haddad'),
	person('p18', 'Felix Adeyemi'),
	person('p19', 'Ivy Chen'),
	person('p20', 'Marcus Reid'),
	person('p21', 'Sienna Walsh'),
	person('p22', 'Dmitri Volkov'),
	person('p23', 'Lucia Ferreira'),
	person('p24', 'Kai Nakamura'),
	person('p25', 'Bea Okonkwo'),
	person('p26', 'Yusuf Demir'),
	person('p27', 'Rosa Alvarez'),
	person('p28', 'Ezra Cohen')
];

async function ensurePeople(): Promise<Map<string, string>> {
	const ids = new Map<string, string>();
	for (const p of PEOPLE) {
		const joined = daysAgo(p.days);
		const [inserted] = await db
			.insert(users)
			.values({
				hcaSubject: p.subject,
				email: p.email,
				displayName: p.name,
				slackUsername: p.name.split(' ')[0].toLowerCase(),
				avatarUrl: await picture(`avatar-${p.subject}`, 240, 240),
				verificationStatus: 'verified',
				verificationStatusAt: joined,
				yswsEligibleClaim: true,
				yswsEligibleClaimAt: joined,
				identityCheckResult: 'verified_eligible',
				identityCheckAt: joined,
				birthdate: `200${7 + (hash(p.subject) % 4)}-0${1 + (hash(p.name) % 9)}-1${hash(p.email) % 9}`,
				eligibility: 'eligible',
				eligibilityAt: joined,
				eligibilityRule: 'seed',
				role: p.role,
				capabilities: p.role === 'reviewer' ? ['review_submissions'] : [],
				onboardedAt: hoursAfter(joined, 1),
				createdAt: joined,
				updatedAt: joined,
				lastSeenAt: daysAgo(hash(p.subject) % 6)
			})
			.onConflictDoNothing({ target: users.hcaSubject })
			.returning({ id: users.id });
		const [row] = inserted
			? [inserted]
			: await db
					.select({ id: users.id })
					.from(users)
					.where(eq(users.hcaSubject, p.subject))
					.limit(1);
		ids.set(p.subject, row.id);

		if (inserted) {
			const signIns = 2 + (hash(p.subject) % 9);
			await db.insert(auditEvents).values([
				{
					subjectId: row.id,
					action: 'user.created',
					metadata: { provider: 'hca', seededAdmin: false, seededOwner: false },
					createdAt: joined
				},
				{
					actorId: row.id,
					subjectId: row.id,
					action: 'onboarding.finished',
					metadata: { hackatimeAccountId: String(10000 + (hash(p.email) % 90000)) },
					createdAt: hoursAfter(joined, 1)
				},
				...Array.from({ length: signIns }, (_, i) => ({
					actorId: row.id,
					subjectId: row.id,
					action: 'session.created',
					metadata: { sessionId: crypto.randomUUID(), provider: 'hca' },
					createdAt: daysAgo((p.days * (signIns - i)) / (signIns + 1))
				}))
			]);
		}
	}
	return ids;
}

/* ── scenarios ───────────────────────────────────────────────────────────── */

/** One shipped submission and what happened to it. `claimed` is cumulative
 *  Hackatime hours at ship time; `award` is the hours granted. */
type Ship = {
	state: SubmissionState;
	claimed: number;
	award?: number;
	daysAgo: number;
	changelog?: string;
	message?: string;
};

type Scenario = {
	name: string;
	description: string;
	repo: string;
	demo: string;
	hackatime: string;
	ai: string;
	/** The owner's "this is an update to something that already existed" mark,
	 *  for a project that came from another program. Absent on most of them; the
	 *  one that carries it is what exercises the declared-update justification. */
	updateDeclaration?: string;
	ships: Ship[];
};

const APPROVED_MESSAGES = [
	'Approved. Nice work.',
	'Approved. The demo is exactly what the description promises.',
	'Approved. The README is clear.',
	'Approved for the full claim. Clean code, well scoped.',
	'Approved. Loved the attention to the edge cases in the parser.',
	'Approved. Nice polish on the interface.',
	'Approved. Ship the next version when you have it.'
];

const FIRST_PASS_MESSAGES = [
	'Looks solid. Proposing the hours.',
	'Proposing the full claim.',
	'Demo works, repo builds. Proposing the hours.',
	'Proposing the hours. Nice project.',
	'Nearly there. Proposing the claim.',
	'Proposing six hours for the overdub work.'
];

const REJECTED_MESSAGES = [
	'The demo link is dead and the repo has no README. Fix both and reship.',
	'Need a demo that shows it actually running.',
	'The repo is private. Make it public and reship.',
	'The linked Hackatime project looks wrong. Link the right project and reship.',
	'The description does not match the project. Update it and reship.',
	'The screenshot is a placeholder. Upload a real one and reship.',
	'The README does not explain how to run it. Add that and reship.',
	'The demo needs an account to view. Add a guest path or a video and reship.'
];

const CHANGELOGS = [
	'Overdubs and a metronome.',
	'Projects, reviews, the explore page and the console.',
	'Card grid on the projects page, new project form, nav fixes.',
	'Rewrote the parser and added tests for the tricky inputs.',
	'Mobile layout, keyboard shortcuts, and a settings page.',
	'Offline mode and a sync conflict resolver.',
	'Swapped the polling loop for websockets and fixed the memory leak.',
	'Dark mode, export to CSV, and a proper onboarding flow.'
];

const AI_DECLARATIONS = [
	'Used Claude for boilerplate and to explain a few error messages. All logic is mine.',
	'No AI used.',
	'Copilot for autocomplete only. Every function was written and understood by me.',
	'Asked ChatGPT to explain the Bluetooth spec. Wrote all the code myself.',
	'Claude wrote the first draft of the README. Everything else is mine.',
	'Used an LLM to generate test fixtures. Application code is hand written.'
];

function project(
	name: string,
	description: string,
	slug: string,
	shipList: Ship[],
	extra: Partial<Scenario> = {}
): Scenario {
	return {
		name,
		description,
		repo: `https://github.com/example/${slug}`,
		demo: `https://${slug}.example.com`,
		hackatime: slug,
		ai: pick(AI_DECLARATIONS, slug),
		ships: shipList,
		...extra
	};
}

const ships = {
	draft: (): Ship[] => [],
	pending: (claimed: number, d = 2): Ship[] => [{ state: 'pending', claimed, daysAgo: d }],
	firstPassed: (claimed: number, award: number, d = 4): Ship[] => [
		{ state: 'first_passed', claimed, award, daysAgo: d, message: FIRST_PASS_MESSAGES[0] }
	],
	approved: (claimed: number, award: number, d = 10): Ship[] => [
		{ state: 'approved', claimed, award, daysAgo: d, message: APPROVED_MESSAGES[0] }
	],
	rejected: (claimed: number, d = 7): Ship[] => [
		{ state: 'rejected', claimed, daysAgo: d, message: REJECTED_MESSAGES[0] }
	]
};

/** Your account gets every state, including the multi-ship ones. */
const OWNER_PROJECTS: Scenario[] = [
	project(
		'phantom platform',
		'The site you are looking at. SvelteKit, Postgres, a dithered field behind everything.',
		'phantom-platform',
		[
			{ state: 'approved', claimed: 22, award: 20, daysAgo: 30, message: 'Approved. Nice work.' },
			{
				state: 'approved',
				claimed: 41,
				award: 18,
				daysAgo: 14,
				changelog: 'Projects, reviews, the explore page and the console.',
				message: 'Second ship approved.'
			},
			{
				state: 'pending',
				claimed: 52,
				daysAgo: 1,
				changelog: 'Card grid on the projects page, new project form, nav fixes.'
			}
		]
	),
	project(
		'weather clock',
		'An e-ink clock that shows the forecast for the next six hours as a strip.',
		'weather-clock',
		ships.approved(9, 8, 20)
	),
	project(
		'tiny synth',
		'A browser synth with a step sequencer and a handful of presets.',
		'tiny-synth',
		ships.firstPassed(6, 5)
	),
	/* The declared update: nothing in Phantom's history says this is one, so the
	   [UPDATE] justification on it comes entirely from the owner's own mark.
	   Pending, so the full-review scaffold is the thing that draws it. */
	project(
		'pocket wiki',
		'Offline-first personal wiki. Markdown in, static site out, syncs over git.',
		'pocket-wiki',
		ships.pending(4),
		{
			updateDeclaration:
				'I first shipped this to Arcade last summer as a plain markdown viewer - ' +
				'reading only, no editing, no sync. Since then I have added the editor, ' +
				'the git sync, and the static export, which is most of what is here now.'
		}
	),
	project(
		'bus tracker',
		'Live map of the buses near school, pulled from the transit feed.',
		'bus-tracker',
		ships.rejected(3)
	),
	project(
		'dotfiles manager',
		'Symlinks, templates and a bootstrap script for a fresh machine.',
		'dotfiles',
		[
			{
				state: 'rejected',
				claimed: 5,
				daysAgo: 9,
				message: 'Need a demo that shows it actually running.'
			},
			{ state: 'pending', claimed: 5, daysAgo: 2 }
		]
	),
	project(
		'flashcards',
		'Spaced repetition in the terminal. Decks are plain text.',
		'flashcards',
		ships.pending(7, 3)
	),
	project('game of life screensaver', '', 'gol-saver', ships.draft()),
	project(
		'recipe scaler',
		'Paste a recipe, pick how many people, get the maths done.',
		'recipe-scaler',
		ships.draft()
	)
];

/** The pool everyone else draws from. Name, description, slug. */
const POOL: [string, string, string][] = [
	[
		'pixel garden',
		'A garden that grows as you commit. Every push waters something.',
		'pixel-garden'
	],
	['chess trainer', 'Puzzles pulled from your own lost games.', 'chess-trainer'],
	['lunch poll', 'Slack bot that settles where the group eats.', 'lunch-poll'],
	[
		'ring buffer logger',
		'Structured logging for microcontrollers with a tiny flash footprint.',
		'ring-logger'
	],
	['font pairer', 'Drop in two fonts and see them on real layouts.', 'font-pairer'],
	['cli pomodoro', 'A timer that nags you in the terminal.', 'cli-pomodoro'],
	['sailing log', 'Track wind, tide and where you actually went.', 'sailing-log'],
	['midi looper', 'Four-track MIDI looper for a launchpad.', 'midi-looper'],
	[
		'homework planner',
		'Pulls assignments from the school portal into a calendar.',
		'homework-planner'
	],
	['pcb badge', 'A conference badge with an LED matrix and a snake game.', 'pcb-badge'],
	['tide chart', '', 'tide-chart'],
	['lyrics quiz', 'Guess the song from one line.', 'lyrics-quiz'],
	['plant cam', 'Timelapse rig for a windowsill, posts to a channel daily.', 'plant-cam'],
	['keyboard firmware', 'QMK fork for a split board I designed.', 'kb-firmware'],
	['markdown slides', 'Write slides in markdown, present from the browser.', 'md-slides'],
	['ascii raytracer', 'A raytracer that renders to the terminal.', 'ascii-rt'],
	['bird counter', 'Counts birds at the feeder with a webcam and a small model.', 'bird-counter'],
	['sleep tracker', 'A bedside sensor and a chart of how badly you slept.', 'sleep-tracker'],
	['bookmark sync', 'Bookmarks in a text file, synced across every browser.', 'bookmark-sync'],
	['gcode viewer', 'Preview a 3D print layer by layer before sending it.', 'gcode-viewer'],
	['pico oscilloscope', 'A two-channel scope on a Pico with a web front end.', 'pico-scope'],
	['stardew planner', 'Plan a farm layout and see what each season yields.', 'stardew-planner'],
	[
		'podcast clipper',
		'Cut a podcast into shareable clips with transcript search.',
		'podcast-clipper'
	],
	['budget bot', 'Reads bank exports and tells you what you actually spend on.', 'budget-bot'],
	['reef monitor', 'Temperature, pH and salinity for a fish tank, with alerts.', 'reef-monitor'],
	['route runner', 'Draws running routes of a given length from your door.', 'route-runner'],
	['emoji kitchen', 'Mash two emoji into one and download the result.', 'emoji-kitchen'],
	['soldering timer', 'Reflow oven controller with a profile editor.', 'reflow-controller'],
	[
		'bike computer',
		'Cadence, speed and a map on an old phone strapped to the bars.',
		'bike-computer'
	],
	[
		'queue for the printer',
		'One 3D printer, fourteen students, no more arguments.',
		'printer-queue'
	],
	['lock screen quotes', 'A new quote on the lock screen every morning.', 'lock-quotes'],
	['pixel font editor', 'Draw a bitmap font and export it as a header file.', 'pixel-font'],
	['mesh chat', 'LoRa messaging between two radios, no internet.', 'mesh-chat'],
	['exam countdown', 'Every exam on one page with the days left in big numbers.', 'exam-countdown'],
	['library scanner', 'Scan a barcode, catalogue the book, find it later.', 'library-scanner'],
	['vinyl shelf', 'Photograph the shelf and get a searchable list of records.', 'vinyl-shelf'],
	[
		'bell schedule',
		'The school bell schedule as a widget, including the weird days.',
		'bell-schedule'
	],
	['garden sensor', 'Soil moisture over LoRa to a dashboard on the fridge.', 'garden-sensor'],
	['pomodoro lamp', 'A lamp that changes colour as the timer runs down.', 'pomodoro-lamp'],
	['shader playground', 'Write a fragment shader and see it on a cube.', 'shader-playground'],
	['debate timer', 'Timings for every debate format, with the bell.', 'debate-timer'],
	['comic reader', 'Reads CBZ files with a page-by-page swipe on a phone.', 'comic-reader'],
	[
		'train departures',
		'The next four trains from the station near school, on an e-ink display.',
		'train-departures'
	],
	['guitar tuner', 'Web audio tuner with a needle that does not jitter.', 'guitar-tuner'],
	['chore wheel', 'Rotates the chores between housemates and nags on Slack.', 'chore-wheel'],
	['sprite packer', 'Pack loose PNGs into an atlas with a JSON map.', 'sprite-packer'],
	['transit heatmap', 'Where the buses are late, drawn on a map by hour.', 'transit-heatmap'],
	['flight logbook', 'A pilot logbook with totals by aircraft type.', 'flight-logbook'],
	['dice roller', 'Roll any dice expression and see the distribution.', 'dice-roller'],
	['recipe box', 'Recipes with scaling, timers and a shopping list.', 'recipe-box'],
	['kanji drill', 'Stroke order practice with a drawing canvas.', 'kanji-drill'],
	['boat speedo', 'GPS speed and heading on a waterproofed phone.', 'boat-speedo'],
	['climb log', 'Log every route, see what grade you actually climb.', 'climb-log'],
	['status page', 'Pings a list of services and shows a month of uptime.', 'status-page'],
	['macro pad', 'Nine keys, a rotary encoder, and firmware I understand.', 'macro-pad'],
	['weather station', 'Wind, rain and pressure from the roof, charted.', 'weather-station'],
	['clipboard history', 'Everything you copied today, searchable.', 'clipboard-history'],
	['pixel art scaler', 'Scale pixel art without blurring it.', 'pixel-scaler'],
	['tab groups', 'Save and restore sets of browser tabs by project.', 'tab-groups'],
	['rover', 'A four-wheel rover driven from a browser over wifi.', 'rover'],
	['music theory quiz', 'Intervals and chords, by ear.', 'theory-quiz'],
	[
		'calendar merge',
		'Three school calendars into one that is actually readable.',
		'calendar-merge'
	],
	['drone logger', 'Flight logs from a small drone, mapped.', 'drone-logger'],
	['seedling tracker', 'When you planted what and when it should sprout.', 'seedling-tracker'],
	['noise meter', 'How loud is the classroom, over the day, on a chart.', 'noise-meter'],
	['reading list', 'Books to read, books read, and how long each took.', 'reading-list'],
	['ham log', 'Amateur radio contact log with a map of who you reached.', 'ham-log'],
	['pinball scoreboard', 'High scores for the machine in the common room.', 'pinball-scores'],
	['puzzle cube timer', 'Cube solve timer with averages and a scramble generator.', 'cube-timer'],
	['screenshot ocr', 'Drag a screenshot in, get the text out.', 'screenshot-ocr'],
	[
		'bus stop display',
		'Live arrivals on a little display at the stop outside.',
		'bus-stop-display'
	],
	['star chart', 'What is overhead right now, from where you are.', 'star-chart'],
	['card game engine', 'A rules engine for a card game I made up.', 'card-engine'],
	['soundboard', 'A soundboard for the school radio show.', 'soundboard'],
	['fridge inventory', 'What is in the fridge and when it goes off.', 'fridge-inventory'],
	['choir parts', 'Split a choir score into practice tracks per voice.', 'choir-parts'],
	['moss wall monitor', 'Humidity for the living wall, with a misting pump.', 'moss-monitor'],
	['bug tracker', 'A tiny issue tracker for the robotics team.', 'bug-tracker'],
	['tournament bracket', 'Brackets for the ping pong tournament with live scores.', 'bracket'],
	['lightning tracker', 'Counts strikes from a sensor and plots the storm.', 'lightning-tracker'],
	['typing tutor', 'Typing practice on real code instead of prose.', 'typing-tutor']
];

/** What happened to a pool project, chosen from its slug so every run agrees. */
function history(slug: string): Pick<Scenario, 'ships'> {
	const h = hash(slug);
	const claimed = 3 + (h % 30);
	const award = Math.max(1, claimed - (h % 4));
	const d = 1 + ((h >>> 8) % 40);
	const approved = pick(APPROVED_MESSAGES, `${slug}:a`);
	const proposed = pick(FIRST_PASS_MESSAGES, `${slug}:f`);
	const rejected = pick(REJECTED_MESSAGES, `${slug}:r`);
	const changelog = pick(CHANGELOGS, `${slug}:c`);
	switch ((h >>> 16) % 11) {
		case 0:
			return { ships: [] };
		case 1:
		case 2:
			return { ships: [{ state: 'pending', claimed, daysAgo: Math.min(d, 6) }] };
		case 3:
			return {
				ships: [
					{ state: 'first_passed', claimed, award, daysAgo: Math.min(d, 8), message: proposed }
				]
			};
		case 4:
		case 5:
		case 6:
			return { ships: [{ state: 'approved', claimed, award, daysAgo: d + 5, message: approved }] };
		case 7:
			return { ships: [{ state: 'rejected', claimed, daysAgo: d, message: rejected }] };
		case 8:
			return {
				ships: [
					{ state: 'approved', claimed, award, daysAgo: d + 15, message: approved },
					{
						state: 'pending',
						claimed: claimed + 6 + (h % 9),
						daysAgo: Math.min(d, 5),
						changelog
					}
				]
			};
		case 9:
			return {
				ships: [
					{ state: 'rejected', claimed, daysAgo: d + 4, message: rejected },
					{ state: 'pending', claimed: claimed + 1, daysAgo: Math.min(d, 4) }
				]
			};
		default:
			return {
				ships: [
					{ state: 'approved', claimed, award, daysAgo: d + 20, message: approved },
					{
						state: 'approved',
						claimed: claimed + 8,
						award: 7,
						daysAgo: d + 9,
						changelog,
						message: pick(APPROVED_MESSAGES, `${slug}:a2`)
					},
					{
						state: 'first_passed',
						claimed: claimed + 14,
						award: 5,
						daysAgo: Math.min(d, 3),
						changelog: pick(CHANGELOGS, `${slug}:c2`),
						message: proposed
					}
				]
			};
	}
}

const POOL_SCENARIOS: Scenario[] = POOL.map(([name, description, slug]) =>
	project(name, description, slug, history(slug).ships)
);

/** Real accounts get every hand-written scenario plus a slice of the pool;
 *  seeded people share the rest of the pool between them. */
function assign(
	real: { id: string }[],
	seeded: string[]
): { forReal: Scenario[][]; forSeeded: Map<string, Scenario[]> } {
	const perReal = 10;
	const forReal = real.map((_, i) => [
		...OWNER_PROJECTS,
		...POOL_SCENARIOS.filter((_, j) => j % real.length === i).slice(0, perReal)
	]);
	const forSeeded = new Map<string, Scenario[]>();
	seeded.forEach((subject, i) => {
		forSeeded.set(
			subject,
			POOL_SCENARIOS.filter((_, j) => j % seeded.length === i)
		);
	});
	return { forReal, forSeeded };
}

/* ── writing ─────────────────────────────────────────────────────────────── */

async function existingProject(tx: Tx, userId: string, name: string): Promise<boolean> {
	const [row] = await tx
		.select({ id: projects.id })
		.from(projects)
		.where(and(eq(projects.userId, userId), eq(projects.name, name)))
		.limit(1);
	return row !== undefined;
}

async function ledgerAccount(tx: Tx, userId: string): Promise<string> {
	await tx
		.insert(ledgerAccounts)
		.values({ userId, currency: 'seconds' })
		.onConflictDoNothing({ target: [ledgerAccounts.userId, ledgerAccounts.currency] });
	const [account] = await tx
		.select({ id: ledgerAccounts.id })
		.from(ledgerAccounts)
		.where(and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.currency, 'seconds')))
		.limit(1);
	return account.id;
}

async function recache(tx: Tx, accountId: string): Promise<void> {
	const [sum] = await tx
		.select({ total: raw<number>`coalesce(sum(${ledgerEntries.amount}), 0)::bigint` })
		.from(ledgerEntries)
		.where(eq(ledgerEntries.accountId, accountId));
	await tx
		.update(ledgerAccounts)
		.set({ cachedBalance: Number(sum.total), updatedAt: new Date() })
		.where(eq(ledgerAccounts.id, accountId));
}

async function award(
	tx: Tx,
	input: {
		userId: string;
		submissionId: string;
		projectId: string;
		seconds: number;
		reason: string;
		actorId: string;
		at: Date;
	}
) {
	const accountId = await ledgerAccount(tx, input.userId);
	await tx
		.insert(ledgerEntries)
		.values({
			accountId,
			currency: 'seconds',
			amount: input.seconds,
			entryType: 'submission_award',
			reason: input.reason,
			idempotencyKey: `submission:${input.submissionId}:award`,
			actorId: input.actorId,
			metadata: {
				submissionId: input.submissionId,
				projectId: input.projectId,
				awardedSeconds: input.seconds
			},
			createdAt: input.at
		})
		.onConflictDoNothing();
	await recache(tx, accountId);
}

type Owner = { id: string; role: UserRole; name: string };
type Reviewer = { id: string; name: string };

async function writeScenario(
	tx: Tx,
	scenario: Scenario,
	owner: Owner,
	reviewers: Reviewer[],
	approver: Reviewer
): Promise<'created' | 'skipped'> {
	if (await existingProject(tx, owner.id, scenario.name)) return 'skipped';

	const reviewer = pick(reviewers, `${owner.id}:${scenario.hackatime}`);
	const firstShip = scenario.ships[0]?.daysAgo ?? 3;
	const createdAt = daysAgo(firstShip + 2 + (hash(scenario.hackatime) % 9));
	const shot = await picture(scenario.hackatime, 1200, 630);
	const [proj] = await tx
		.insert(projects)
		.values({
			userId: owner.id,
			name: scenario.name,
			description: scenario.description || null,
			repoUrl: scenario.repo,
			demoUrl: scenario.demo,
			screenshotUrl: shot,
			hackatimeProjects: scenario.hackatime,
			aiDeclaration: scenario.ai,
			updateDeclaration: scenario.updateDeclaration ?? null,
			createdAt,
			updatedAt: createdAt
		})
		.returning({ id: projects.id });
	await tx.insert(auditEvents).values({
		actorId: owner.id,
		subjectId: owner.id,
		action: 'project.created',
		metadata: { projectId: proj.id },
		createdAt
	});

	let approvedTotal = 0;
	let latestApproved: typeof submissions.$inferSelect | null = null;

	for (const ship of scenario.ships) {
		const shippedAt = daysAgo(ship.daysAgo);
		const passedAt = hoursAfter(shippedAt, 3);
		const decidedAt = hoursAfter(shippedAt, 6);
		const awardSeconds = ship.award ? ship.award * HOUR : null;
		const isUpdate = ship.changelog !== undefined;
		const [sub] = await tx
			.insert(submissions)
			.values({
				projectId: proj.id,
				userId: owner.id,
				name: scenario.name,
				description: scenario.description || null,
				repoUrl: scenario.repo,
				demoUrl: scenario.demo,
				screenshotUrl: shot,
				hackatimeProjects: scenario.hackatime,
				aiDeclaration: scenario.ai,
				updateDeclaration: scenario.updateDeclaration ?? null,
				claimedSeconds: ship.claimed * HOUR,
				changelog: ship.changelog ?? null,
				state: ship.state,
				stateAt:
					ship.state === 'pending'
						? shippedAt
						: ship.state === 'first_passed'
							? passedAt
							: decidedAt,
				reviewerId: ship.state === 'pending' ? null : reviewer.id,
				approverId: ship.state === 'approved' ? approver.id : null,
				awardedSeconds: awardSeconds,
				publicMessage: ship.message ?? null,
				justification:
					ship.state === 'pending'
						? null
						: ship.state === 'approved'
							? `[SEED]\n\nSubmitted hours: ${ship.claimed}h\nFinal time accepted: ${ship.award}h\n\nFirst pass by @${reviewer.name}\nSecond pass by @${approver.name}`
							: 'Seeded review note.',
				createdAt: shippedAt
			})
			.returning();

		await tx.insert(submissionTransitions).values({
			submissionId: sub.id,
			fromState: null,
			toState: 'pending',
			actorId: owner.id,
			actorRole: owner.role,
			reason: isUpdate ? 'update ship by the participant' : 'shipped by the participant',
			metadata: { claimedSeconds: ship.claimed * HOUR },
			createdAt: shippedAt
		});
		await tx.insert(auditEvents).values({
			actorId: owner.id,
			subjectId: owner.id,
			action: 'submission.shipped',
			metadata: {
				submissionId: sub.id,
				projectId: proj.id,
				claimedSeconds: ship.claimed * HOUR,
				isUpdate
			},
			createdAt: shippedAt
		});

		if (ship.state === 'first_passed' || ship.state === 'approved') {
			await tx.insert(submissionTransitions).values({
				submissionId: sub.id,
				fromState: 'pending',
				toState: 'first_passed',
				actorId: reviewer.id,
				actorRole: 'reviewer',
				reason: ship.message ?? 'Proposing the hours.',
				internalNote: 'Seeded review note.',
				metadata: { awardedSeconds: awardSeconds },
				createdAt: passedAt
			});
			await tx.insert(auditEvents).values({
				actorId: reviewer.id,
				subjectId: owner.id,
				action: 'submission.first_passed',
				metadata: { submissionId: sub.id, awardedSeconds: awardSeconds },
				createdAt: passedAt
			});
		}
		if (ship.state === 'approved') {
			await tx.insert(submissionTransitions).values({
				submissionId: sub.id,
				fromState: 'first_passed',
				toState: 'approved',
				actorId: approver.id,
				actorRole: 'owner',
				reason: ship.message ?? 'Approved.',
				metadata: { awardedSeconds: awardSeconds, fullReview: false },
				createdAt: decidedAt
			});
			await tx.insert(auditEvents).values({
				actorId: approver.id,
				subjectId: owner.id,
				action: 'submission.approved',
				metadata: { submissionId: sub.id, awardedSeconds: awardSeconds, fullReview: false },
				createdAt: decidedAt
			});
			await award(tx, {
				userId: owner.id,
				submissionId: sub.id,
				projectId: proj.id,
				seconds: awardSeconds ?? 0,
				reason: scenario.name,
				actorId: approver.id,
				at: decidedAt
			});
			approvedTotal += awardSeconds ?? 0;
			latestApproved = sub;
		}
		if (ship.state === 'rejected') {
			await tx.insert(submissionTransitions).values({
				submissionId: sub.id,
				fromState: 'pending',
				toState: 'rejected',
				actorId: reviewer.id,
				actorRole: 'reviewer',
				reason: ship.message ?? 'Rejected.',
				internalNote: 'Seeded review note.',
				createdAt: decidedAt
			});
			await tx.insert(auditEvents).values({
				actorId: reviewer.id,
				subjectId: owner.id,
				action: 'submission.rejected',
				metadata: { submissionId: sub.id },
				createdAt: decidedAt
			});
		}
	}

	if (latestApproved) {
		await tx.insert(projectShowcase).values({
			projectId: proj.id,
			name: latestApproved.name,
			description: latestApproved.description,
			screenshotUrl: latestApproved.screenshotUrl,
			demoUrl: latestApproved.demoUrl,
			repoUrl: latestApproved.repoUrl,
			totalApprovedSeconds: approvedTotal,
			updatedAt: latestApproved.stateAt
		});
	}

	return 'created';
}

/* ── the shop ────────────────────────────────────────────────────────────── */

/* Enough shelves for the shop's filter row to be worth looking at, and one
   product ('flight') deliberately left off all of them - an empty category
   slot is a state the page has to render, and a demo where everything is
   filed hides whether it does. */
const CATEGORIES = [
	{ slug: 'wearables', name: 'wearables', position: 1 },
	{ slug: 'hardware', name: 'hardware', position: 2 },
	{ slug: 'desk', name: 'desk', position: 3 },
	{ slug: 'services', name: 'services', position: 4 }
] as const;

const PRODUCTS = [
	{
		slug: 'sticker-pack',
		name: 'sticker pack',
		description: 'Six phantom stickers. Die-cut, matte, made to go on a laptop lid.',
		kind: 'physical',
		category: 'desk',
		hours: 2,
		stock: 200,
		perUserLimit: 3
	},
	{
		slug: 'phantom-tee',
		name: 'phantom tee',
		description: 'Heavyweight black tee with the wordmark screen printed on the chest.',
		kind: 'physical',
		category: 'wearables',
		hours: 8,
		stock: 60,
		perUserLimit: 2
	},
	{
		slug: 'hoodie',
		name: 'hoodie',
		description: 'The heavy one. Embroidered mark, kangaroo pocket, sleeves long enough.',
		kind: 'physical',
		category: 'wearables',
		hours: 18,
		stock: 25,
		perUserLimit: 1
	},
	{
		slug: 'pico',
		name: 'raspberry pi pico w',
		description: 'A microcontroller with wifi, headers soldered, in a little box.',
		kind: 'physical',
		category: 'hardware',
		hours: 4,
		stock: 40,
		perUserLimit: 2
	},
	{
		slug: 'domain',
		name: 'a domain for a year',
		description: 'Any .dev, .app or .com that is free. We register it, you own it.',
		kind: 'digital',
		category: 'services',
		hours: 6,
		stock: null,
		perUserLimit: 1
	},
	{
		slug: 'keyboard',
		name: 'mechanical keyboard',
		description: '65% layout, hot-swap switches, wired. Comes with the keycaps you would want.',
		kind: 'physical',
		category: 'hardware',
		hours: 30,
		stock: 8,
		perUserLimit: 1
	},
	{
		slug: 'flight',
		name: 'the flight',
		description: 'The whole point. Fifty hours gets you to the gathering.',
		/* Nothing ships, so `digital`. It was the one `grant` in the seed, and
		   `grant` is a category now - but this product stays deliberately
		   uncategorised for the reason the note above CATEGORIES gives. */
		kind: 'digital',
		category: null,
		hours: 50,
		stock: null,
		perUserLimit: 1
	},
	{
		slug: 'enamel-pin',
		name: 'enamel pin',
		description: 'The mark in hard enamel, with a rubber clutch so it stays on.',
		kind: 'physical',
		category: 'wearables',
		hours: 1,
		stock: 300,
		perUserLimit: 2
	},
	{
		slug: 'notebook',
		name: 'dot grid notebook',
		description: 'A5, 160 pages, lies flat. Wordmark blind-embossed on the cover.',
		kind: 'physical',
		category: 'desk',
		hours: 3,
		stock: 80,
		perUserLimit: 2
	},
	{
		slug: 'esp32',
		name: 'esp32 dev board',
		description: 'Wifi and Bluetooth, USB-C, in a box with a short cable.',
		kind: 'physical',
		category: 'hardware',
		hours: 5,
		stock: 40,
		perUserLimit: 2
	},
	{
		slug: 'soldering-iron',
		name: 'pinecil soldering iron',
		description: 'USB-C powered, heats in seconds, with a stand and a tip set.',
		kind: 'physical',
		category: 'hardware',
		hours: 12,
		stock: 20,
		perUserLimit: 1
	},
	{
		slug: 'cloud-credit',
		name: 'a year of hosting',
		description: 'Enough hosting credit to keep a project online for a year.',
		kind: 'digital',
		category: 'services',
		hours: 10,
		stock: null,
		perUserLimit: 1
	},
	{
		slug: 'headphones',
		name: 'closed-back headphones',
		description: 'For the library, the bus, and the last hour before the ship.',
		kind: 'physical',
		category: 'hardware',
		hours: 22,
		stock: 12,
		perUserLimit: 1
	}
] as const;

type Catalog = Map<
	string,
	{ id: string; name: string; kind: (typeof PRODUCTS)[number]['kind']; price: number }
>;

/** The shelves, by slug, so a product can name the one it belongs on. Upserted
 *  the same way products are, so re-running the seed refiles rather than
 *  duplicating. */
async function ensureCategories(actorId: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const category of CATEGORIES) {
		await db
			.insert(productCategories)
			.values({
				slug: category.slug,
				name: category.name,
				position: category.position,
				createdBy: actorId,
				createdAt: daysAgo(40)
			})
			.onConflictDoNothing({ target: productCategories.slug });
		const [row] = await db
			.select({ id: productCategories.id })
			.from(productCategories)
			.where(eq(productCategories.slug, category.slug))
			.limit(1);
		out.set(category.slug, row.id);
	}
	return out;
}

async function ensureProducts(actorId: string): Promise<Catalog> {
	const categories = await ensureCategories(actorId);
	const out: Catalog = new Map();
	for (const item of PRODUCTS) {
		const [inserted] = await db
			.insert(products)
			.values({
				slug: item.slug,
				name: item.name,
				description: item.description,
				imageUrl: await picture(`shop-${item.slug}`, 1200, 675),
				kind: item.kind,
				categoryId: item.category ? (categories.get(item.category) ?? null) : null,
				currency: 'seconds',
				price: item.hours * HOUR,
				stock: item.stock,
				perUserLimit: item.perUserLimit,
				requiresEligibility: true,
				optionSchema: null,
				active: true,
				version: 1,
				updatedBy: actorId,
				createdAt: daysAgo(40),
				updatedAt: daysAgo(40)
			})
			.onConflictDoNothing({ target: products.slug })
			.returning({ id: products.id });
		const [row] = await db
			.select({
				id: products.id,
				name: products.name,
				kind: products.kind,
				price: products.price,
				version: products.version
			})
			.from(products)
			.where(eq(products.slug, item.slug))
			.limit(1);
		await db
			.insert(productRevisions)
			.values({
				productId: row.id,
				version: row.version,
				name: row.name,
				description: item.description,
				kind: row.kind,
				currency: 'seconds',
				price: row.price,
				perUserLimit: item.perUserLimit,
				requiresEligibility: true,
				optionSchema: null,
				changedBy: actorId
			})
			.onConflictDoNothing();
		if (inserted) {
			await db.insert(auditEvents).values({
				actorId,
				action: 'catalog.created',
				metadata: { productId: row.id, slug: item.slug },
				createdAt: daysAgo(40)
			});
		}
		out.set(item.slug, { id: row.id, name: row.name, kind: row.kind, price: row.price });
	}
	return out;
}

/** One order and where it ended up. `daysAgo` is when it was placed. */
type OrderPlan = { slug: string; quantity?: number; state: OrderState; daysAgo: number };

/** Every state, for each real account. */
const OWNER_ORDERS: OrderPlan[] = [
	{ slug: 'sticker-pack', quantity: 2, state: 'fulfilled', daysAgo: 12 },
	{ slug: 'pico', state: 'placed', daysAgo: 2 },
	{ slug: 'phantom-tee', state: 'on_hold', daysAgo: 4 },
	{ slug: 'domain', state: 'rejected', daysAgo: 8 },
	{ slug: 'sticker-pack', state: 'cancelled', daysAgo: 6 },
	{ slug: 'enamel-pin', quantity: 2, state: 'fulfilled', daysAgo: 20 },
	{ slug: 'notebook', state: 'fulfilled', daysAgo: 16 },
	{ slug: 'esp32', state: 'placed', daysAgo: 1 },
	{ slug: 'soldering-iron', state: 'on_hold', daysAgo: 3 },
	{ slug: 'cloud-credit', state: 'fulfilled', daysAgo: 25 }
];

const ORDER_STATES: OrderState[] = [
	'fulfilled',
	'fulfilled',
	'fulfilled',
	'placed',
	'placed',
	'on_hold',
	'rejected',
	'cancelled'
];

/** Orders for a seeded person: a few items, chosen from their subject. */
function plannedOrders(subject: string): OrderPlan[] {
	const count = hash(subject) % 6;
	return Array.from({ length: count }, (_, i) => {
		const item = pick(PRODUCTS, `${subject}:item:${i}`);
		return {
			slug: item.slug,
			quantity: item.perUserLimit > 1 && hash(`${subject}:q:${i}`) % 3 === 0 ? 2 : 1,
			state: pick(ORDER_STATES, `${subject}:state:${i}`),
			daysAgo: 1 + (hash(`${subject}:d:${i}`) % 28)
		};
	});
}

async function writeOrder(
	tx: Tx,
	plan: OrderPlan,
	index: number,
	user: { id: string; subject: string },
	catalog: Catalog,
	operatorId: string,
	balance: { left: number }
): Promise<'created' | 'skipped' | 'unaffordable'> {
	const product = catalog.get(plan.slug)!;
	const intent = `seed:${user.subject}:order:${index}`;
	const [existing] = await tx
		.select({ id: orders.id })
		.from(orders)
		.where(eq(orders.idempotencyKey, intent))
		.limit(1);
	if (existing) return 'skipped';

	const quantity = plan.quantity ?? 1;
	const total = product.price * quantity;
	/* Debits stay under what the awards minted, so the ledger replays clean. */
	if (total > balance.left) return 'unaffordable';
	const refunds = plan.state === 'rejected' || plan.state === 'cancelled';
	if (!refunds) balance.left -= total;

	const placedAt = daysAgo(plan.daysAgo);
	const movedAt = hoursAfter(placedAt, 20);
	const accountId = await ledgerAccount(tx, user.id);

	const [order] = await tx
		.insert(orders)
		.values({
			userId: user.id,
			productId: product.id,
			productVersion: 1,
			productName: product.name,
			productKind: product.kind,
			currency: 'seconds',
			unitPrice: product.price,
			quantity,
			totalPrice: total,
			options: null,
			shippingEncrypted: null,
			state: plan.state,
			stateAt: plan.state === 'placed' ? placedAt : movedAt,
			idempotencyKey: intent,
			stockTaken: true,
			createdAt: placedAt
		})
		.returning({ id: orders.id });

	const [debit] = await tx
		.insert(ledgerEntries)
		.values({
			accountId,
			currency: 'seconds',
			amount: -total,
			entryType: 'order_debit',
			reason: `${product.name} × ${quantity}`,
			idempotencyKey: `intent:${intent}:debit`,
			orderId: order.id,
			actorId: user.id,
			metadata: { productId: product.id, productVersion: 1, unitPrice: product.price, quantity },
			createdAt: placedAt
		})
		.returning({ id: ledgerEntries.id });

	await tx.insert(orderTransitions).values({
		orderId: order.id,
		fromState: null,
		toState: 'placed',
		actorId: user.id,
		reason: 'placed by the participant',
		metadata: { entryId: debit.id },
		createdAt: placedAt
	});
	await tx.insert(auditEvents).values({
		actorId: user.id,
		subjectId: user.id,
		action: 'order.placed',
		metadata: {
			orderId: order.id,
			productId: product.id,
			productVersion: 1,
			quantity,
			totalPrice: total
		},
		createdAt: placedAt
	});

	if (plan.state !== 'placed') {
		let refundEntryId: string | null = null;
		if (refunds) {
			const [refund] = await tx
				.insert(ledgerEntries)
				.values({
					accountId,
					currency: 'seconds',
					amount: total,
					entryType: 'order_refund',
					reason: `refund: ${product.name} × ${quantity}`,
					idempotencyKey: `order:${order.id}:refund`,
					orderId: order.id,
					reversesEntryId: debit.id,
					actorId: plan.state === 'cancelled' ? user.id : operatorId,
					createdAt: movedAt
				})
				.returning({ id: ledgerEntries.id });
			refundEntryId = refund.id;
		}
		const reasons: Record<Exclude<OrderState, 'placed'>, string> = {
			on_hold: 'put on hold by an operator',
			fulfilled: 'fulfilled',
			rejected: 'rejected by an operator',
			cancelled: 'cancelled by the participant',
			unfulfilled: 'marked unfulfilled - it did not reach them'
		};
		await tx.insert(orderTransitions).values({
			orderId: order.id,
			fromState: 'placed',
			toState: plan.state,
			actorId: plan.state === 'cancelled' ? user.id : operatorId,
			reason: reasons[plan.state],
			metadata: { refunded: refunds, refundEntryId },
			createdAt: movedAt
		});
	}

	await recache(tx, accountId);
	return 'created';
}

/* ── the job log ─────────────────────────────────────────────────────────── */

const RECONCILE_CHECKS = [
	'cached-balance-drift',
	'order-without-debit',
	'debit-without-order',
	'debit-amount-mismatch',
	'refund-without-debit',
	'state-refund-mismatch',
	'multiple-reversals',
	'reversal-mismatch',
	'order-without-revision',
	'physical-without-address',
	'stale-open-orders',
	'outbox-needing-attention'
];

/** Two weeks of scheduled runs for every job, with the odd failure and the odd
 *  operator-triggered one. Marked in `result` so a second run adds nothing. */
async function ensureJobRuns(operatorId: string): Promise<number> {
	const [marked] = await db
		.select({ count: raw<number>`count(*)::int` })
		.from(jobRuns)
		.where(raw`${jobRuns.result} ? 'seed'`);
	if (marked.count > 0) return 0;

	type Run = {
		name: string;
		status: 'succeeded' | 'partial' | 'failed';
		result: Record<string, number | boolean>;
		error?: string | null;
		triggeredBy: string | null;
		startedAt: Date;
		finishedAt: Date;
	};
	const rows: Run[] = [];
	for (let day = 14; day >= 0; day--) {
		for (let slot = 0; slot < 4; slot++) {
			const startedAt = new Date(now - day * DAY - slot * 6 * HOUR * 1000 - 7 * 60 * 1000);
			const key = `${day}:${slot}`;
			const claimed = hash(`${key}:claimed`) % 12;
			const failed = hash(`${key}:failed`) % 9 === 0 ? 1 : 0;
			const delivered = Math.max(0, claimed - failed);
			rows.push({
				name: 'outbox.dispatch',
				status: failed ? 'partial' : 'succeeded',
				result: {
					seed: true,
					claimed,
					delivered,
					retryable: 0,
					failed,
					ambiguous: 0,
					skipped: 0,
					deferred: 0
				},
				triggeredBy: hash(`${key}:who`) % 11 === 0 ? operatorId : null,
				startedAt,
				finishedAt: new Date(startedAt.getTime() + 400 + (hash(key) % 3000))
			});
		}
		const sweepAt = new Date(now - day * DAY - 3 * HOUR * 1000);
		rows.push({
			name: 'sessions.sweep',
			status: 'succeeded',
			result: { seed: true, deleted: hash(`${day}:sweep`) % 5 },
			triggeredBy: null,
			startedAt: sweepAt,
			finishedAt: new Date(sweepAt.getTime() + 120)
		});
		const reconcileAt = new Date(now - day * DAY - 4 * HOUR * 1000);
		const drift = day === 9 ? 1 : 0;
		const crashed = day === 4;
		rows.push({
			name: 'ledger.reconcile',
			status: crashed ? 'failed' : drift ? 'partial' : 'succeeded',
			result: crashed
				? { seed: true }
				: {
						seed: true,
						...Object.fromEntries(RECONCILE_CHECKS.map((id) => [id, 0])),
						'cached-balance-drift': drift
					},
			error: crashed ? 'PostgresError: canceling statement due to statement timeout' : null,
			triggeredBy: drift ? operatorId : null,
			startedAt: reconcileAt,
			finishedAt: new Date(reconcileAt.getTime() + 900 + (hash(`${day}:rec`) % 4000))
		});
	}
	await db.insert(jobRuns).values(rows);
	await db.insert(auditEvents).values(
		rows
			.filter((row) => row.triggeredBy)
			.map((row) => ({
				actorId: row.triggeredBy,
				action: 'job.run',
				metadata: { name: row.name, status: row.status },
				createdAt: row.startedAt
			}))
	);
	return rows.length;
}

/* ── run ─────────────────────────────────────────────────────────────────── */

/* ── hyper-chroma ────────────────────────────────────────────────────────── */

/** How many projects get the mark: more than explore's panel shows (three),
 *  so the panel's cut-off is visible too. */
const HYPER_CHROMA_COUNT = 5;

/**
 * Mark a handful of approved ships hyper-chroma (see projects/hyper-chroma.ts),
 * so explore's panel, the pills and the history all have something to show.
 *
 * A pass over what is already there rather than a field on the scenarios,
 * because the scenarios are only written once: a database seeded before
 * hyper-chroma existed would never get any. Each project's latest approved
 * ship is the one marked, a day apart so the panel's order is plain, and your
 * own "phantom platform" is always among them so the owner's side shows too.
 * The rest are picked by a hash of the project id - the same ones on every
 * database seeded from the same rows - and the others are left unmarked for
 * trying the mark by hand.
 *
 * Once only: when anything is already marked, by this or by hand, it leaves
 * the marks alone rather than putting back one somebody took off.
 */
async function ensureHyperChroma(approverId: string): Promise<string[]> {
	const [already] = await db
		.select({ count: raw<number>`count(*)::int` })
		.from(submissions)
		.where(eq(submissions.hyperChroma, true));
	if ((already?.count ?? 0) > 0) return [];

	const picked = await db.execute<{
		id: string;
		user_id: string;
		project_id: string;
		name: string;
	}>(raw`
		select id, user_id, project_id, name from (
			select distinct on (s.project_id) s.id, s.user_id, s.project_id, p.name
			from submissions s
			join projects p on p.id = s.project_id
			where s.state = 'approved'
			order by s.project_id, s.created_at desc
		) latest
		order by (name = 'phantom platform') desc, md5(project_id::text)
		limit ${HYPER_CHROMA_COUNT}
	`);

	const names: string[] = [];
	await db.transaction(async (tx) => {
		for (const [i, row] of [...picked].entries()) {
			const at = new Date(Date.now() - (i + 1) * DAY);
			await tx
				.update(submissions)
				.set({ hyperChroma: true, hyperChromaAt: at, hyperChromaById: approverId })
				.where(eq(submissions.id, row.id));
			await tx.insert(auditEvents).values({
				actorId: approverId,
				subjectId: row.user_id,
				action: 'submission.hyper_chroma_marked',
				metadata: { submissionId: row.id, projectId: row.project_id },
				createdAt: at
			});
			names.push(row.name);
		}
	});
	return names;
}

async function seed() {
	const people = await ensurePeople();
	const reviewers: Reviewer[] = PEOPLE.filter((p) => p.role === 'reviewer').map((p) => ({
		id: people.get(p.subject)!,
		name: p.name
	}));
	const participants = PEOPLE.filter((p) => p.role === 'participant');

	/* Every real account already in the database, not just yours: anyone who has
	   signed in gets the full set. The approver is the first owner or admin
	   found, falling back to the first seeded reviewer. */
	const real = await db
		.select({
			id: users.id,
			subject: users.hcaSubject,
			role: users.role,
			name: users.displayName,
			email: users.email
		})
		.from(users)
		.where(raw`${users.hcaSubject} not like 'seed:%'`)
		.orderBy(users.createdAt);
	const approverRow = real.find((u) => u.role === 'owner' || u.role === 'admin');
	const approver: Reviewer = approverRow
		? { id: approverRow.id, name: approverRow.name ?? approverRow.email }
		: reviewers[0];

	const { forReal, forSeeded } = assign(
		real,
		participants.map((p) => p.subject)
	);

	/* Upload every picture before opening the transaction, so a slow CDN does
	   not hold a write lock on a remote database. */
	for (const scenario of [...OWNER_PROJECTS, ...POOL_SCENARIOS]) {
		await picture(scenario.hackatime, 1200, 630);
	}

	let created = 0;
	let skipped = 0;
	await db.transaction(async (tx) => {
		for (const [i, user] of real.entries()) {
			for (const scenario of forReal[i]) {
				const result = await writeScenario(
					tx,
					scenario,
					{ id: user.id, role: user.role, name: user.name ?? user.email },
					reviewers,
					approver
				);
				if (result === 'created') created++;
				else skipped++;
			}
		}
		for (const [subject, list] of forSeeded) {
			const p = PEOPLE.find((x) => x.subject === subject)!;
			for (const scenario of list) {
				const result = await writeScenario(
					tx,
					scenario,
					{ id: people.get(subject)!, role: p.role, name: p.name },
					reviewers,
					approver
				);
				if (result === 'created') created++;
				else skipped++;
			}
		}
	});

	/* Showcase rows written before the repo column existed: fill the link in
	   from the approved submission they were built from. */
	await db.execute(raw`
		update project_showcase s
		set repo_url = sub.repo_url
		from (
			select distinct on (project_id) project_id, repo_url
			from submissions
			where state = 'approved'
			order by project_id, created_at desc
		) sub
		where sub.project_id = s.project_id and s.repo_url is null
	`);

	/* Review notes on the moves: the placeholder text the first run wrote is
	   replaced with something that reads like a review. */
	await db.execute(raw`
		update submission_transitions t
		set internal_note = case (abs(hashtext(t.id::text)) % 6)
			when 0 then E'[REVIEWER JUSTIFICATION]\nThe demo runs and does what the description says. Granting the full claim.'
			when 1 then E'[REVIEWER JUSTIFICATION]\nSolid work, well scoped. Granting the hours.'
			when 2 then E'[REVIEWER JUSTIFICATION]\nClear README and a working demo. Recommending approval.'
			when 3 then E'[REVIEWER JUSTIFICATION]\nThe sync engine is the interesting part and it works well. Full claim.'
			when 4 then E'[REVIEWER JUSTIFICATION]\nGood project. Granting the hours.'
			else E'[REVIEWER JUSTIFICATION]\nDemo link was dead at review time and the repo has no README. Asked for both before this can be judged.'
		end
		where t.internal_note = 'Seeded review note.'
	`);
	await db.execute(raw`
		update submissions s
		set justification = t.internal_note
		from submission_transitions t
		where t.submission_id = s.id
			and t.to_state = s.state
			and s.justification = 'Seeded review note.'
	`);

	const hyperChroma = await ensureHyperChroma(approver.id);

	const catalog = await ensureProducts(approver.id);

	const balances = new Map<string, number>();
	for (const row of await db
		.select({ userId: ledgerAccounts.userId, balance: ledgerAccounts.cachedBalance })
		.from(ledgerAccounts)
		.where(eq(ledgerAccounts.currency, 'seconds'))) {
		balances.set(row.userId, Number(row.balance));
	}

	let ordersCreated = 0;
	let ordersSkipped = 0;
	let ordersUnaffordable = 0;
	const tally = (result: Awaited<ReturnType<typeof writeOrder>>) => {
		if (result === 'created') ordersCreated++;
		else if (result === 'skipped') ordersSkipped++;
		else ordersUnaffordable++;
	};
	await db.transaction(async (tx) => {
		for (const user of real) {
			const balance = { left: balances.get(user.id) ?? 0 };
			for (const [index, plan] of OWNER_ORDERS.entries()) {
				tally(
					await writeOrder(
						tx,
						plan,
						index,
						{ id: user.id, subject: user.subject },
						catalog,
						approver.id,
						balance
					)
				);
			}
		}
		for (const p of participants) {
			const id = people.get(p.subject)!;
			const balance = { left: balances.get(id) ?? 0 };
			for (const [index, plan] of plannedOrders(p.subject).entries()) {
				tally(
					await writeOrder(
						tx,
						plan,
						index,
						{ id, subject: p.subject },
						catalog,
						approver.id,
						balance
					)
				);
			}
		}
	});

	const runs = await ensureJobRuns(approver.id);

	console.log(`people: ${PEOPLE.length} seeded, ${real.length} real`);
	console.log(`projects: ${created} created, ${skipped} already present`);
	console.log(`pictures: ${pictures.size} ${local ? 'linked from picsum' : 'uploaded to the cdn'}`);
	console.log(`products: ${PRODUCTS.length} ensured`);
	console.log(
		`orders: ${ordersCreated} created, ${ordersSkipped} already present, ${ordersUnaffordable} skipped for balance`
	);
	console.log(`job runs: ${runs} written`);
	console.log(
		hyperChroma.length > 0
			? `hyper-chroma: marked ${hyperChroma.join(', ')}`
			: 'hyper-chroma: already marked'
	);
}

seed()
	.catch((error) => {
		console.error('seed failed:', error);
		process.exitCode = 1;
	})
	.finally(() => sql.end());
