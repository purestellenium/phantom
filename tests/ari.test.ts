import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

import { signIngest, verifyDelivery } from '../src/lib/server/ari-signature';
import { ariJustification, ariJustificationFields, takeSection } from '../src/lib/justification';

const SECRET = 'whsec_synthetic';
const NOW = 1_790_834_790_000;

function signed(body: string, timestamp = String(NOW / 1000), deliveryId = 'delivery_1') {
	const signature = createHmac('sha256', SECRET)
		.update(`${timestamp}.${deliveryId}.${body}`)
		.digest('hex');
	return { timestamp, deliveryId, signature, body };
}

describe('Ari signatures', () => {
	test('an ingest is signed over the exact bytes', () => {
		const body = '{"external_id":"site-9f2a"}';
		expect(signIngest(body, SECRET)).toBe(createHmac('sha256', SECRET).update(body).digest('hex'));
	});

	test('a delivery verifies over timestamp, delivery id and body', () => {
		expect(verifyDelivery(signed('{"event":"review.approved"}'), SECRET, NOW)).toBe('ok');
	});

	test('a different body, id or secret is refused', () => {
		const good = signed('{"event":"review.approved"}');
		expect(verifyDelivery({ ...good, body: '{"event":"review.rejected"}' }, SECRET, NOW)).toBe(
			'bad_signature'
		);
		expect(verifyDelivery({ ...good, deliveryId: 'another' }, SECRET, NOW)).toBe('bad_signature');
		expect(verifyDelivery(good, 'whsec_other', NOW)).toBe('bad_signature');
		expect(verifyDelivery({ ...good, signature: null }, SECRET, NOW)).toBe('bad_signature');
	});

	test('a delivery more than five minutes off is stale', () => {
		const old = signed('{}', String(NOW / 1000 - 301));
		expect(verifyDelivery(old, SECRET, NOW)).toBe('stale');
		const fine = signed('{}', String(NOW / 1000 - 299));
		expect(verifyDelivery(fine, SECRET, NOW)).toBe('ok');
	});
});

describe('ariJustificationFields', () => {
	const base = {
		awardedSeconds: 531 * 60,
		ariSeconds: 531 * 60,
		newWork: 52101,
		priorApprovals: [],
		changelog: null,
		updateDeclaration: null,
		credit: 'Reviewed on Ari by @reviewer'
	};

	/* The shape of an approval: whole minutes from Ari against Hackatime's
	   exact seconds, and technical_features = the write-up's first sentence.
	   Every value is made up. */
	const note = 'a clock that shows the tide. it ran from the demo link.';
	const real = {
		...base,
		ariSeconds: 14580,
		awardedSeconds: 14562,
		newWork: 14562,
		parts: {
			hackatime_user_id: '12345',
			hackatime_projects: 'tide-clock 1/1/2026-10/1/2026',
			technical_features: 'a clock that shows the tide.'
		},
		auditNote: note,
		checks: [
			{ label: 'The demo works', value: true },
			{ label: 'The README has screenshots', value: false }
		],
		breakdown: { hackatime: 243, journals: 0, lapse: 0, program: 0 }
	};

	test("fills the base's fields from Ari's parts", () => {
		const fields = ariJustificationFields(real);
		expect(fields.hackatimeId).toBe('12345');
		expect(fields.hackatimeProjects).toBe('tide-clock 1/1/2026-10/1/2026');
		expect(fields.technicalFeatures).toBe('a clock that shows the tide.');
		expect(fields.lapseLinks).toBeNull();
		expect(fields.alternateTracking).toBeNull();
		expect(fields.duplicate).toBeNull();
	});

	test('no deflation is written when the reviewer gave no reason', () => {
		expect(ariJustificationFields(real).deflation).toBeNull();
	});

	test("carries the reviewer's write-up, the checklist and the credit", () => {
		const { additional } = ariJustificationFields(real);
		expect(additional).toContain(note);
		expect(additional).toContain('- The demo works: yes');
		expect(additional).toContain('- The README has screenshots: no');
		expect(additional?.endsWith('Reviewed on Ari by @reviewer')).toBe(true);
	});

	test('the write-up is not repeated when it is all there is', () => {
		const fields = ariJustificationFields({ ...real, parts: {} });
		expect(fields.technicalFeatures).toBe(note);
		expect(fields.additional).not.toContain(note);
	});

	test("the deflation is the reviewer's reason, and nothing of Phantom's", () => {
		const fields = ariJustificationFields({
			...base,
			newWork: 10 * 3600,
			parts: { deflation_reason: 'A synthetic reason' }
		});
		expect(fields.deflation).toBe('A synthetic reason');
	});

	test('time from journals, timelapses or the program is the alternate tracking method', () => {
		const fields = ariJustificationFields({
			...base,
			parts: {},
			breakdown: { hackatime: 120, journals: 0, lapse: 60, program: 30 }
		});
		expect(fields.alternateTracking).toBe(
			'Ari also counted 1h 0m from Lapse timelapses, 0h 30m from time the program vouched for.'
		);
	});

	test('an update goes to the duplicate field, and an unknown prompt is kept', () => {
		const fields = ariJustificationFields({
			...base,
			priorApprovals: [3600 * 5],
			changelog: 'Added a tide graph',
			parts: { unknown_new_prompt: 'kept anyway' }
		});
		expect(fields.duplicate).toContain('Previously, 5h 0m were approved.');
		expect(fields.duplicate).toContain('"Added a tide graph"');
		expect(fields.additional).toContain('unknown new prompt: kept anyway');
	});

	test("falls back to Phantom's Hackatime id when Ari sends none", () => {
		const fields = ariJustificationFields({ ...base, parts: {}, hackatimeAccountId: '67890' });
		expect(fields.hackatimeId).toBe('67890');
	});
});

describe('ariJustification', () => {
	test("reads like the base's own formula", () => {
		const text = ariJustification({
			awardedSeconds: 3600,
			ariSeconds: 3600,
			newWork: 3600,
			priorApprovals: [],
			changelog: null,
			updateDeclaration: null,
			parts: {
				hackatime_user_id: '1',
				hackatime_projects: 'p 1/1/2026-1/2/2026',
				technical_features: 'A thing'
			},
			auditNote: 'Tested it.',
			credit: 'Reviewed on Ari by @x'
		});
		expect(text).toBe(
			'Project is approved for 1h 0m.\n\n[HACKATIME]\nHackatime ID: 1\nHackatime Projects: p 1/1/2026-1/2/2026' +
				'\n\n[SPECIFIC TECHNICAL FEATURES]\nA thing\n\n[ADDITIONAL JUSTIFICATION]\nTested it.\n\nReviewed on Ari by @x'
		);
	});

	test('keeps [UPDATE] as a section, which the old override path still splits out', () => {
		const text = ariJustification({
			awardedSeconds: 3600,
			ariSeconds: 3600,
			newWork: 3600,
			priorApprovals: [7200],
			changelog: 'More',
			updateDeclaration: null,
			parts: {},
			credit: 'Reviewed on Ari by @x'
		});
		expect(takeSection(text, 'UPDATE').body).toContain('Previously, 2h 0m were approved.');
	});
});
