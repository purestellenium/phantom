import type { DbHandle } from '$lib/server/audit';
import { launchSettings, launchSettingsNow, type LaunchSettings } from '$lib/server/launch';

/**
 * Whether the shop is open, and if not, why.
 *
 * Separate from the launch gate because they answer different questions and get
 * flipped by different people at different times. Launch decides whether the
 * site exists; this decides whether anything in it can be bought. Folding them
 * together means closing the shop for a restock takes the platform down with
 * it, and reopening it is a decision nobody wants to make at speed.
 *
 * Both halves are checked SERVER-SIDE at the mutation, not only here. The wiki
 * puts lifecycle gates in the class that must be "server-authoritative, dated",
 * and a closed shop that only hides the buttons is a shop that is open to
 * anyone who kept a form around.
 */

export type ShopWindow =
	| { open: true; closesAt: Date | null }
	| {
			open: false;
			why: 'switched_off' | 'deadline_passed';
			message: string | null;
			closedAt: Date | null;
	  };

/**
 * The window's state right now.
 *
 * The deadline wins over the switch, and that ordering is the point of having
 * both: `shopOpen` is a person's intent and `shopClosesAt` is a commitment
 * already made to participants. If the date has passed, leaving the switch on
 * must not reopen the shop by accident - reopening is done by moving the date,
 * which is a deliberate act that leaves a new date behind to point at.
 */
export async function shopWindow(now = new Date()): Promise<ShopWindow> {
	return windowFrom(await launchSettings(), now);
}

/**
 * The same window, read from the row instead of from memory.
 *
 * For the purchase itself, and nothing else. `shopWindow` answers off a
 * per-process cache, which means the instance that closed the shop knows and
 * the instance taking the next order does not - for fifteen seconds at best,
 * and indefinitely if its background refresh is failing, because a failed
 * refresh deliberately keeps the last value it had. Closing a shop has to be
 * something an operator can rely on having happened, so the mutation reads the
 * switch rather than a memory of it. See `launchSettingsNow`.
 */
export async function shopWindowNow(handle?: DbHandle, now = new Date()): Promise<ShopWindow> {
	return windowFrom(await launchSettingsNow(handle), now);
}

function windowFrom(settings: LaunchSettings, now: Date): ShopWindow {
	if (settings.shopClosesAt && settings.shopClosesAt <= now) {
		return {
			open: false,
			why: 'deadline_passed',
			message: settings.shopClosedMessage,
			closedAt: settings.shopClosesAt
		};
	}

	if (!settings.shopOpen) {
		return {
			open: false,
			why: 'switched_off',
			message: settings.shopClosedMessage,
			closedAt: null
		};
	}

	return { open: true, closesAt: settings.shopClosesAt };
}

/** The gate as one boolean, for a call site that has already decided what to
 *  say about a refusal. */
export async function shopIsOpen(now = new Date()): Promise<boolean> {
	return (await shopWindow(now)).open;
}
