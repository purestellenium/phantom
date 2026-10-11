<script lang="ts">
	/**
	 * "Are you sure?", in the frame rather than in the browser chrome.
	 *
	 * `confirm()` was the obvious thing and is the wrong one: it is a system
	 * dialog in the system's typeface with the system's buttons, it says the
	 * page's origin above the question, and some browsers offer to suppress it
	 * for the rest of the session - which turns a guard on an irreversible act
	 * into a checkbox the person ticked once, days ago, to stop being asked. It
	 * also cannot say which project, in a sentence, in the voice the rest of the
	 * page is written in.
	 *
	 * So this, on the same `<dialog>` and the same `.modal` material the new
	 * project form uses. The mechanics below are the fiddly half of that pattern
	 * - the out transition, the backdrop click, Escape - and they live here so a
	 * second confirmation somewhere else is a component and not a copy.
	 *
	 * It confirms; it does not act. The parent hands it the form, and the
	 * submit inside is a real POST to a real action - so the refusal that
	 * matters is still the server's.
	 */
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		title,
		confirmLabel = 'confirm',
		cancelLabel = 'cancel',
		danger = false,
		/** Confirm drawn as the secondary button, for a confirmation whose
		 *  point is to talk someone out of it - the way back is then the
		 *  button that looks like the thing to press. */
		quiet = false,
		/** The action the confirm button submits to. A plain `<form>` post, so
		 *  this works with scripting off - the button that opens the dialog is
		 *  the only thing that does not. */
		action,
		body
	}: {
		open?: boolean;
		title: string;
		confirmLabel?: string;
		cancelLabel?: string;
		danger?: boolean;
		quiet?: boolean;
		action: string;
		body: Snippet;
	} = $props();

	let dialog: HTMLDialogElement | undefined = $state();
	let closing = $state(false);

	/* `open` is the parent's word and `dialog.open` is the browser's, and only
	   `showModal()` can put an element in the top layer - setting the attribute
	   renders a non-modal dialog with no backdrop. So the prop drives the
	   method, in both directions, rather than being bound to the element. */
	let cancelEl: HTMLButtonElement | undefined = $state();
	$effect(() => {
		if (open && dialog && !dialog.open) {
			dialog.showModal();
			/* Focus lands on cancel, not on the destructive button. `showModal`
			   would otherwise autofocus the first tabbable thing in the dialog, so
			   this is placed rather than added - done here rather than with the
			   `autofocus` attribute, which is a page-load behaviour being borrowed
			   for something else and which the a11y rule is right to flag. */
			cancelEl?.focus();
		}
	});

	/**
	 * Play the way out before actually closing.
	 *
	 * `close()` drops the dialog from the top layer on the spot, so there is
	 * nothing left to animate - the same trap the new project modal documents.
	 * `.is-closing` (see modal.css) is the target to transition to while it is
	 * still open, and the real close waits for that to finish.
	 *
	 * `transitionend` fires once per animated property; the guard makes every
	 * call after the first a no-op. The timeout is the fallback for the one
	 * case where it never fires at all - `prefers-reduced-motion`, where the
	 * duration is zero.
	 */
	function close() {
		if (!dialog || closing) return;
		closing = true;
		const finish = () => {
			if (!closing) return;
			closing = false;
			dialog?.close();
			open = false;
		};
		dialog.addEventListener('transitionend', finish, { once: true });
		setTimeout(finish, 250);
	}

	/* A click on the backdrop has no element of its own to land on - it is
	   reported with the dialog as its target, which is also true of the dialog's
	   own box and of nothing inside it. */
	function onClick(event: MouseEvent) {
		if (event.target === dialog) close();
	}

	/* Escape, whose default is an immediate unanimated close. */
	function onCancel(event: Event) {
		event.preventDefault();
		close();
	}
</script>

<dialog
	class="modal"
	class:is-closing={closing}
	bind:this={dialog}
	aria-labelledby="confirm-title"
	onclick={onClick}
	oncancel={onCancel}
>
	<header class="panel-head">
		<h2 class="panel-title" id="confirm-title">{title}</h2>
	</header>
	<form class="panel-body form" method="POST" {action}>
		{@render body()}
		<div class="form-actions">
			<!-- Cancel first, and it is the one the dialog opens focused on. The
			     destructive button being a reflex away from the Enter key is how a
			     confirmation becomes a formality. -->
			<button type="button" class="control-btn" bind:this={cancelEl} onclick={close}
				>{cancelLabel}</button
			>
			<button type="submit" class={['control-btn', danger && 'is-danger', quiet && 'is-quiet']}
				>{confirmLabel}</button
			>
		</div>
	</form>
</dialog>
