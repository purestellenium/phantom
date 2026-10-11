/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { SessionUser } from '../src/lib/server/auth/session';
import { ELIGIBILITY_RULE } from '../src/lib/server/auth/eligibility';

const testUrl = process.env.SECURITY_TEST_DATABASE_URL;
if (testUrl) {
	const url = new URL(testUrl);
	if (
		!['127.0.0.1', 'localhost'].includes(url.hostname) ||
		!url.port ||
		url.port === '5432' ||
		!/^\/phantom_security_[a-z0-9_]+$/.test(url.pathname)
	) {
		throw new Error(
			'Security tests require an empty phantom_security_* database on a non-default loopback port.'
		);
	}
}

const originalFetch = globalThis.fetch;
const root = new URL('../', import.meta.url);
let database: typeof import('../src/lib/server/db/client');
let schema: typeof import('../src/lib/server/db/schema');
let projects: typeof import('../src/lib/server/projects/projects');
let reviews: typeof import('../src/lib/server/projects/review');
let decisions: typeof import('../src/lib/server/projects/decisions');
let sessions: typeof import('../src/lib/server/auth/session');
let shop: typeof import('../src/lib/server/shop/purchase');
let catalog: typeof import('../src/lib/server/shop/catalog');
let orders: typeof import('../src/lib/server/shop/orders');
let launch: typeof import('../src/lib/server/launch');
let crypto: typeof import('../src/lib/server/crypto');
let eligibility: typeof import('../src/lib/server/auth/eligibility-refresh');
let admin: SessionUser;
let uploads = 0;
let uploaded: Blob | null = null;
let countBarrier: (() => Promise<void>) | null = null;
let identityResult = 'verified_eligible';
let identityUnavailable = false;
let identityCalls = 0;
let claimsStatus = 200;
let userinfoSubject = 'synthetic';
let event: unknown;
/* What Ari's status endpoint says about each ship, by Ari's id. Anything not
   named here is decided and approved. */
const ariStatuses = new Map<string, { phase: string; decision: string | null }>();
let deliveries = 0;

const draft = {
	name: 'Synthetic',
	description: 'Synthetic',
	repoUrl: 'https://example.test/repo',
	demoUrl: 'https://example.test/demo',
	screenshotUrl: null,
	hackatimeProjects: null,
	aiDeclaration: null,
	updateDeclaration: null,
	notesForReviewer: null,
	kind: 'software' as const
};

async function user(role: SessionUser['role'] = 'participant') {
	const [u] = await database.db
		.insert(schema.users)
		.values({
			hcaSubject: randomBytes(16).toString('hex'),
			email: 'private@example.test',
			slackId: `U${randomBytes(6).toString('hex').toUpperCase()}`,
			role,
			onboardedAt: new Date(),
			verificationStatus: 'verified',
			eligibility: 'eligible',
			eligibilityAt: new Date(),
			eligibilityRule: ELIGIBILITY_RULE
		})
		.returning();
	for (const provider of ['hca', 'hackatime'] as const) {
		await database.db.insert(schema.providerAccounts).values({
			userId: u.id,
			provider,
			providerAccountId: `${provider}-${u.id}`,
			accessTokenEncrypted: crypto.encryptToken(
				'synthetic',
				crypto.bindings.providerToken(u.id, provider, 'access_token')
			)
		});
	}
	return u;
}

const ship = (u: SessionUser, p: { number: number }) =>
	reviews.shipProject({
		user: u,
		projectNumber: p.number,
		changelog: null,
		addressId: null,
		noAi: true,
		aiDeclaration: null,
		isUpdate: false,
		updateDeclaration: null,
		notesForReviewer: null
	});
/* What Ari's ship id for a submission is, in these tests: the ingest mock
   answers with the same one, so the outbox and the test agree. */
const ariIdFor = (submissionId: string) => `ari-${submissionId}`;

/** Ari's webhook delivering one event about a submission. */
async function deliver(
	submissionId: string,
	eventName: string,
	options: { deliveryId?: string; minutes?: number; ariId?: string } = {}
) {
	const [row] = await database.db
		.select()
		.from(schema.submissions)
		.where(eq(schema.submissions.id, submissionId));
	const ariId = options.ariId ?? ariIdFor(submissionId);
	await database.db.insert(schema.ariShips).values({ ariId, submissionId }).onConflictDoNothing();
	return decisions.applyDelivery(options.deliveryId ?? `delivery-${++deliveries}`, {
		event: eventName,
		decision: eventName === 'review.approved' ? 'approved' : null,
		id: ariId,
		external_id: row.projectId,
		review: {
			approved_minutes: options.minutes ?? 600,
			note_to_maker: 'Synthetic',
			audit_note: 'Synthetic',
			reviewer: { email: 'reviewer@example.test', slack_id: null }
		}
	});
}

const approve = async (id: string) => {
	const result = await deliver(id, 'review.approved');
	return { ok: result !== 'duplicate' && result.outcome === 'applied', result };
};

async function waitForClaimLock() {
	for (let i = 0; i < 100; i++) {
		const [row] = await database.sql`select count(*)::int as count from pg_stat_activity
			where datname=current_database() and wait_event='advisory'`;
		if (Number(row.count) > 0) return;
		await Bun.sleep(10);
	}
	throw new Error('Expected a concurrent request waiting on the claim lock');
}

describe.skipIf(!testUrl)('security regressions with isolated PostgreSQL', () => {
	beforeAll(async () => {
		mock.module('$env/dynamic/private', () => ({
			env: {
				DATABASE_URL: testUrl,
				ENCRYPTION_KEY: randomBytes(32).toString('hex'),
				HCA_CLIENT_ID: 'synthetic',
				HCA_CLIENT_SECRET: 'synthetic',
				HACKATIME_CLIENT_ID: 'synthetic',
				HACKATIME_CLIENT_SECRET: 'synthetic',
				CDN_API_KEY: 'synthetic',
				ARI_PROGRAM: 'synthetic',
				ARI_INGEST_SECRET: 'synthetic',
				ARI_WEBHOOK_SECRET: 'synthetic'
			}
		}));
		mock.module('$app/environment', () => ({ dev: true, building: false, browser: false }));
		mock.module('$app/server', () => ({ getRequestEvent: () => event }));
		mock.module('../src/lib/server/analytics', () => ({ recordEvent() {} }));
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === 'https://auth.hackclub.com/api/v1/me')
				return Response.json({
					addresses: [
						{
							id: 'synthetic',
							primary: true,
							name: 'Synthetic',
							line_1: '1 Test St',
							city: 'Test',
							postal_code: '12345',
							country: 'US'
						}
					]
				});
			if (url.split('?')[0] === 'https://hackatime.hackclub.com/api/v1/authenticated/projects') {
				await countBarrier?.();
				return Response.json([{ name: 'work', total_seconds: 36000 }]);
			}
			if (url.startsWith('https://auth.hackclub.com/api/external/check?')) {
				identityCalls++;
				return identityUnavailable
					? new Response('', { status: 503 })
					: Response.json({ result: identityResult });
			}
			if (url === 'https://auth.hackclub.com/.well-known/openid-configuration')
				return Response.json({
					issuer: 'https://auth.hackclub.com',
					authorization_endpoint: 'https://auth.hackclub.com/oauth/authorize',
					token_endpoint: 'https://auth.hackclub.com/oauth/token',
					userinfo_endpoint: 'https://auth.hackclub.com/oauth/userinfo',
					jwks_uri: 'https://auth.hackclub.com/oauth/jwks'
				});
			if (url === 'https://auth.hackclub.com/oauth/userinfo')
				return claimsStatus !== 200
					? new Response('', { status: claimsStatus })
					: Response.json({
							sub: userinfoSubject,
							email: 'synthetic@example.test',
							verification_status: 'verified'
						});
			if (url.startsWith('https://webhooks.ari.hackclub.com/api/ingest/synthetic/status?')) {
				const query = new URL(url).searchParams;
				const id = query.get('id');
				if (!id) return Response.json({ error: 'not_found' }, { status: 404 });
				const status = ariStatuses.get(id) ?? { phase: 'reviewed', decision: 'approved' };
				return Response.json({ id, external_id: 'synthetic', version: 1, ...status });
			}
			if (url === 'https://webhooks.ari.hackclub.com/api/ingest/synthetic') {
				const body = JSON.parse(String(init?.body)) as { meta: Record<string, string> };
				const id = ariIdFor(body.meta['Phantom submission']);
				return Response.json({ id, status: 'accepted' }, { status: 202 });
			}
			if (url === 'https://cdn.hackclub.com/api/v4/upload') {
				uploads++;
				uploaded = (init?.body as FormData).get('file') as Blob;
				return Response.json({ url: 'https://cdn.hackclub.com/synthetic.png' });
			}
			throw new Error(`External network blocked in security tests: ${url}`);
		}) as typeof fetch;
		database = await import('../src/lib/server/db/client');
		schema = await import('../src/lib/server/db/schema');
		const [existing] =
			await database.sql`select count(*)::int as count from information_schema.tables where table_schema='public'`;
		if (existing.count) throw new Error('Security test database must be empty');
		for (const file of readdirSync(new URL('drizzle', root))
			.filter((f) => f.endsWith('.sql'))
			.sort()) {
			for (const statement of readFileSync(new URL(`drizzle/${file}`, root), 'utf8').split(
				'--> statement-breakpoint'
			)) {
				if (statement.trim()) await database.sql.unsafe(statement);
			}
		}
		await database.sql.unsafe(
			readFileSync(new URL('src/lib/server/db/append-only.sql', root), 'utf8')
		);
		crypto = await import('../src/lib/server/crypto');
		projects = await import('../src/lib/server/projects/projects');
		reviews = await import('../src/lib/server/projects/review');
		decisions = await import('../src/lib/server/projects/decisions');
		sessions = await import('../src/lib/server/auth/session');
		shop = await import('../src/lib/server/shop/purchase');
		catalog = await import('../src/lib/server/shop/catalog');
		orders = await import('../src/lib/server/shop/orders');
		launch = await import('../src/lib/server/launch');
		eligibility = await import('../src/lib/server/auth/eligibility-refresh');
		admin = await user('admin');
		await database.db.insert(schema.siteSettings).values({ launched: true, shopOpen: true });
	});

	afterAll(async () => {
		globalThis.fetch = originalFetch;
		await database?.sql.end();
	});

	test('paid Hackatime names remain reserved after unlinking', async () => {
		const u = await user();
		const p = await projects.createProject(u.id, { ...draft, hackatimeProjects: 'work' });
		const shipped = await ship(u, p);
		expect(shipped.ok).toBe(true);
		if (!shipped.ok) throw Error(shipped.error);
		expect((await approve(shipped.submission.id)).ok).toBe(true);
		expect((await projects.updateProject(p.number, u.id, draft)).ok).toBe(true);
		const other = await projects.createProject(u.id, draft);
		expect(
			(await projects.updateProject(other.number, u.id, { ...draft, hackatimeProjects: 'work' })).ok
		).toBe(false);
		await expect(
			projects.createProject(u.id, { ...draft, hackatimeProjects: 'work' })
		).rejects.toThrow('already linked');
		expect(
			(await projects.updateProject(p.number, u.id, { ...draft, hackatimeProjects: 'work' })).ok
		).toBe(true);
	});

	test('concurrent claims leave one owner', async () => {
		const u = await user();
		const a = await projects.createProject(u.id, draft);
		const b = await projects.createProject(u.id, draft);
		const results = await Promise.all(
			[a, b].map((p) =>
				projects.updateProject(p.number, u.id, { ...draft, hackatimeProjects: 'work' })
			)
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
	});

	test('concurrent ships produce one pending submission and the same approval delivered twice mints once', async () => {
		const u = await user();
		const p = await projects.createProject(u.id, { ...draft, hackatimeProjects: 'work' });
		let release!: () => void;
		const barrier = new Promise<void>((r) => (release = r));
		let arrived = 0;
		countBarrier = async () => {
			if (++arrived === 2) release();
			await barrier;
		};
		let results;
		try {
			results = await Promise.all([ship(u, p), ship(u, p)]);
		} finally {
			countBarrier = null;
		}
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		const shipped = results.find((r) => r.ok)!;
		if (!shipped.ok) throw Error('No ship');
		/* The same approval delivered twice at once, under two delivery ids:
		   the submission's lock queues them, and the second finds it already
		   approved. */
		await Promise.all([approve(shipped.submission.id), approve(shipped.submission.id)]);
		const { cachedBalance } = await import('../src/lib/server/ledger');
		expect(await cachedBalance(u.id)).toBe(36000);
	});

	test('legacy overlapping submissions cannot receive a second award', async () => {
		const u = await user();
		const a = await projects.createProject(u.id, { ...draft, hackatimeProjects: 'work' });
		const shipped = await ship(u, a);
		if (!shipped.ok) throw Error(shipped.error);
		expect((await approve(shipped.submission.id)).ok).toBe(true);
		const b = await projects.createProject(u.id, draft);
		const [legacy] = await database.db
			.insert(schema.submissions)
			.values({
				projectId: b.id,
				userId: u.id,
				name: 'Legacy',
				hackatimeProjects: 'work',
				claimedSeconds: 36000,
				state: 'first_passed',
				awardedSeconds: 36000
			})
			.returning();
		expect((await approve(legacy.id)).ok).toBe(false);
	});

	test('a save waiting for a ship cannot edit a project under review', async () => {
		const u = await user();
		const p = await projects.createProject(u.id, draft);
		let saving!: ReturnType<typeof projects.updateProject>;
		await database.db.transaction(async (tx) => {
			await projects.lockClaims(tx, u.id);
			saving = projects.updateProject(p.number, u.id, { ...draft, name: 'Changed' });
			await waitForClaimLock();
			await tx.insert(schema.submissions).values({
				projectId: p.id,
				userId: u.id,
				name: 'Frozen',
				claimedSeconds: 36000,
				state: 'pending'
			});
		});
		expect((await saving).ok).toBe(false);
	});

	test('a precommit session read cannot keep revoked authority after commit', async () => {
		const u = await user();
		const s = await sessions.createSession({ userId: u.id });
		const cookies = { get: () => s.token };
		expect(await sessions.readSession(cookies)).not.toBeNull();
		await database.db.transaction(async (tx) => {
			await sessions.revokeAllSessions(u.id, tx);
			expect(await sessions.readSession(cookies)).not.toBeNull();
		});
		expect(await sessions.readSession(cookies)).toBeNull();
		const next = await sessions.createSession({ userId: u.id });
		const c = { get: () => next.token };
		await sessions.readSession(c);
		await database.db
			.update(schema.users)
			.set({ role: 'reviewer' })
			.where(eq(schema.users.id, u.id));
		expect((await sessions.readSession(c))?.user.role).toBe('reviewer');
	});

	test('closed-shop checks override stale cache and preserve existing receipts', async () => {
		const u = await user();
		const product = await catalog.createProduct(
			{
				slug: `test-${u.id}`,
				name: 'Synthetic',
				description: null,
				imageUrl: null,
				imagePadding: 0,
				position: 0,
				images: [],
				kind: 'digital',
				categoryId: null,
				price: 1,
				stock: 10,
				perUserLimit: null,
				requiresEligibility: true,
				optionSchema: null,
				availableFrom: null,
				availableUntil: null,
				blockedCountries: [],
				active: true
			},
			admin.id
		);
		const { postEntry } = await import('../src/lib/server/ledger');
		await database.db.transaction((tx) =>
			postEntry(
				{
					userId: u.id,
					amount: 10,
					entryType: 'submission_award',
					reason: 'Synthetic',
					idempotencyKey: u.id
				},
				tx
			)
		);
		const buy = (intent: string = globalThis.crypto.randomUUID()) =>
			shop.purchase({
				user: u,
				productId: product.id,
				quantity: 1,
				options: {},
				shipping: null,
				intent
			});
		await launch.refreshLaunch();
		await database.db.update(schema.siteSettings).set({ shopOpen: false });
		expect((await buy()).ok).toBe(false);
		await database.db.update(schema.siteSettings).set({ shopOpen: true });
		const bought = await buy();
		if (!bought.ok) throw Error(bought.error);
		expect(
			(
				await orders.transitionOrder({
					orderId: bought.order.id,
					actor: admin,
					transition: 'hold',
					restock: true
				})
			).ok
		).toBe(false);
		expect(
			(await orders.transitionOrder({ orderId: bought.order.id, actor: admin, transition: 'hold' }))
				.ok
		).toBe(true);
		expect(
			(
				await orders.transitionOrder({
					orderId: bought.order.id,
					actor: admin,
					transition: 'release'
				})
			).ok
		).toBe(true);
		const cancelled = await orders.transitionOrder({
			orderId: bought.order.id,
			actor: admin,
			transition: 'cancel',
			restock: true
		});
		expect(cancelled.ok && !cancelled.order.stockTaken).toBe(true);
		await database.db.update(schema.siteSettings).set({ shopOpen: false });
		await launch.refreshLaunch();
		expect((await buy(bought.order.idempotencyKey)).ok).toBe(true);
		await database.db.update(schema.siteSettings).set({ shopOpen: true });
	});

	test('launch decisions are fresh and the API allowlist is exact', async () => {
		const u = await user();
		await launch.refreshLaunch();
		await database.db.update(schema.siteSettings).set({ launched: false });
		expect(await launch.launchAllows(u)).toBe(false);
		expect(await launch.launchAllows(admin)).toBe(true);
		for (const route of ['/api/projects', '/api/showcase', '/api/signup-private'])
			expect(launch.isGatedApi(route)).toBe(true);
		expect(launch.isGatedApi('/api/signup')).toBe(false);
		expect(launch.isGatedApi('/api/ari/feed')).toBe(false);
		await database.db.update(schema.siteSettings).set({ launched: true });
	});

	test('addresses require PII permission and ciphertext remains bound to its order', async () => {
		const [saved] = await database.db.select().from(schema.orders).limit(1);
		const { sealShipping, revealShipping } = await import('../src/lib/server/shop/shipping');
		const snapshot = {
			recipient: 'Synthetic',
			line1: 'PRIVATE-ADDRESS',
			line2: null,
			city: 'Test',
			region: null,
			postcode: '12345',
			country: 'US',
			phone: null,
			capturedAt: new Date().toISOString()
		};
		const order = {
			...saved,
			shippingEncrypted: sealShipping(snapshot, {
				userId: saved.userId,
				idempotencyKey: saved.idempotencyKey
			})
		};
		const participant = await user();
		expect((await revealShipping(order, participant)).ok).toBe(false);
		expect(
			(await revealShipping(order, { ...participant, capabilities: ['manage_orders'] })).ok
		).toBe(false);
		const allowed = await revealShipping(order, admin);
		expect(allowed.ok && allowed.snapshot.line1).toBe('PRIVATE-ADDRESS');
		expect(
			(await revealShipping({ ...order, idempotencyKey: globalThis.crypto.randomUUID() }, admin)).ok
		).toBe(false);
		const audits = await database.db
			.select()
			.from(schema.auditEvents)
			.where(eq(schema.auditEvents.action, 'order.address_revealed'));
		expect(audits.length).toBeGreaterThan(0);
		expect(JSON.stringify(audits)).not.toContain('PRIVATE-ADDRESS');
	});

	test('encoded API paths are gated by their resolved route', async () => {
		const u = await user();
		const session = await sessions.createSession({ userId: u.id });
		const { gates: handle } = await import('../src/hooks.server');
		await database.db.update(schema.siteSettings).set({ launched: false });
		const reads = spyOn(database.db, 'select');
		const active = await sessions.readSession({ get: () => session.token });
		expect(active?.launched).toBe(false);
		for (const name of ['projects', 'showcase']) {
			const url = new URL(`http://localhost/%61pi/${name}`);
			await expect(
				handle({
					event: {
						route: { id: `/api/${name}` },
						url,
						locals: { session: active },
						request: new Request(url),
						cookies: { get: () => session.token }
					},
					resolve: async () => Response.json({ leaked: true })
				} as unknown as Parameters<typeof handle>[0])
			).rejects.toMatchObject({ status: 404 });
		}
		expect(reads).toHaveBeenCalledTimes(1);
		reads.mockRestore();
		await database.db.update(schema.siteSettings).set({ launched: true });
	});

	test('staff email is absent from public actor fields', async () => {
		const u = await user();
		const p = await projects.createProject(u.id, { ...draft, hackatimeProjects: 'work' });
		const shipped = await ship(u, p);
		if (!shipped.ok) throw Error(shipped.error);
		const history = await reviews.projectHistory(p.id);
		expect(history.every((h) => !('actorEmail' in h))).toBe(true);
		const { peopleById } = await import('../src/lib/server/people');
		expect((await peopleById([admin.id])).get(admin.id)?.name).toBe('phantom');
	});

	test('refused edits do not upload and signature-only fake images are rejected', async () => {
		const u = await user();
		const a = await projects.createProject(u.id, { ...draft, hackatimeProjects: 'work' });
		const b = await projects.createProject(u.id, draft);
		event = { locals: { session: { user: u, sessionId: 'synthetic' } } };
		const { actions } = await import('../src/routes/(app)/projects/[number]/+page.server');
		const form = new FormData();
		form.set('name', 'Synthetic');
		form.set('hackatime_projects', 'work');
		form.set('screenshot1', new File(['bad image'], 'fake.png', { type: 'image/png' }));
		const before = uploads;
		const result = await actions.save({
			params: { number: String(b.number) },
			request: new Request('http://localhost', { method: 'POST', body: form })
		} as Parameters<typeof actions.save>[0]);
		expect(result && 'status' in result && result.status).toBe(400);
		expect(uploads).toBe(before);
		expect(a.id).not.toBe(b.id);
		const { uploadImageWithKey } = await import('../src/lib/server/cdn-upload');
		await expect(
			uploadImageWithKey(
				'synthetic',
				new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'garbage'], {
					type: 'image/png'
				}),
				'fake.png'
			)
		).rejects.toThrow();
		expect(uploads).toBe(before);
	});

	test('valid uploads preserve original bytes without an hourly quota', async () => {
		const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } })
			.png()
			.toBuffer();
		const image = new Blob([new Uint8Array(png), 'PRIVATE-APPENDED-PAYLOAD'], {
			type: 'image/png'
		});
		const { uploadImageBlob } = await import('../src/lib/server/cdn');
		const results = await Promise.allSettled(
			Array.from({ length: 12 }, () => uploadImageBlob(image, 'x.png'))
		);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(12);
		expect(new Uint8Array(await uploaded!.arrayBuffer())).toEqual(
			new Uint8Array(await image.arrayBuffer())
		);
	});

	test('supported images and their metadata are preserved', async () => {
		const { uploadImageWithKey } = await import('../src/lib/server/cdn-upload');
		for (const format of ['jpeg', 'png', 'gif', 'webp'] as const) {
			const bytes = await sharp({
				create: { width: 2, height: 2, channels: 3, background: 'white' }
			})
				.toFormat(format)
				.toBuffer();
			await uploadImageWithKey(
				'synthetic',
				new Blob([new Uint8Array(bytes)], { type: `image/${format}` }),
				'test'
			);
			expect((await sharp(new Uint8Array(await uploaded!.arrayBuffer())).metadata()).format).toBe(
				format
			);
		}
		const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } })
			.withExif({ IFD0: { Artist: 'PRIVATE-EXIF' } })
			.jpeg()
			.toBuffer();
		expect((await sharp(jpeg).metadata()).exif).toBeDefined();
		await uploadImageWithKey(
			'synthetic',
			new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }),
			'test'
		);
		expect(new Uint8Array(await uploaded!.arrayBuffer())).toEqual(new Uint8Array(jpeg));
	});

	test('valid images above sixteen megapixels remain unchanged', async () => {
		const { uploadImageWithKey } = await import('../src/lib/server/cdn-upload');
		const png = await sharp({
			create: { width: 4096, height: 4096, channels: 3, background: 'white' }
		})
			.png()
			.toBuffer();
		await uploadImageWithKey(
			'synthetic',
			new Blob([new Uint8Array(png)], { type: 'image/png' }),
			'large.png'
		);
		expect(new Uint8Array(await uploaded!.arrayBuffer())).toEqual(new Uint8Array(png));
	});

	test('eligibility refresh fails closed but retries a transient outage after a minute', async () => {
		let u = await user();
		userinfoSubject = u.hcaSubject;
		const calls = identityCalls;
		expect(await eligibility.currentEligibility(u)).toBe('eligible');
		expect(identityCalls).toBe(calls);
		await database.db
			.update(schema.users)
			.set({ eligibilityAt: new Date(0) })
			.where(eq(schema.users.id, u.id));
		[u] = await database.db.select().from(schema.users).where(eq(schema.users.id, u.id));
		identityUnavailable = true;
		expect(await eligibility.currentEligibility(u)).toBe('undetermined');
		identityUnavailable = false;
		await database.db
			.update(schema.users)
			.set({ eligibilityAt: new Date(Date.now() - 61_000) })
			.where(eq(schema.users.id, u.id));
		[u] = await database.db.select().from(schema.users).where(eq(schema.users.id, u.id));
		expect(await eligibility.currentEligibility(u)).toBe('eligible');
		await database.db
			.update(schema.users)
			.set({ eligibilityAt: new Date(0) })
			.where(eq(schema.users.id, u.id));
		[u] = await database.db.select().from(schema.users).where(eq(schema.users.id, u.id));
		claimsStatus = 401;
		expect(await eligibility.currentEligibility(u)).toBe('undetermined');
		claimsStatus = 200;
		identityResult = 'rejected';
		await database.db
			.update(schema.users)
			.set({ eligibilityAt: new Date(0) })
			.where(eq(schema.users.id, u.id));
		[u] = await database.db.select().from(schema.users).where(eq(schema.users.id, u.id));
		expect(await eligibility.currentEligibility(u)).toBe('blocked_rejected');
		identityResult = 'verified_eligible';
	});

	test('a ship goes to Ari as frozen, with only strings in meta', async () => {
		const ari = await import('../src/lib/server/ari');
		const u = await user();
		const p = await projects.createProject(u.id, {
			...draft,
			repoUrl: 'https://github.com/o/r/blob/main/README.md',
			demoUrl: 'https://example.test/demo?v=1#top',
			screenshotUrl: 'https://cdn.hackclub.com/synthetic.png',
			hackatimeProjects: 'work'
		});
		const shipped = await ship(u, p);
		if (!shipped.ok) throw Error(shipped.error);
		const id = shipped.submission.id;

		const [queued] = await database.db
			.select()
			.from(schema.outboxEvents)
			.where(eq(schema.outboxEvents.dedupeKey, `submission:${id}:ari`));
		expect(queued?.effect).toBe('ari.ingest');

		const built = await ari.buildShip(id, { backdate: true, origin: 'https://phantom.test' });
		expect(built).toMatchObject({
			external_id: p.id,
			repo_url: 'https://github.com/o/r',
			/* A query string is part of the link, and Ari takes it. */
			demo_url: 'https://example.test/demo?v=1#top',
			thumbnail_url: 'https://cdn.hackclub.com/synthetic.png',
			track: 'software',
			maker: { email: 'private@example.test', hackatime_id: `hackatime-${u.id}` },
			hackatime_projects: ['work'],
			shipped_at: shipped.submission.createdAt.toISOString()
		});
		const meta = (built as { meta: Record<string, unknown> }).meta;
		expect(Object.values(meta).every((value) => typeof value === 'string')).toBe(true);
		expect(Object.keys(meta).length).toBeLessThanOrEqual(24);
		expect(meta['Phantom project']).toBe(`https://phantom.test/projects/${p.number}`);
		expect(meta['Phantom submission']).toBe(id);
	});

	test('Ari decisions apply once, cap at the new work, and taking one back returns the hours', async () => {
		const { cachedBalance } = await import('../src/lib/server/ledger');
		const u = await user();
		const p = await projects.createProject(u.id, { ...draft, hackatimeProjects: 'work' });
		const shipped = await ship(u, p);
		if (!shipped.ok) throw Error(shipped.error);
		const id = shipped.submission.id;

		/* Ari's figure is the grant, even past what Phantom counted at the ship
		   - Ari counts up to the day it reviews. */
		const first = await deliver(id, 'review.approved', { deliveryId: 'once', minutes: 900 });
		expect(first).toMatchObject({ outcome: 'applied' });
		expect(await cachedBalance(u.id)).toBe(54000);
		expect((await reviews.submissionById(id))?.justification).toContain(
			'Reviewed on Ari by @an Ari reviewer'
		);

		/* A retry of the same delivery, and a resend of it under a new id. */
		expect(await deliver(id, 'review.approved', { deliveryId: 'once' })).toBe('duplicate');
		expect(await deliver(id, 'review.approved')).toMatchObject({ outcome: 'ignored' });
		expect(await cachedBalance(u.id)).toBe(54000);

		/* Requeued: back in review, hours off the balance; approved again, back on. */
		expect(await deliver(id, 'review.requeued')).toMatchObject({ outcome: 'applied' });
		expect((await reviews.submissionById(id))?.state).toBe('pending');
		expect(await cachedBalance(u.id)).toBe(0);
		expect(await deliver(id, 'review.approved')).toMatchObject({ outcome: 'applied' });
		expect(await cachedBalance(u.id)).toBe(36000);

		/* Reverted: closed, hours off, and the time is shippable again. */
		expect(await deliver(id, 'review.reverted')).toMatchObject({ outcome: 'applied' });
		expect((await reviews.submissionById(id))?.state).toBe('reverted');
		expect(await cachedBalance(u.id)).toBe(0);
		expect(await reviews.lastApproved(p.id)).toBeNull();
	});

	test("an approval Ari has not finished deciding waits for Ari's second pass", async () => {
		const { cachedBalance } = await import('../src/lib/server/ledger');
		const u = await user();
		const p = await projects.createProject(u.id, { ...draft, hackatimeProjects: 'work' });
		const shipped = await ship(u, p);
		if (!shipped.ok) throw Error(shipped.error);
		const id = shipped.submission.id;

		ariStatuses.set(ariIdFor(id), { phase: 'second_pass', decision: null });
		expect(await deliver(id, 'review.approved', { deliveryId: 'early' })).toMatchObject({
			outcome: 'waiting'
		});
		expect(await cachedBalance(u.id)).toBe(0);
		expect(await decisions.applyWaiting('early')).toBe('waiting');

		ariStatuses.set(ariIdFor(id), { phase: 'reviewed', decision: 'approved' });
		expect(await decisions.applyWaiting('early')).toBe('applied');
		expect(await cachedBalance(u.id)).toBe(36000);
		expect(await decisions.applyWaiting('early')).toBe('gone');
	});

	test('a change request opens the project and sending it back is the same submission', async () => {
		const u = await user();
		const p = await projects.createProject(u.id, { ...draft, hackatimeProjects: 'work' });
		const shipped = await ship(u, p);
		if (!shipped.ok) throw Error(shipped.error);
		const id = shipped.submission.id;

		expect(await deliver(id, 'review.changes')).toMatchObject({ outcome: 'applied' });
		expect(await projects.isUnderReview(p.number, u.id)).toBe(false);
		expect((await ship(u, p)).ok).toBe(false);
		const back = await reviews.resumeAfterChanges({ user: u, projectNumber: p.number, note: null });
		expect(back).toMatchObject({ ok: true, submission: { id, state: 'pending' } });
	});
});
