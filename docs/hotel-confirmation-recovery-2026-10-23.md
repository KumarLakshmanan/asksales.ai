# Hotel confirmation transaction and recovery — verified handoff

## Base, ownership and integration order

Reviewed v8 base: `be7ae25ed498b07bd23d981ae039429de727a4ef`. The original inventory commit `7949ee24edf8df2c0e5cf6f2ea3b14aa0ea4bb7f` is its ancestor and remains preserved. The prepared investigation/orchestration branch `audit/hotel-confirmation-recovery-20261023` is also preserved; the seven Hotel source/test paths were compared byte-for-byte when constructing the publication branch.

Analytics commits `788810d0f1ea2cdb823d426a930b64203305e6ff` and `e08db4c4e4a006a58aad1cd29eddf5863dd36cf6` are already ancestors of this v8 base. Its SalesEvidence.ts exactly matches the verified owner correction. They were reused, without duplicate cherry-picks or independent shared edits.

Followups' exact two-file helper commit `b75f8142a20daeda543452237b2b1cf2c7291ff2` is carried by local publication commit `265f5fdc0d56e5890073c3cebf092b9fedfdc77e`. Hotel's coherent transaction/orchestration source and regressions follow it in `72a62b56d137c962d035cbc69d0074c386d17e86`. Thus the actual ledger and reminder helper contracts precede Hotel activation in publication history. Hotel did not reset prepared orchestration or recreate either helper fix.

Actual helper interfaces:

```ts
export type PaymentEvidenceExecutor = Pick<typeof db, 'execute'>;
recordPaymentEvidence(evidence: PaymentEvidence, tx?: PaymentEvidenceExecutor): Promise<void>;

scheduleBookingReminders(userId: number, booking: {
  id: number; checkIn: string; checkOut: string; guestName?: string | null;
  timezone?: string; checkInTime?: string; checkOutTime?: string;
}, contactId: number | null): Promise<void>;
```

The supplied ledger executor owns all validation and writes, with no nested transaction or commit. Scheduling errors log and reject; partial writes and lost acknowledgements can safely replay through the existing scoped booking/reminder-kind uniqueness. Scheduling does not imply notification delivery.

## HT05b: atomic booking confirmation and receipt evidence

Before: a trigger rejecting payment_captured produced HTTP 500 after the booking had committed as confirmed. CRM effects could already have run.

After: Hotel calls `recordPaymentEvidence(evidence, tx)` inside the row-locked `confirmTransaction`, after validating and updating the booking but before commit. The controller's separate post-confirmation capture write is removed. Confirmed receipt replay also validates and records evidence under that transaction. CRM/recovery work starts only after successful commit.

Actual combined HTTP/PostgreSQL results:

- Manual receipt INSERT rejection returns 500 and leaves the new booking pending, no confirmation effects. After removing the trigger, retry and replay succeed with one capture and one workflow.
- Signed webhook INSERT rejection leaves pending status, null payment_id and null completion marker. Valid provider retry/replay then confirms once.
- Concurrent confirmations reusing one receipt identity leave exactly one booking confirmed and the other pending, with one capture and one workflow.
- Wrong amount/currency or replacement payment identity reject before confirmation. Supplied evidence must include identity, source and occurrence time: a retained incomplete-source regression previously resolved confirmed; it now rejects and rolls back without ledger or CRM work.

The optional no-receipt/manual/no-payment policy is preserved separately. This change does not claim received ledger revenue for bookings without receipt evidence.

## HT07: durable confirmation replay without blind duplicate alerts

Before: completion was marked before CRM/reminder work, and only newly confirmed bookings invoked it. A failed reminder step ran once across two confirmations. The real scheduling helper also swallowed persistence errors; Followups' actual supplied commit corrects that contract.

Hotel now invokes recovery on confirmed replay and persists `metadata.hotelConfirmationRecovery`:

- A database-clock lease with token and ten-minute expiry serializes claims without holding a pooled transaction across shared/external calls.
- contactReady/contactId and remindersReady retain successfully persisted steps. Rejection leaves completion unset and releases the claim for replay.
- alertDispatch is marked started BEFORE invoking the alert helper. A returned helper is recorded as returned, not proven provider delivery. Exceptions, expired started claims and legacy unknown alert outcomes become uncertain and are never blindly dispatched again.
- Completion is marked only after successful local steps and returned alert dispatch. Legacy completion markers can recover idempotent CRM/reminder work while retaining unknown alert outcome for reconciliation.
- Cancellation during an awaited scheduling helper cancels its late pending reminders after it returns; stock is restored once.

Seven tests use the REAL supplied ReminderService and real scoped PostgreSQL: partial checkout insertion failure/replay while preserving an existing uncertain receipt; concurrent confirmations; lost alert acknowledgement; legacy recovery; cancellation during scheduling; expired lease takeover; and lost reminder acknowledgement after both rows persist. Scheduling replay preserves both rows and dispatches the alert at most once.

Actual CRM materialization with lead data and real alert/customer delivery remain unrun; their provider/internal contracts are not certified by these tests.

## Additional ledger failures: reproduced before, owner-corrected, verified through Hotel

With helper 788810d0, these two active Hotel HTTP tests failed:

1. `accounts exactly for signed 30-minor capture and 10 plus 20-minor refunds over HTTP`: the last 20-minor refund returned 500 instead of 200 because JavaScript decimal addition rejected the exact remaining amount.
2. `rejects altered signed receipt identities on replay without changing ledger totals`: the same refund ID replayed with 1000 then 2000 minor returned 200.

Analytics' actual e08db4c4 correction supplies NUMERIC refund arithmetic, exact immutable replay checks, explicit business scoping and caller-transaction preservation. Both Hotel HTTP cases now pass, as do signed capture rollback/retry and concurrent receipt identity tests. No duplicate Hotel implementation of those shared checks was added.

A further Hotel regression reproduced delayed original capture replay resetting a fully refunded cancelled booking to refund_pending. The late-payment update now preserves refunded state and cannot replace an already attached different payment identity. That delayed capture returns 409 while retaining the verified refund.

Stale hold expiry, live price floors, amount/currency/payment identity guards, refund-status reconciliation and deterministic/legacy local mock receipt replay are included and exercised. No migration was needed; Hotel's reserved 410–419 remain unused.

## Final verification on reviewed base be7ae25e

**229 passed across 18 suites, zero failed or skipped.** This includes the original HT05b/HT07 diagnostics as permanent active regressions, both real owner helper PostgreSQL suites, actual Hotel HTTP/RLS/Redis tests, seven actual reminder recovery tests, four transaction-contract tests and rendered browser journeys. Historical 197-pass/2-fail publication-gate evidence is retained; the two failures are corrected, not excluded.

The selected suites contain genuine integration tests and mocked unit/contract tests; 229 is not an end-to-end production count. External providers, storage/RAG/KB, alerts and authentication/app-shell identity are mocked or disabled. The recovery suite uses actual reminder persistence; the lifecycle suite also isolates its reminder collaborator to test caller behavior.

Browser checks use 1440x900, 768x900 and 390x900, deviceScaleFactor=1 and visualViewport.scale=1: persisted rate/held-stock edits; guest details, confirmation, cancellation, reload and stale approval. No document overflow or page exceptions. The UI reaches real scoped controllers/PostgreSQL through the fixture; full real authentication/session/member middleware is unrun.

API and worker esbuild bundles, client typecheck, scoped server typecheck and diff whitespace checks pass. Full server typecheck retains only unchanged settings.test.ts TS2322:201 and TS2352:222 baseline errors. Changed-file lint has zero errors and inherited warnings. PostgreSQL/Redis and all users/keys are disposable synthetic fixtures; no saved DSN/customer database or live provider credential was used.

## Scope, remaining decisions and publication limits

Relative to reviewed v8, the outgoing scope is Hotel bookingPaymentController, BookingService, PaymentProvider and their three new/one adjusted tests; this report; plus Followups' ReminderService rejection helper and its actual persistence tests. SalesEvidence and its owner tests are inherited from v8, not outgoing changes. File/commit hashes and final independently verified remote SHA are recorded in the external handoff manifest.

Remaining product/source limits: no-receipt or complimentary-booking semantics; booked-value versus received-revenue labels; late/mismatched capture reconciliation policy; spreadsheet date/capacity interpretation; static negotiation fallback and unused hotel_follow_ups lifecycle. Actual provider settlement, object storage, production workers and real sends are unrun. Uncertain alert outcomes deliberately require reconciliation rather than automatic resend. This is not an all-features or live-payment certification.

Only a normal fast-forward append to handoff/audit-20261023-hotel is authorized. No direct v8 write, force push, deployment, real charge/refund/send, credential/security change or Page write is performed. Known workflow push branches are main only; forbidden hook reads were not attempted and external hooks remain unknown. Prepared work and original before/after evidence remain preserved.
