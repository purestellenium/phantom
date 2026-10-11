/**
 * One shape for every history on the site: who did it, what it was, the
 * figure, the words, and when. The project page, both order pages, the
 * ledger, the audit log and a person's page all draw their entries through
 * Log.svelte from this.
 */
export type LogEntry = {
	id: string;
	/** Who did it. Null is the system. */
	actor: { name: string; avatarUrl: string | null } | null;
	/** Where the actor's name goes, if anywhere. */
	href?: string | null;
	badge?: { label: string; tone?: string } | null;
	/** The figure beside the badge: hours, a delta. */
	summary?: string | null;
	/** An amount of fragments beside it, drawn with the fragment mark (see
	 *  Fragments.svelte) after the summary, if there is one - with words to
	 *  follow it ("taken back"). `signed` for a ledger row. */
	fragments?: { seconds: number; signed?: boolean; after?: string } | null;
	/** The words the reader was told. */
	message?: string | null;
	/** Words only staff see, set apart. */
	internal?: string | null;
	/** What the entry is - a submission state (`pending`, `approved`, ...),
	 *  `comment`, `fraud_hold`, `fraud_cleared` - for a reader that draws
	 *  kinds differently. The badge's tone is the same on a rejection and a
	 *  fraud hold; this is what tells them apart. */
	kind?: string;
	/** What the internal block is called; "internal" unless it is data. */
	internalTag?: string;
	/** On the approval of a ship that is still approved: which ship, and
	 *  whether it is hyper-chroma (see projects/hyper-chroma.ts). The pill is
	 *  drawn beside the badge; a page may hang controls for the ship off it. */
	ship?: { submissionId: string; hyperChroma: boolean } | null;
	at: Date;
};
