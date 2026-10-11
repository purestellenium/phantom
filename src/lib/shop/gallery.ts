/**
 * How many pictures a product may carry beyond its cover.
 *
 * It lives here, in a module that imports nothing, rather than beside the
 * catalog writes that enforce it: the console's product form has to say the
 * number next to the box an operator types URLs into, and that component runs
 * in the browser, where `$lib/server` cannot be reached. Same reasoning, and
 * the same shape, as INVITE_SLUG in ./invite.ts.
 *
 * Not a technical limit. A gallery longer than this is a product that wants a
 * page of its own rather than a card. The `products_images_sane` check
 * constraint holds the same number at the column.
 */
export const MAX_GALLERY = 8;
