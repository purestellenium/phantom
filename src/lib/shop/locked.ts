import { INVITE_SLUG } from '$lib/shop/invite';

/**
 * What a person held to the event can still buy: the invite, and the stipend
 * that gets them there. Everything else in the shop is closed to them - see
 * `users.shopLocked`, which an operator sets on their admin page.
 *
 * By slug, the way the shop and home already find the invite. The flight
 * stipend's slug is the catalog's; renaming it there means renaming it here.
 */
export const EVENT_ONLY_SLUGS: readonly string[] = [INVITE_SLUG, 'flight-stipend'];

export function lockedOut(shopLocked: boolean, slug: string): boolean {
	return shopLocked && !EVENT_ONLY_SLUGS.includes(slug);
}

export const SHOP_LOCKED_MESSAGE =
	"Since you've received a visa letter or a flight stipend from us, your shop is limited to the invite and the flight stipend to Phantom.";
