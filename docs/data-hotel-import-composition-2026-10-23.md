# Data / Hotel rate import composition — 2026-10-23

The rate-report controller now combines strict workbook/property/room validation
with reservation-aware inventory updates. A successful import cannot reopen held
stock, and a later conflicting row rolls back the entire report.

## Exact source and ancestry

- Repository: `https://github.com/<private-source-repository>.git`.
- Correction parent: latest remote v8 fetched at the start of this task,
  `46dbf82434cf9f8e8a2822aa6f56148e5e8b1a69`.
- Original Data handoff remains unchanged:
  `d84dbe95f4c7a20ef8759bf5b4b285973e55c721`, whose parent is
  `35d6107b50aaabf238a2fc1fa39ff172bdf6b8f7`.
- Verified Hotel inventory source:
  `7949ee24edf8df2c0e5cf6f2ea3b14aa0ea4bb7f`, direct child of
  `c33cab7fece727585abaaaaa8512208413c34c7f`.
- The fetched `handoff/audit-20261023-hotel` ref had advanced to financial tip
  `9894d7fa2679abd4d39d34d6b5e957bd7ed7c6e3`. Both that tip and the v8 parent
  contain inventory commit `7949ee24...`. The import-controller blob at all three
  points is exactly `cfec2dfcf72a4cde011ab8042659dd7cf865854e`.
- This correction is a direct child of the explicit v8 parent. It does not merge
  another owner's drafts or change either original handoff ref. The historical
  `c75198e...` reference was not needed or fetched independently.

## Scoped changed files

1. `server/controllers/hotelImportController.ts`
2. `server/utils/hotelRateImport.ts` (restored strict parser from reviewed Data
   handoff, retaining Hotel's 100,000-room report bound)
3. `server/tests/hotelImport.test.ts`
4. `server/tests/hotelInventoryPostgres.test.ts`
5. This report.
6. `.gitignore`: a single-file allowlist entry for this report, following the
   repository's existing documentation convention.

No migration, booking service, authorization middleware, financial workflow,
saved environment configuration or deployment configuration is changed.

## Composed contract

- Parse and validate every nonblank report row before opening the transaction.
  Require one of each header, a supported real calendar day, a bounded room name,
  a finite nonnegative rate, valid whole room counts and unique room/day rows.
  Missing headers/data, malformed workbooks and invalid later rows return 400.
  Preserve Excel 1900/1904 date-system support and reject the fictional 1900 leap
  day. Imports are limited to 10,000 rows and 100,000 total rooms per row.
- Validate `hotelId`. Select only a property owned by the authenticated business
  owner and visible under the selected profile's existing forced RLS. Require
  an explicit selector for ambiguous properties; return 404 for an unavailable
  selected property and 409 for historical duplicate room identities.
- Acquire `pg_advisory_xact_lock(userId, 132)`, matching property setup, before
  selecting or creating a property. Preserve room locks before nightly locks.
  Do not take a property-row lock before room locks: the original Data-only
  controller deadlocked against booking creation's `FOR UPDATE OF rt, hp` in
  the controlled regression. Property setup and imports serialize on their
  shared advisory lock; existing owner/profile predicates and RLS remain active.
- Lock the night's stock, then read occupancy in a separate SQL statement after
  any lock wait. Count confirmed bookings and pending-payment bookings with
  `inventory_reserved_at IS NOT NULL` and `inventory_released_at IS NULL`.
  Expired but unreleased holds still consume stock until release commits.
- Reject `total < reserved` with 409; otherwise save
  `free = min(workbook availability, total - reserved)`. A later reservation
  conflict rolls back earlier rate/count changes and newly created rows.
- Run derived-index cleanup only after commit. Validation/transaction failures
  must never claim partial success or run that cleanup.

## Reproduced failures before composition

These are acceptance tests expecting correct behavior, not observer assertions
that bless a defect.

| Source tested | Evidence | Result |
| --- | --- | --- |
| Exact v8 parent, Hotel import | Invalid later calendar date, missing date, missing room, duplicate room/day, malformed workbook, ambiguous property, another profile's selected property, duplicate room name | Eight tests expected 400/404/409 and received 200. |
| Exact v8 parent, Hotel import | Existing held-room reimport and later below-reserved conflict | Passed; retained by composition. |
| Exact reviewed Data-only controller/parser | Hold only room, then import availability 1 / total 1 | Expected free 0; actually free 1. |
| Exact reviewed Data-only controller/parser | Earlier rate/count update followed by later total 0 against a held room | Expected 409 and whole-report rollback; actually 200. |
| Exact reviewed Data-only controller/parser | Expired-unreleased pending hold; legacy confirmed booking without hold marker | Both incorrectly reopened free stock to 1. |
| Exact reviewed Data-only controller/parser | Hold owner advisory lock `(userId,132)` while importing | Import did not wait and changed the rate. |
| Exact reviewed Data-only controller/parser | Queue real booking and import behind a room lock, observe both server-side lock waits, release blocker | Import returned 500. Disposable PostgreSQL recorded an actual deadlock involving room lookup and booking's `FOR UPDATE OF rt, hp`. |

The first v8 run reported six passes and nine failures. Eight failures were the
application regressions above. The ninth was a test instrumentation mistake:
the release probe watched its UPDATE instead of the preceding blocking SELECT.
After correcting only that probe, the release regression passed against v8.
The reviewed Data-only comparison then reported one pass and six failures.
The final composed run uses the corrected probe.

## Final verification and coverage

All application execution used a newly created disposable PostgreSQL 16
container bound to `127.0.0.1:5544`, database `hotel_audit`, with the actual v8
migrations. No production records or credentials were used. Saved dotenv reads
were neutralized, the process environment was cleared, and an audit preload
blocked external networking. Provider/RAG/reminder/alert dependencies were
mocked; no email, message, PMS, payment, paid model or third-party operation ran.
The actual controller, multipart HTTP requests, booking service, SQL transactions,
forced profile RLS and PostgreSQL lock waits were exercised. Direct booking-state
fixture edits set a hold expiry in the past or represented a legacy confirmed
reservation; booking creation and release used the actual service.

| Check | Status / evidence |
| --- | --- |
| Final focused Jest run | **Passed: 64 tests**, two suites, one worker. 46 workbook/controller cases plus 18 real PostgreSQL cases. Six unrelated Hotel cases excluded by the explicit test-name filter. |
| Strict validation/property/duplicate preflights | **Passed**, including no partial rows persisted after a later invalid row. |
| Existing Hotel HT03/HT04 regressions | **Passed**: competing holds/admin recalculation, held-stock reimport, later conflict returns 409 and earlier rates/counts remain unchanged. |
| Shared advisory lock, import/hold race, concurrent release | **Passed**, requiring observed server-side lock waits rather than relying on elapsed time alone. |
| Confirmed and expired-unreleased occupancy | **Passed**, including denial of a competing hold until stock is actually released. |
| Migration 331 integration compatibility | **Passed: one additional focused test** after applying the exact reviewed Data migration to the disposable database. The exact unique constraint rejects duplicate insertion. Without that index, the main final run exercises the controller's legacy-ambiguity 409 path. |
| Changed-file ESLint | **Passed**, zero errors/warnings. Initial 2 GB lint attempt exhausted its own heap; sequential 4 GB run passed. |
| API and worker esbuild bundles | **Passed**, output outside the checkout. |
| Full server typecheck | **Baseline failure**: only `tests/settings.test.ts:201` TS2322 and `:222` TS2352. That file is identical to the v8 parent and these two fixture errors were already recorded in the original Data audit. |
| Browser, Redis expiry jobs and financial/provider tests | **Unrun here**, outside this focused composition correction. No broad audit or suite restart. |
| Repository `vscode_askQuestions` signoff | **Unavailable**: no such tool is exposed. Technical verification is recorded above; no affirmative helper/user signoff is fabricated. |

The initial migration invocation stopped at migration 199 because the cleared
environment had no encryption test seed. It was resumed using a nonsecret
synthetic-only seed in the disposable container; no real key was read or created.
Two initial Jest invocations failed before executing tests because of an
incorrect config path / working directory. The final commands use the server
working directory and its existing `jest.config.cjs`. The installed pnpm wrapper
attempted dependency maintenance and stopped before any check; verification used
the existing installed Node binaries directly and did not reinstall dependencies.

### Reproduction

Create a **new disposable** `hotel_audit` PostgreSQL database at the guarded
loopback endpoint. Apply the checked-in migrations with the custom runner while
explicitly pinning every database variable to that database, neutralizing saved
dotenv reads, using only a synthetic test seed and blocking external networking.
Do not point the fixture at an existing database merely because its name matches.
From `server`, using those same environment/network restrictions:

```sh
HOTEL_LOCAL_QA=1 DB_HOST=127.0.0.1 DB_PORT=5544 DB_NAME=hotel_audit \
NODE_OPTIONS='--experimental-vm-modules' node node_modules/jest/bin/jest.js \
  --runInBand --runTestsByPath tests/hotelImport.test.ts tests/hotelInventoryPostgres.test.ts \
  --testNamePattern='importRateReport|strict calendar and workbook validation|composed import|preserves committed reservations on rate report reimport|rolls back the whole import when a later row would reduce stock below held rooms|serializes competing holds and releases one reservation exactly once|keeps unreleased expired holds counted until release|does not overwrite a concurrent inventory hold'
```

Local execution records are retained at `/workspace/data-hotel-compose/evidence/`:
`v8-before.json`, `v8-release-before.json`, `data-before.json`,
`composed-final.json`, `identity-331-compat.json`, disposable PostgreSQL deadlock
logs, migration logs, typecheck/lint logs and build logs. The temporary harness
is `/workspace/data-hotel-compose/run-tests.sh`.

## Integration boundaries and remaining gates

- Publish this exact correction to the unique Data/Hotel composition handoff;
  the integration owner alone writes v8. The correction is intended to replace
  either single-contract resolution of the shared controller.
- No new migration is introduced. Keep reviewed migration 132's booking/stock
  lifecycle columns and constraints. Original Data migration
  `331_hotel_room_import_identity.js` remains the reviewed database guard against
  duplicate hotel/name identities through other writers; its safe historical
  duplicate preflight must not be replaced with automatic merges or deletions.
- Original Data/Hotel audit findings outside this composition, including DI07's
  incomplete privacy inventory policy, remain unchanged. Cross-owner integration
  still requires its normal checks; these tests do not establish complete assurance.
- Checked-in workflows at this parent trigger pushes only for `main` and contain
  no deployment steps. External hook settings remain unknown; previously denied
  metadata reads are not retried. No deployments, live settings changes, v8 writes,
  forced ref operations or production mutations are authorized by this correction.
