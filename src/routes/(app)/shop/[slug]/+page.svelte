<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	import Fragments from '$lib/components/Fragments.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { thumbField } from '$lib/field/thumb';
	import { OPTION_FIELD_PREFIX, priceRange, surchargeFor } from '$lib/shop/options';
	import { FRAGMENT_SECONDS, fragments } from '$lib/fragments';

	let { data, form }: PageProps = $props();

	/* Reuse the intent from a failed attempt, or the fresh one. A refusal that
	   came back with an empty one means the form it answered had none, and a
	   fresh one is the right thing to offer then. */
	const intent = $derived(form?.intent || data.intent);

	/* The chosen address, for the envelope below the picker. */
	/* Starts on the primary address; the initial value is all it needs. */
	let addressId = $state(untrack(() => data.defaultAddressId ?? ''));
	const chosen = $derived(
		data.addresses.find((address) => address.id === addressId) ??
			data.addresses.find((address) => address.primary) ??
			data.addresses[0] ??
			null
	);

	/* What the button says it will cost, kept in step with the quantity field.
	   The server charges `price × quantity` (see placeOrder in
	   lib/server/shop/purchase.ts) and is still the authority on that; this is
	   the same arithmetic shown early, so the figure on the button is the one
	   about to be spent rather than the price of one.

	   The raw field value is a string that can be empty or garbage mid-typing,
	   so it is parsed rather than trusted: anything that is not a whole number
	   of at least one falls back to 1, which is what an empty box means to the
	   server anyway. */
	let quantityRaw = $state('1');

	/**
	 * The ceiling on the field, or null for none.
	 *
	 * The two REAL limits, and nothing invented on top of them: how many one
	 * person may own, and how many exist. This used to fall back to ten when a
	 * product declared neither, which is where the stackable grants lost their
	 * stacking - "stack as many as you need" stopped at ten whatever the
	 * description said.
	 *
	 * Null leaves the field unbounded, which is honest: what actually stops a
	 * runaway order is the balance, and the server says so in hours when it
	 * refuses. A `max` this page invented could only ever be a worse guess than
	 * the ledger's own answer.
	 */
	const maxQuantity = $derived(data.product.perUserLimit ?? data.product.stock ?? null);
	const quantity = $derived.by(() => {
		const parsed = Number(quantityRaw);
		if (!Number.isInteger(parsed) || parsed < 1) return 1;
		return maxQuantity === null ? parsed : Math.min(parsed, maxQuantity);
	});
	/**
	 * What has been picked so far, and what it adds.
	 *
	 * Held as state rather than read off the DOM at submit time because two
	 * things want it - the per-unit price and the total on the button - and
	 * neither may disagree with the server. The server is still the authority:
	 * it recomputes this same sum from the FROZEN revision inside the purchase
	 * transaction. This is that arithmetic shown early, so the button names the
	 * figure about to be spent rather than the price of the cheapest one.
	 *
	 * Keyed by option key, which is exactly the shape `surchargeFor` takes - so
	 * the browser and the server run the same function over the same data
	 * rather than two implementations that have to be kept in step.
	 */
	let picked = $state<Record<string, string>>({});
	const surcharge = $derived(surchargeFor(data.product.options, picked));
	const unitPrice = $derived(data.product.price + surcharge);
	const total = $derived(unitPrice * quantity);

	/* How far short the balance falls of that total, or 0 when it covers it.
	   Not a refusal: the whole form stays so the reader can see every option
	   and what it costs, and only the button is held back. Worked out against
	   the live total because quantity and surcharges both move it - a balance
	   that covers one might not cover three. */
	const shortfall = $derived(data.free ? 0 : Math.max(0, total - data.balance));

	/* The same, in fragments, for the button. Rounded UP: a reader a few minutes
	   short must not be told they need "0 fragments more", and the figure should
	   be enough to get there rather than just under it. */
	const shortfallFragments = $derived(Math.ceil(shortfall / FRAGMENT_SECONDS));

	const canBuy = $derived(
		!data.refusal &&
			shortfall === 0 &&
			(data.product.kind !== 'physical' || (!data.addressError && data.addresses.length > 0))
	);

	/* Whether ANY choice on this product costs extra, which is what decides
	   between "220h" and "from 220h". A fact about the product rather than
	   about this visit, so it reads the schema and not what is picked. */
	const range = $derived(priceRange(data.product.price, data.product.options));

	/* ── the gallery ─────────────────────────────────────────────────────────

	   Two things move the picture - pressing a thumbnail, and picking an option
	   whose choice carries one - and they write the SAME variable rather than
	   competing for it. A version of this with a piece of state per input had to
	   answer "which of them wins", and every answer to that is wrong in some
	   order of clicking: choosing sand and then pressing the black thumbnail has
	   to show black, and so does the reverse. What the reader last asked to look
	   at is the whole of it. */

	/**
	 * The picture on show, or null for "whatever the gallery starts with".
	 *
	 * Null rather than eagerly holding `gallery[0]`, so the cover stays the cover
	 * without this having to be kept in step with it.
	 *
	 * A choice with no picture of its own deliberately does not clear this: a
	 * product that photographs two of its five colours should not blink back to
	 * the cover as you page through the other three.
	 */
	let view = $state<string | null>(null);

	/**
	 * Every picture this product has, in one list that never changes length.
	 *
	 * The cover, then the gallery, then any picture an option's choice switches
	 * to - all of them, all the time, whatever is currently chosen. An earlier
	 * version added a choice's picture to the strip only while it was showing
	 * and dropped it again afterwards, so the row grew and shrank under the
	 * cursor and picking a colour looked like it had loaded a different product.
	 *
	 * The consequence worth knowing about is that a choice's picture does not
	 * have to be typed into the gallery box as well: putting it on the choice is
	 * enough to put it in the strip.
	 *
	 * Deduplicated, so the same URL used as the cover and as a choice's picture
	 * is one frame that both routes light up rather than two identical ones.
	 */
	const frames = $derived([
		...new Set([
			...data.product.gallery,
			...data.product.options.flatMap((option) =>
				option.type === 'select'
					? option.choices
							.map((choice) => choice.image)
							.filter((url): url is string => url !== null)
					: []
			)
		])
	]);

	const showing = $derived(view ?? frames[0] ?? null);

	/** The picture a select's current value asks for, or null for "leave it". */
	function imageForChoice(key: string, value: string): string | null {
		const option = data.product.options.find((entry) => entry.key === key);
		if (option?.type !== 'select') return null;
		return option.choices.find((choice) => choice.value === value)?.image ?? null;
	}
</script>

<!-- The only plain hrefs here go to Hack Club's address portal, off this
     origin; in-app navigation goes through resolve(). -->
<!-- eslint-disable svelte/no-navigation-without-resolve -->

<svelte:head>
	<title>{data.product.name} · PHANTOM</title>
</svelte:head>

<div class="product">
	<!-- ── the picture ─────────────────────────────────────────────────────── -->
	<div class="product-gallery">
		{#if showing}
			<img
				class={['product-image', data.product.imagePadding > 0 && 'is-padded']}
				style={data.product.imagePadding > 0
					? `padding: ${data.product.imagePadding}px`
					: undefined}
				src={showing}
				alt=""
			/>
		{:else}
			<canvas class="product-image" use:thumbField={data.product.name}></canvas>
		{/if}

		<!-- The strip. Buttons rather than links: this changes what is on screen
		     and navigates nowhere, and a list of anchors to nothing is a keyboard
		     trap that announces itself as navigation. -->
		{#if frames.length > 1}
			<ul class="frames">
				{#each frames as frame, i (frame)}
					<li>
						<button
							type="button"
							class="frame"
							aria-label="picture {i + 1} of {frames.length}"
							aria-current={frame === showing ? 'true' : undefined}
							onclick={() => (view = frame)}
						>
							<img src={frame} alt="" />
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<!-- ── the details ─────────────────────────────────────────────────────── -->
	<div class="product-details">
		<h1 class="product-name">{data.product.name}</h1>
		<!-- "from" when some configuration costs more than the sticker. The
		     sticker is always the cheapest one - surcharges cannot be negative and
		     a required option must carry a free choice, both enforced when the
		     schema is parsed - so this is a floor and never a guess. -->
		<p class="product-price">
			{#if data.free}
				free
			{:else}
				{#if range.varies}<span class="product-from">from</span>{/if}<Fragments
					seconds={data.product.price}
				/>
			{/if}
		</p>
		{#if data.product.description}
			<p class="product-desc">{data.product.description}</p>
		{/if}

		<!-- Both facts are optional - unlimited stock and no per-person cap are
		     the ordinary case for a digital thing - so the list itself is
		     conditional rather than just its rows. An empty <dl> still carries the
		     block's own margins and gap, which left a measured band of nothing
		     between the description and the buy form that read as something that
		     had failed to load. -->
		{#if data.product.stock !== null || data.product.perUserLimit !== null}
			<dl class="product-meta">
				{#if data.product.stock !== null}
					<div>
						<dt>stock</dt>
						<dd>{data.product.stock}</dd>
					</div>
				{/if}
				{#if data.product.perUserLimit !== null}
					<div>
						<dt>limit</dt>
						<dd>{data.product.perUserLimit} per person</dd>
					</div>
				{/if}
			</dl>
		{/if}

		{#if form?.error}
			<Notice bad alert title="that did not go through" body={form.error} />
		{/if}

		{#if data.regionNotice}
			<Notice body={data.regionNotice} />
		{/if}
		{#if data.refusal}
			<Notice title={data.refusal.title} body={data.refusal.body} />
		{:else}
			<form method="POST" action="?/buy" class="form" use:enhance>
				<input type="hidden" name="intent" value={intent} />
				{#if data.replaces}
					<input type="hidden" name="replacesOrderId" value={data.replaces} />
				{/if}

				<div class="form-grid">
					<div class="form-field">
						<label class="form-label" for="quantity">how many</label>
						<input
							id="quantity"
							name="quantity"
							class="control-input"
							type="number"
							inputmode="numeric"
							min="1"
							max={maxQuantity ?? undefined}
							bind:value={quantityRaw}
							required
						/>
					</div>

					{#each data.product.options as option (option.key)}
						{@const id = `${OPTION_FIELD_PREFIX}${option.key}`}
						<div class="form-field">
							<label class="form-label" for={id}>{option.label}</label>
							{#if option.type === 'select'}
								<div class="select-field">
									<select
										{id}
										name={id}
										class="control-select"
										required={option.required}
										value=""
										onchange={(event) => {
											picked = { ...picked, [option.key]: event.currentTarget.value };
											/* Only when the choice actually carries one. The select is
											   otherwise untouched by the gallery and submits exactly
											   what it always did. */
											const image = imageForChoice(option.key, event.currentTarget.value);
											if (image) view = image;
										}}
									>
										<option value="" disabled>choose</option>
										{#each option.choices as choice (choice.value)}
											<!-- The surcharge rides in the label rather than in a column
											     of its own: a <select> row is one string, and a price the
											     reader only discovers after choosing is the thing this
											     whole feature exists to avoid. A free choice says
											     nothing, so an ordinary product reads exactly as it
											     always did. -->
											<option value={choice.value}
												>{choice.label}{choice.extraSeconds > 0
													? ` (+${fragments(choice.extraSeconds)})`
													: ''}</option
											>
										{/each}
									</select>
									<span class="select-caret" aria-hidden="true">▼</span>
								</div>
							{:else}
								<input
									{id}
									name={id}
									class="control-input"
									type="text"
									maxlength={option.maxLength}
									required={option.required}
								/>
							{/if}
						</div>
					{/each}
				</div>

				{#if data.product.kind === 'physical'}
					<!-- Where it goes: one of the addresses saved on the buyer's Hack
					     Club account, frozen onto this order. Adding or fixing one
					     happens at Hack Club, in a new tab: it is a one-way link, and a
					     half-filled checkout should survive somebody fixing a typo in
					     their address. -->
					{#if data.addressError}
						<Notice bad body="we couldn't read your Hack Club addresses. try again in a moment." />
					{:else if data.addresses.length === 0}
						<Notice body="you need a shipping address on your Hack Club account first." />
						{#if data.addressPortalUrl}
							<div class="form-actions">
								<a
									class="control-btn is-quiet"
									href={data.addressPortalUrl}
									target="_blank"
									rel="noreferrer">add one at Hack Club</a
								>
							</div>
						{/if}
					{:else}
						<div class="form-field">
							<label class="form-label" for="address_id">ship to</label>
							<div class="select-field">
								<select
									id="address_id"
									name="address_id"
									class="control-select"
									bind:value={addressId}
									required
								>
									{#each data.addresses as address (address.id)}
										<option value={address.id}>{address.label}</option>
									{/each}
								</select>
								<span class="select-caret" aria-hidden="true">▼</span>
							</div>
							{#if chosen}
								<address class="envelope">
									{#each chosen.lines as line, i (i)}
										<span>{line}</span>
									{/each}
								</address>
							{/if}
							{#if data.addressPortalUrl}
								<span class="form-hint"
									>wrong or out of date? <a
										href={data.addressPortalUrl}
										target="_blank"
										rel="noreferrer">edit it at Hack Club</a
									></span
								>
							{/if}
						</div>
					{/if}
				{/if}

				<div class="form-actions product-actions">
					<button type="submit" class="control-btn product-buy" disabled={!canBuy}>
						<!-- Short, the button says by how much instead of what it would
						     cost: the price is already at the top of the page, and the
						     gap is the one figure the reader cannot see anywhere else. -->
						{#if data.free}
							claim for free
						{:else if shortfall > 0}
							not enough fragments - you need <strong
								>{shortfallFragments.toLocaleString('en-US')}</strong
							> more
						{:else}
							buy{quantity > 1 ? ` ${quantity}` : ''} for
							<strong><Fragments seconds={total} /></strong>
						{/if}
					</button>
				</div>
			</form>
		{/if}

		{#if data.catalogId}
			<p>
				<a class="control-btn is-quiet is-small" href={resolve(`/admin/catalog/${data.catalogId}`)}
					>edit in catalog</a
				>
			</p>
		{/if}
	</div>
</div>
