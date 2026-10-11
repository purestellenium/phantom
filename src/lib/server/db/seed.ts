/**
 * Bring a fresh database up to the state the application expects to find.
 *
 * Two things qualify: the settings singleton, and the invite - the one product
 * the application itself refers to by name, which the shop and the dashboard
 * both look for. Everything else in this schema describes people, and people
 * arrive by signing in; a seeded user would be a fiction that behaves like a
 * real row until something tries to use its provider tokens.
 *
 * Idempotent by construction, so running it twice is not a mistake and running
 * it against a database that already has traffic changes nothing. That property
 * is what lets it be part of a deploy rather than a thing someone remembers to
 * do once.
 *
 *   bun run db:seed
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { inArray, sql as raw } from 'drizzle-orm';
import postgres from 'postgres';

import { BOOTSTRAP_CAPABILITIES, capabilityArrayLiteral } from '../auth/capabilities';
import { INVITE_SLUG } from '../../shop/invite';
import { REFERRAL_STICKERS_SLUG } from '../../referral';
import { productRevisions, products, siteSettings, users } from './schema';
import { databaseUrl } from './url';

/* Its own connection, not the app's `db` handle, so nothing this script imports
 * reaches `$env`: it runs under bun, outside SvelteKit, where that virtual
 * module does not resolve. The migrate script opens Postgres the same way, for
 * the same reason. `databaseUrl()` reads `process.env`, which bun fills from
 * `.env`. */
const sql = postgres(databaseUrl());
const db = drizzle(sql);

async function seed() {
	/* The launch flag starts closed.
	 *
	 * A default of "open" would mean that the window between a database being
	 * created and an operator setting the flag is a window in which the site is
	 * live - which is exactly backwards for a gate whose entire purpose is to
	 * hold the doors until someone decides otherwise. Closed is the only safe
	 * direction for this default to fail in.
	 *
	 * onConflictDoNothing rather than an upsert: if the row is already there, an
	 * operator has almost certainly touched it, and a seed script that quietly
	 * reset a live launch flag to false would be a genuinely bad afternoon. */
	const [settings] = await db
		.insert(siteSettings)
		.values({
			id: 'singleton',
			launched: false,
			prelaunchMessage: "phantom opens soon. we'll email you the moment it does."
		})
		.onConflictDoNothing({ target: siteSettings.id })
		.returning();

	if (settings) {
		console.log('site settings: created, launched = false');
	} else {
		const [existing] = await db.select().from(siteSettings);
		console.log(
			`site settings: already present, launched = ${existing?.launched ?? 'unknown'} (left alone)`
		);
	}

	/**
	 * The invite, which is the second thing that qualifies.
	 *
	 * A product row rather than people, and the only one the application knows by
	 * name: the shop pins it above the grid and the dashboard's goal meter is
	 * measuring progress toward affording it, both by the reserved slug (see
	 * lib/shop/invite.ts). Without the row the shop is a shop with no prize in it
	 * and the meter is counting toward nothing in particular.
	 *
	 * Seeded INACTIVE, with the placeholder copy below. Active would put an
	 * unwritten card in front of participants the moment the site opened; this
	 * way the row exists to be edited - name, description, picture, stock - and
	 * goes on sale when an operator ticks it active in the console.
	 *
	 * `onConflictDoNothing` on the slug for the same reason the settings row uses
	 * it: if it is already there, somebody has edited it, and a seed that reset
	 * the prize's price or copy on every deploy would be worse than one that did
	 * nothing at all. The price here is the first value only: the home page's
	 * goal meter counts toward whatever this row says it costs, so repricing it
	 * in the console moves the goal with it.
	 */
	const [invite] = await db
		.insert(products)
		.values({
			slug: INVITE_SLUG,
			name: 'the invite',
			description: 'what the fifty hours are for. an operator writes this line.',
			kind: 'physical',
			/* No category, deliberately: it is not on a shelf with the stickers. */
			categoryId: null,
			price: 50 * 3600,
			/* One each, ever. The purchase transaction enforces it; this is where
			   the number is set. */
			perUserLimit: 1,
			requiresEligibility: true,
			active: false
		})
		.onConflictDoNothing({ target: products.slug })
		.returning();

	console.log(
		invite
			? `invite: created, inactive, ${invite.price / 3600}h (edit it in the console)`
			: 'invite: already present (left alone)'
	);

	/* The stickers the first referral earns - see lib/server/referrals.ts. Priced
	   at six minutes, which is their fifty cents; the claim credits exactly that
	   back, so the price only matters to the ledger. Left alone if present. */
	const [stickers] = await db
		.insert(products)
		.values({
			slug: REFERRAL_STICKERS_SLUG,
			name: 'custom stickers',
			description: 'a pack of phantom stickers, for inviting a friend.',
			imageUrl:
				'https://cdn.hackclub.com/01a05e1b-d96a-78d7-ad99-cddb75e19000/pile_of_stickers.png',
			kind: 'physical',
			categoryId: null,
			price: 6 * 60,
			perUserLimit: 1,
			requiresEligibility: false,
			active: false
		})
		.onConflictDoNothing({ target: products.slug })
		.returning();

	/* Its first revision, which the purchase freezes onto an order. Without one
	   the product is "misconfigured" until somebody happens to edit it. */
	if (stickers) {
		await db.insert(productRevisions).values({
			productId: stickers.id,
			version: stickers.version,
			name: stickers.name,
			description: stickers.description,
			kind: stickers.kind,
			currency: stickers.currency,
			price: stickers.price,
			perUserLimit: stickers.perUserLimit,
			requiresEligibility: stickers.requiresEligibility,
			optionSchema: stickers.optionSchema
		});
	}

	console.log(
		stickers
			? 'custom stickers: created, inactive (edit and activate them in the console)'
			: 'custom stickers: already present (left alone)'
	);

	/* A cheap assertion that the constraint really is doing what the schema
     comment claims. If a second row can exist, every read of this table becomes
     order-dependent, and that is the kind of thing worth finding out here rather
     than from an inconsistent launch. */
	const [{ count }] = await db.select({ count: raw<number>`count(*)::int` }).from(siteSettings);
	if (count !== 1) {
		throw new Error(
			`site_settings holds ${count} rows; it must hold exactly one. ` +
				'The singleton check constraint is missing or was dropped.'
		);
	}

	/* The capabilities an admin role does not imply, for the people named in
     ADMIN_HCA_SUBJECTS.
   *
   * The sign-in callback already does this, so on a fresh deployment nothing
   * here fires. It exists for the case the callback cannot reach: somebody who
   * was already an admin before the capability system existed, whose next
   * sign-in is whenever they happen to have one. Without this, the first
   * ledger correction on an upgraded database waits on somebody logging out.
   *
   * A union, never a replacement, exactly as the callback does it - this
   * variable is a floor and not a ceiling, so a capability granted by a
   * colleague survives a seed run. */
	const subjects = (process.env.ADMIN_HCA_SUBJECTS ?? '')
		.split(',')
		.map((subject) => subject.trim())
		.filter(Boolean);

	if (subjects.length > 0) {
		const promoted = await db
			.update(users)
			.set({
				/* Promote, never demote, exactly as the sign-in callback does it: an
           owner named in this variable stays an owner. */
				role: raw`case when ${users.role} = 'owner' then ${users.role} else 'admin'::user_role end`,
				capabilities: raw`(
          select coalesce(array_agg(distinct value), '{}')
          from unnest(
            ${users.capabilities} || ${capabilityArrayLiteral(BOOTSTRAP_CAPABILITIES)}::capability[]
          ) as value
        )`,
				updatedAt: new Date()
			})
			.where(inArray(users.hcaSubject, subjects))
			.returning({ email: users.email });

		console.log(
			promoted.length === 0
				? `bootstrap admins: none of the ${subjects.length} configured subjects has signed in yet`
				: `bootstrap admins: ${promoted.map((row) => row.email).join(', ')}`
		);
	}

	/* The same bootstrap one rank up, for OWNER_HCA_SUBJECTS.
	 *
	 * Owner answers "who appoints the first owner": canActOn refuses an equal
	 * rank, so without a seeded owner the first could only be minted in psql. It
	 * runs after the admin promotion, though order does not matter - the admin
	 * promotion's `case when role = 'owner'` already preserves an owner. No
	 * capabilities are set: the owner role implies every one, and this is a floor,
	 * never a ceiling. */
	const owners = (process.env.OWNER_HCA_SUBJECTS ?? '')
		.split(',')
		.map((subject) => subject.trim())
		.filter(Boolean);

	if (owners.length > 0) {
		const promoted = await db
			.update(users)
			.set({
				/* Owner is the top rank, so this is always a promotion or a no-op - no
				   `case` guard the way the admin promotion needs one. */
				role: raw`'owner'::user_role`,
				updatedAt: new Date()
			})
			.where(inArray(users.hcaSubject, owners))
			.returning({ email: users.email });

		console.log(
			promoted.length === 0
				? `bootstrap owners: none of the ${owners.length} configured subjects has signed in yet`
				: `bootstrap owners: ${promoted.map((row) => row.email).join(', ')}`
		);
	}

	console.log('seed complete.');
}

seed()
	.catch((error) => {
		console.error('seed failed:', error);
		process.exitCode = 1;
	})
	/* postgres-js keeps the socket open, which would otherwise hold the process
     alive after the work is done and make this look like a hang. */
	.finally(() => sql.end());
