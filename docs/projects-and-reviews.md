# Projects and reviews

Phantom ships; Ari, Hack Club's review platform, reviews; Phantom applies what
Ari decided.

```
ship → submission (pending) → outbox `ari.ingest` → POST /api/ingest/{program} → ari_ships
Ari → POST /api/ari/webhook → verify + dedupe (ari_deliveries) → projects/decisions.ts
```

- **Sending** (`lib/server/ari.ts`, `sendShip`). `external_id` is the project's
  id, so each Phantom project is one Ari project and its ships are versions.
  The ship is built from the frozen submission. `meta` carries what only
  Phantom knows: the new-work cap, earlier approvals and the participant's
  declarations. Before any send, Ari's status endpoint is asked for the
  project's latest ship, so a send whose answer was lost is adopted, not
  repeated.
- **Receiving** (`routes/api/ari/webhook`, `projects/decisions.ts`). Each
  delivery is verified over `timestamp.delivery_id.body`
  (`lib/server/ari-signature.ts`) and recorded in the same transaction as what
  it did, so a retry is applied at most once. Anything wrong on Phantom's side
  answers 503 so Ari retries.

  | Event             | Phantom                                                                                                                              |
  | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
  | `review.approved` | Minted once Ari's status says the ship is decided and approved. The grant is Ari's approved minutes, exactly: ledger, DMs, Airtable. |
  | `review.changes`  | `changes_requested`. "Changes are done" re-sends the same submission.                                                                |
  | `review.rejected` | `rejected`.                                                                                                                          |
  | `review.requeued` | Back to `pending`; an approval's hours come off the balance and can be shipped again.                                                |
  | `review.reverted` | `reverted`; the same, but the ship stays closed.                                                                                     |
  | `ship.updated`    | Reviewer corrections onto the submission; a Hackatime change re-counts the claim (`ari.recount`).                                    |

- **Update ships** count each linked Hackatime project only from the moment of
  the last ship (`projects/window.ts`).
- **Jobs.** `ari.backfill` sends ships that were waiting before the switch to
  Ari. `ari.reconcile` applies held approvals and reports ships Ari and Phantom
  disagree on.
- **Config.** `ARI_PROGRAM`, `ARI_INGEST_SECRET` and `ARI_WEBHOOK_SECRET`; the
  webhook destination in Ari is `https://<site>/api/ari/webhook`.
