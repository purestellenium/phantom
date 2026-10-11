/**
 * Form rejection in the page's own material.
 *
 * The browser's validation bubble is a native popup painted over the page: it
 * cannot be dithered and it ignores the palette. Every `invalid` event is
 * caught here instead, the bubble is suppressed, and the field itself goes red
 * with one line under it - the same treatment the landing page gives its email
 * box. The browser still decides what is invalid and still blocks the submit;
 * only the reporting is ours.
 *
 * Installed once from the signed-in layout. Any control inside a `.form-field`
 * gets a message under it; a control outside one just turns red.
 */

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function isControl(target: EventTarget | null): target is Control {
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
	);
}

function messageFor(el: Control): string {
	const v = el.validity;
	const type = el instanceof HTMLInputElement ? el.type : 'text';
	if (v.valueMissing) return 'this is required.';
	if (v.typeMismatch || v.patternMismatch) {
		if (type === 'email') return 'that address does not look right.';
		if (type === 'url') return 'that does not look like a link. it needs to start with https://';
		return el.title || 'that does not look right.';
	}
	if (v.rangeUnderflow || v.rangeOverflow) return 'that number is out of range.';
	if (v.tooLong || v.tooShort) return 'that is the wrong length.';
	if (v.stepMismatch) return 'that number is not allowed here.';
	return el.validationMessage || 'that does not look right.';
}

function mark(el: Control): void {
	el.classList.add('is-invalid');
	el.setAttribute('aria-invalid', 'true');
	const field = el.closest('.form-field');
	if (!field) return;
	let error = field.querySelector<HTMLElement>(':scope > .form-error[data-validation]');
	if (!error) {
		error = document.createElement('span');
		error.className = 'form-error';
		error.dataset.validation = '';
		error.setAttribute('role', 'alert');
		field.append(error);
	}
	error.textContent = messageFor(el);
}

function clear(el: Control): void {
	if (!el.classList.contains('is-invalid')) return;
	el.classList.remove('is-invalid');
	el.removeAttribute('aria-invalid');
	el.closest('.form-field')?.querySelector(':scope > .form-error[data-validation]')?.remove();
}

export function installValidation(): () => void {
	function onInvalid(e: Event) {
		if (!isControl(e.target)) return;
		e.preventDefault();
		mark(e.target);
		/* The events arrive in document order, so the first one whose form does
		   not already hold focus on a rejected field is the first rejection. */
		const active = document.activeElement;
		const alreadyThere =
			isControl(active) && active.form === e.target.form && active.classList.contains('is-invalid');
		if (!alreadyThere) e.target.focus();
	}

	function onEdit(e: Event) {
		if (isControl(e.target)) clear(e.target);
	}

	document.addEventListener('invalid', onInvalid, true);
	document.addEventListener('input', onEdit, true);
	document.addEventListener('change', onEdit, true);
	return () => {
		document.removeEventListener('invalid', onInvalid, true);
		document.removeEventListener('input', onEdit, true);
		document.removeEventListener('change', onEdit, true);
	};
}
