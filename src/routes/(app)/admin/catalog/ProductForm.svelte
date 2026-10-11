<script lang="ts">
	/**
	 * The product form, shared by create and edit.
	 *
	 * One component rather than two nearly-identical ones, because the failure
	 * mode of two is that a field is added to the create form and forgotten on
	 * the edit form - and the missing field then reads as "blank" on every save,
	 * silently clearing whatever was there.
	 *
	 * No state of its own. Everything it does is set initial values, and the
	 * option schema is a textarea holding JSON rather than a builder UI: the
	 * schema is data an operator authors, the shape is documented next to the
	 * box, and a builder would be a lot of client JavaScript standing between
	 * somebody and a field they can already see.
	 */
	import { enhance } from '$app/forms';

	import { autoScheme } from '$lib/auto-scheme';
	import { MAX_GALLERY } from '$lib/shop/gallery';
	import { FRAGMENT_SECONDS } from '$lib/fragments';
	import { MAX_OPTIONS, MAX_TEXT_LENGTH } from '$lib/shop/options';

	import CountryPicker from './CountryPicker.svelte';
	import type { FormCategory, FormProduct } from './draft';

	let {
		product,
		kinds,
		categories,
		action,
		submitLabel
	}: {
		/** Null when creating. */
		product: FormProduct | null;
		kinds: readonly string[];
		/** The shelves on offer. Empty until somebody makes one, which is why the
		 *  select below says so rather than rendering an empty dropdown. */
		categories: readonly FormCategory[];
		action: string;
		submitLabel: string;
	} = $props();

	const EXAMPLE = `[
  {
    "type": "select",
    "key": "size",
    "label": "size",
    "required": true,
    "choices": [
      { "value": "s", "label": "small" },
      { "value": "m", "label": "medium", "extraHours": 4 }
    ]
  },
  {
    "type": "select",
    "key": "colour",
    "label": "colour",
    "required": true,
    "choices": [
      { "value": "black", "label": "black", "image": "https://cdn.hackclub.com/black.jpg" },
      { "value": "sand", "label": "sand", "image": "https://cdn.hackclub.com/sand.jpg" }
    ]
  },
  {
    "type": "text",
    "key": "engraving",
    "label": "engraving",
    "required": false,
    "maxLength": 40
  }
]`;
</script>

<form method="POST" {action} class="panel-body form" use:enhance>
	<div class="form-field">
		<label class="form-label" for="name">name</label>
		<input
			id="name"
			name="name"
			class="control-input"
			type="text"
			maxlength="120"
			value={product?.name ?? ''}
			required
		/>
	</div>

	<div class="form-field">
		<label class="form-label" for="slug">slug</label>
		<input
			id="slug"
			name="slug"
			class="control-input"
			type="text"
			pattern="[a-z0-9]+(-[a-z0-9]+)*"
			maxlength="80"
			value={product?.slug ?? ''}
			required
		/>
		<span class="form-hint">the url. changing it breaks every link anyone has to this product.</span
		>
	</div>

	<div class="form-field">
		<label class="form-label" for="description">description</label>
		<textarea
			id="description"
			name="description"
			class="control-textarea"
			maxlength="1000"
			value={product?.description ?? ''}></textarea>
		<span class="form-hint"
			>plain text. it is rendered as text, so there is no markup to get wrong.</span
		>
	</div>

	<div class="form-field">
		<label class="form-label" for="imageUrl">image url</label>
		<input
			id="imageUrl"
			name="imageUrl"
			class="control-input"
			type="url"
			pattern="https?://.+"
			use:autoScheme
			value={product?.imageUrl ?? ''}
		/>
	</div>

	<div class="form-field">
		<label class="form-label" for="images">gallery</label>
		<textarea id="images" name="images" class="control-textarea" rows="4"
			>{product?.images ?? ''}</textarea
		>
		<span class="form-hint"
			>one url per line, up to {MAX_GALLERY}. the image above is the cover and comes first; these
			follow it on the product page. cards and orders show the cover only.</span
		>
	</div>

	<div class="form-field">
		<label class="form-label" for="imagePadding">image padding</label>
		<input
			id="imagePadding"
			name="imagePadding"
			class="control-input"
			type="number"
			min="0"
			max="64"
			step="1"
			value={product?.imagePadding ?? 0}
		/>
		<span class="form-hint"
			>pixels of space around the picture on its card. 0 bleeds it to the edges, which suits a
			photograph; a cut-out on nothing usually wants a little air.</span
		>
	</div>

	<div class="form-grid">
		<div class="form-field">
			<label class="form-label" for="kind">kind</label>
			<div class="select-field">
				<select id="kind" name="kind" class="control-select" value={product?.kind ?? 'digital'}>
					{#each kinds as kind (kind)}
						<option value={kind}>{kind}</option>
					{/each}
				</select>
				<span class="select-caret" aria-hidden="true">▼</span>
			</div>
			<span class="form-hint">physical is the only kind that asks for an address.</span>
		</div>

		<div class="form-field">
			<label class="form-label" for="categoryId">category</label>
			<div class="select-field">
				<select
					id="categoryId"
					name="categoryId"
					class="control-select"
					value={product?.categoryId ?? ''}
					disabled={categories.length === 0}
				>
					<!-- Always offered, and first. Unfiled is a state a product is
					     allowed to stay in, so taking a shelf off has to be as easy as
					     putting one on. -->
					<option value="">no category</option>
					{#each categories as category (category.id)}
						<option value={category.id}>{category.name}</option>
					{/each}
				</select>
				<span class="select-caret" aria-hidden="true">▼</span>
			</div>
			<span class="form-hint">
				{#if categories.length === 0}
					there are no categories yet. the catalog page makes them.
				{:else}
					which shelf it is filed under in the shop. filing does not bump the version.
				{/if}
			</span>
		</div>

		<div class="form-field">
			<label class="form-label" for="price">price in fragments</label>
			<!-- The row holds seconds, like everything else that touches the ledger;
			     the operator types fragments. The conversion back is in readDraft, which
			     is the only place that reads this box. -->
			<input
				id="price"
				name="price"
				class="control-input"
				type="number"
				min="1"
				step="1"
				value={product && product.price !== '' ? product.price / FRAGMENT_SECONDS : ''}
				required
			/>
			<span class="form-hint">
				whole fragments (10 = an hour of work). changing this bumps the version; past orders keep
				what they paid.
			</span>
		</div>

		<div class="form-field">
			<label class="form-label" for="position">position</label>
			<input
				id="position"
				name="position"
				class="control-input"
				type="number"
				min="-9999"
				max="9999"
				step="1"
				value={product?.position ?? 0}
			/>
			<span class="form-hint">
				order among items at the same price, low first. ties go alphabetical; it never moves
				anything past a different price.
			</span>
		</div>

		<div class="form-field">
			<label class="form-label" for="stock">stock</label>
			<input
				id="stock"
				name="stock"
				class="control-input"
				type="number"
				min="0"
				step="1"
				value={product?.stock ?? ''}
			/>
			<span class="form-hint">blank means unlimited. zero means sold out.</span>
		</div>

		<div class="form-field">
			<label class="form-label" for="perUserLimit">per person</label>
			<input
				id="perUserLimit"
				name="perUserLimit"
				class="control-input"
				type="number"
				min="1"
				step="1"
				value={product?.perUserLimit ?? ''}
			/>
			<span class="form-hint">blank means no limit. rejected and cancelled orders release it.</span>
		</div>

		<div class="form-field">
			<label class="form-label" for="availableFrom">opens (UTC)</label>
			<input
				id="availableFrom"
				name="availableFrom"
				class="control-input"
				type="datetime-local"
				value={product?.availableFrom ?? ''}
			/>
		</div>

		<div class="form-field">
			<label class="form-label" for="availableUntil">closes (UTC)</label>
			<input
				id="availableUntil"
				name="availableUntil"
				class="control-input"
				type="datetime-local"
				value={product?.availableUntil ?? ''}
			/>
		</div>
	</div>

	<div class="form-field">
		<span class="form-label">hidden in these countries</span>
		<CountryPicker selected={product?.blockedCountries ?? []} />
		<span class="form-hint">
			for things that cannot reach somewhere. people whose shipping address is in one of these never
			see it, checkout refuses an address in one, and anyone whose country we do not know yet sees
			it with a note saying where it is unavailable. does not bump the version.
		</span>
	</div>

	<!-- Unlisted by default. The moment something is listed it is buyable, and a
	     half-filled product going live while somebody is still typing into it is
	     a real order at a real price. -->
	<label class="check-field">
		<input type="checkbox" name="active" checked={product?.active ?? false} />
		listed in the shop
	</label>

	<label class="check-field">
		<input
			type="checkbox"
			name="requiresEligibility"
			checked={product?.requiresEligibility ?? true}
		/>
		only eligible people may buy it
	</label>

	<div class="form-field">
		<label class="form-label" for="optionSchema">options</label>
		<textarea
			id="optionSchema"
			name="optionSchema"
			class="control-textarea is-code"
			rows="12"
			value={product?.optionSchema ?? ''}
			spellcheck="false"></textarea>
		<span class="form-hint">
			a JSON array, up to {MAX_OPTIONS} entries. every submitted value is checked against this - against
			the version the order bought, not this one - so an option that is not here cannot end up on an order.
		</span>
		<!-- The shape, written out. An operator authoring JSON by hand needs the
		     grammar in front of them, and a link to a doc is a link nobody follows
		     while they are mid-form. -->
		<pre class="console-pre">{EXAMPLE}</pre>
		<span class="form-hint">
			keys are lowercase letters, digits and underscores. text options are capped at {MAX_TEXT_LENGTH}
			characters whatever you write here.
		</span>
		<!-- The pricing rule, next to the field that sets it. An operator reading
		     the grammar above needs to know that the price they typed higher up is
		     a floor, not an average. -->
		<span class="form-hint">
			<code>extraHours</code> on a choice adds to the price above, in whole hours of work (10 fragments
			each) - so the price you set is what the CHEAPEST configuration costs, and the shop shows it as
			"from". it cannot be negative, and a required option needs one choice that adds nothing, or the
			price on the card is one nobody can pay.
		</span>
	</div>

	<div class="form-actions">
		<button type="submit" class="control-btn">{submitLabel}</button>
	</div>
</form>
