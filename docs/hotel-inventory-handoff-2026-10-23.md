# Hotel inventory handoff — 2026-10-23

Publication base: `c33cab7fece727585abaaaaa8512208413c34c7f` from a fresh `git fetch origin v8`. Original audit base `35d6107b50aaabf238a2fc1fa39ff172bdf6b8f7` is its direct ancestor. Original complete local audit remains on `audit/hotel-lifecycle-20261023` at `c6a7f1fd7fc2c391bcafe7721316be8457fb7164`.

This branch contains only independently verified inventory/import/rate fixes. It does not contain the original booking confirmation, payment validation, refund-status, or mock-receipt changes. The parent required those affected patches to remain withheld until the ledger atomicity and confirmation-recovery diagnostics pass coherently. Neither unresolved diagnostic is counted as passing here.

## 1. Independently published findings

| ID | Priority and failing-before reproduction | Passing-after behavior | Original audit source |
|---|---|---|---|
| HT02 | P1 reproduced: expire the deadline of an unreleased one-room hold; administrative total=2 incorrectly exposes two free rooms. | Every pending reservation remains counted until its inventory release commits; free stock is one, and subsequent expiry/replacement bookings stay within capacity. | `12aeb65d98a89bef6dadcd4677b8a4baf6baf7fb` |
| HT03 | P1 reproduced: concurrent booking hold and administrative inventory recalculation leave reserved stock free. | Room and nightly inventory locks are acquired before a fresh occupancy statement, serializing with holds and releases. | `12aeb65d98a89bef6dadcd4677b8a4baf6baf7fb` |
| HT04 | P1 reproduced: reimport an XLSX row advertising one free room while that room is held; old import overwrites the reservation. | Imported free stock is capped by total minus committed reservations; below-reservation totals reject the entire workbook and roll back earlier rows. Numeric input validated; derived RAG cleanup occurs after commit. | `c75198e372d34f44887c618959cc886068d4721a` |
| HT09 | P1 reproduced: concurrent partial updates base=90 and min=95 from base=100/min=80 both return 200, leaving min>base. | One row-locked read/validate/write transaction yields one 200 and one 400, preserving min≤base. | `351d5f63d1c2e173b02665d19a1e7464d996e42a` |

These guarantees concern committed reservation counts, import rollback and valid rate configuration. They do not require a successful payment ledger write or a CRM notification attempt. The independently selected integration suite runs against the unchanged v8 BookingService, webhook controller and shared helpers, demonstrating that dependency boundary.

## 2. Exact outgoing file scope

- `server/controllers/hotelAdminController.ts`: only updateRoomType transaction/validation and setAvailability locks/occupancy. Coverage's existing MC02 payment-settings guard is retained unchanged.
- `server/controllers/hotelImportController.ts`: atomic workbook import and reservation preservation.
- `server/tests/hotelImport.test.ts`: transaction/lock-aware fixture, preserving legacy import coverage.
- `server/tests/hotelInventoryPostgres.test.ts`: independent PostgreSQL/RLS/Redis/browser regressions.
- `docs/hotel-inventory-handoff-2026-10-23.md`: this handoff and its limits.

No outgoing changes to BookingService, bookingPaymentController, PaymentProvider, SalesEvidence, ReminderService, CRM services, migration files, manifests/lockfiles, credentials/settings, workflow files or deployment files. No migration added; 410–419 unused.

## 3. Verification of selected publish bytes

Fresh disposable PostgreSQL 16/pgvector on 127.0.0.1:5544, database hotel_audit, and Redis on 127.0.0.1:6399, without saved volumes. Real custom migrations through 329: 318 migration filenames applied, due to historical repeated numbering. No saved environment DSNs or customer data used.

Five suites: **77 tests passed, zero skipped**, including **11 independent integration tests**. Existing Coverage tests hotelPaymentAuthority/settingsModuleAccess are reused rather than recreated. PostgreSQL business scoped role/RLS, actual application SQL, HTTP controllers, simultaneous holds/releases, expired hold recalculation, rate races, whole-import rollback and Redis/BullMQ retry were exercised. External fetch rejects; storage/RAG/reminder/alert/KB collaborators are mocked. Synthetic HMAC/provider settings in fixtures are not live credentials.

Browser: actual Next.js rooms and availability pages, real scoped controllers/database, 1440×900, 768×900 and 390×900, deviceScaleFactor=1 and visualViewport.scale=1. Edit a nightly base rate, reload and verify persistence; change total stock while one room is held, verify remaining stock equals one, reload; no document horizontal overflow or page exceptions. Authentication/app-shell identity is mocked. Real authentication/session/member middleware, paid providers, notification delivery, object storage, production cron and AI/KB calls are unrun.

Reproduction from server, with the disposable migrated services and isolated Next server on 3104 available:

```sh
env -i PATH="$PATH" NODE_ENV=test HOTEL_LOCAL_QA=1 HOTEL_INVENTORY_BROWSER_QA=1 DB_HOST=127.0.0.1 DB_PORT=5544 DB_NAME=hotel_audit NODE_OPTIONS=--experimental-vm-modules node node_modules/jest/bin/jest.js --runInBand tests/hotelInventoryPostgres.test.ts tests/hotelAdmin.test.ts tests/hotelImport.test.ts tests/hotelPaymentAuthority.test.ts tests/settingsModuleAccess.test.ts
```

API/worker esbuild bundles pass; changed-file lint has no errors (one pre-existing unused-disable warning); diff whitespace checks pass. Scoped server typecheck excludes only unchanged tests/settings.test.ts, whose known baseline errors are TS2322:201 and TS2352:222. Full server typecheck and real provider/delivery behavior are not claimed passing. Client source is unchanged; its earlier full typecheck passed on the preserved audit branch.

## 4. Withheld original work and retained failing diagnostics

HT01 stale confirmation/expiry, HT05a payment amount/currency/identity preconditions, HT06a refund-status reconciliation, and mock payment replay compatibility remain on the original audit branch. HT05b and HT07 remain reproduced and unresolved, with exact retained code at original tip `c6a7f1fd7fc2c391bcafe7721316be8457fb7164`:

- `server/tests/hotelLifecyclePostgres.test.ts:456`: HT05b rejects a receipt persistence failure without committing confirmation. A synthetic PostgreSQL trigger rejects payment_captured; a valid INR 200 receipt returns 500 but booking is already confirmed (failing expected pending at line 465).
- `server/tests/hotelLifecyclePostgres.test.ts:472`: HT07 retries a failed CRM confirmation effect on replay. Reminder collaborator rejects once; two confirmations attempt it only once (failing expected two calls at line 477).

Enable on that branch using `HOTEL_KNOWN_GAPS=1` and `-t 'HT05b|HT07'`. The original explicit diagnostic run had two failures. These tests are not present in this independent subset; their omission is a publication boundary, not evidence of resolution.

Hotel owns transaction/orchestration and confirmation replay. Parent coordinates these helper contracts; shared implementations were not edited:

```ts
// Current ledger interface; Analytics owns helper internals.
recordPaymentEvidence(evidence: PaymentEvidence): Promise<void>;
// Requested compatible extension: all ledger work must use tx if supplied,
// with no nested transaction/commit. Also reject cross-booking source-key races.
recordPaymentEvidence(evidence: PaymentEvidence, tx?: {
  execute(query: unknown): Promise<{ rows: unknown[] }>;
}): Promise<void>;

// Followups owns this helper's failure/delivery contract. It currently catches
// persistence errors and resolves; Hotel needs rejection to orchestrate replay.
scheduleBookingReminders(userId: number, booking: {
  id: number; checkIn: string; checkOut: string; guestName?: string | null;
  timezone?: string; checkInTime?: string; checkOutTime?: string;
}, contactId: number | null): Promise<void>;
```

Required next steps: Hotel confirms and records capture/receipt on one database transaction, runs CRM only after commit, and durably retries unfinished idempotent confirmation steps on replay. Analytics must provide the transaction-aware ledger helper; Followups must provide truthful scheduling rejection with existing reminder uniqueness protection. External alert delivery uncertainty must not cause blind duplicate sends.

## 5. Publication restrictions

Only `handoff/audit-20261023-hotel` is authorized for the normal push. No direct v8 writing, force push, deployment, real sends/payments/refunds, provider credentials or security setting changes. The two GitHub workflow files at current v8 have push branches [main]; no known handoff deployment trigger was found there. Forbidden hook reads were not attempted. External hooks remain unknown, as stated by the parent. Verify remote ref independently after push; do not infer success from local commit or tracking state.
