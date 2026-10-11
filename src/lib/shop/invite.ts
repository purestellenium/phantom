/**
 * The reserved slug of the one product this application knows by name.
 *
 * It lives here, in a module that imports nothing, rather than beside the
 * queries that use it in lib/server/shop/invite.ts - those read the catalog,
 * the catalog guards this slug against being renamed, and a constant shared
 * between the two would otherwise close a cycle between the two files.
 *
 * What the invite IS, and why a slug rather than a column, is written where the
 * queries are.
 */
export const INVITE_SLUG = 'invite';

/**
 * The day the invite admits you to, as it is printed.
 *
 * A string rather than a `Date` run through `day()`, and that is the point:
 * `day()` reads its numbers in UTC for the server's render and in the reader's
 * own zone once the browser takes over (see $lib/status.ts), which is correct
 * for a timestamp - when a thing happened - and wrong for this. The gathering
 * is on the twelfth in Philadelphia for everybody, whatever zone they are
 * reading in; passing it through `day()` would print the eleventh to anyone
 * west of UTC the moment the page hydrated, and print it only THEN, so the date
 * would visibly change after load.
 *
 * ISO order to match every other date on the site, which is set in the same
 * tabular figures for the same reason.
 */
export const EVENT_DAY = '2027-02-12';
