/**
 * What the Hackatime link's `?link_error=` codes mean, in the site's voice.
 *
 * The callback (api/auth/hackatime/callback) sends a code rather than a
 * sentence - a query string is not a place for provider error prose - and it
 * sends it back to wherever the link was started: onboarding's setup step, a
 * project page, the new-project flow, the account page. These used to be
 * turned into words on the account page alone, so everywhere else a failed
 * link came back as nothing but a code in the address. LinkErrorNotice reads
 * this from both frames, so whichever page it lands on says what happened.
 */
export const LINK_ERRORS: Record<string, { title: string; body: string }> = {
	already_linked: {
		title: 'that hackatime account is taken',
		body: "it's already linked to a different phantom account, so it can't be linked to this one too. if it's yours, ask an organiser to move it."
	},
	locked: {
		title: "your hackatime link can't change",
		body: "you've shipped a project with the hackatime account you have linked, so it can't move to a different one. reconnecting the same account still works - if your account really changed, ask an organiser."
	},
	denied: {
		title: 'hackatime linking was cancelled',
		body: 'nothing was changed. link it again whenever you are ready.'
	},
	expired: {
		title: 'that took too long',
		body: 'the link attempt timed out. try linking hackatime again.'
	},
	bad_state: {
		title: 'that link attempt had expired',
		body: 'try linking hackatime again.'
	},
	wrong_user: {
		title: 'that link was started by a different sign-in',
		body: 'try linking hackatime again from here.'
	},
	provider_error: {
		title: "hackatime didn't answer",
		body: 'try linking again in a moment.'
	},
	provider_unavailable: {
		title: "hackatime linking isn't available right now",
		body: 'try again later.'
	}
};
