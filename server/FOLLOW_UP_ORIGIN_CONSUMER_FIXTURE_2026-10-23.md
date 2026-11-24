# Followups producer acceptance against the current SMS consumer

2026-10-23 UTC. This is a test-only follow-up to the already published producer corrections. Product source is unchanged. Branch `codex/followup-origin-current-consumer`; exact parent/base `babc42072ba499dab9cf504d69e2270acc0979d4`. Publication SHA/ref are recorded in the handoff response. Remote v8 independently read at18:12:26 UTC as `356fd2849883ae268b07f1b554975bff7b51ac48`; no independent merge or v8 write occurred.

## Dependency and validation composition

Campaign's exact consumer is `f2083f8b44b0e7b946e4020b0fbdeb515e551aa1`, with fixture correction tip `cb9c68f3ffbdcc9a2255f256c2c6deab06e7f852`. Its report `qa/campaign-sms-2026-10-23/REMEDIATION.md` was fetched/read. The validation worktree starts at that exact tip. These existing files were copied byte-for-byte from published Followups `babc42072ba499dab9cf504d69e2270acc0979d4`, then the candidate origin fixture was added:

- server/controllers/settingsController.ts
- server/services/cronService.ts
- server/services/outreach/ConfiguredFollowUpDispatchService.ts
- server/migrations/360_configured_follow_up_dispatches.js
- shared/followUpSettings.ts
- server/tests/settings.test.ts
- server/tests/configuredFollowUpDispatchPostgres.test.ts
- server/tests/emailQueueLifecyclePostgres.test.ts
- server/tests/helpers/followUpLocalOnly.cjs

Every overlay was compared with `git show babc4207:<path>` and hashed in the local COMPOSITION.json. No Campaign worker, adapter, ledger, Tenant helper or other owner's implementation was changed or included in this handoff delta. The test requires both owner changes; it does not claim compatibility with the pre-ledger consumer. Parent should apply only this test/report delta after those dependencies, then accept the actual integration tree. History projection f781ded7 and CRM fixture a8e29788 are separate sibling deltas, not hidden ancestry/dependencies of this test.

## Reproduction and correction

Against that consumer plus actual Followups producer, the unchanged original12-case fixture produced **3 failed, 9 passed**. Delivery cases reached `sms_queue_deliveries` without that table. Its old reserveOutreachCredit mock and sendSMS replacement also predated the transaction-enlisted credit API and optional sixth `{beforeProvider}` callback. Those failures are a fixture compatibility problem, not new product failures.

The fixture now:

1. Uses a persistent random local PostgreSQL schema, model-derived leads/sent_messages shapes and actual migration351. Actual299 ownership guard and304 membership function are installed with schema-local lookup; migration351 up executes twice. No new migration is introduced. The fixture retains current physical owner/business IDs and uses only a synthetic local runtime role.
2. Calls actual async configuredFollowUpDispatch, reservation and recovery, actual QueueRegistry/capture, real Redis/BullMQ and the production-registered SMS processor. The real SMS adapter executes its preparation and final callback; only synthetic credential/decryption boundaries and external fetch are replaced. Fetch asserts the durable token-fenced ledger has already reached started with reservation reference/ID, so omitting the callback cannot pass as delivery success.
3. Mocks wallet pricing/arithmetic, while executing createResource and its deduction reference in the SAME actual Drizzle transaction. Scoped refund evidence is persisted in a fixture table. Actual SmsQueueDeliveryService projects its existing sent_messages history and contact counter; no replacement activity store or writer mock remains.
4. Retains all original12 authority/subscription/lost-ack cases, including every missing identity field, revoked originating staff before recovery and after enqueue, changed payer, ambient unrelated payer and subscription denial. No authority expectations were relaxed.
5. Adds active staff17 acceptance under original payer901 and a channel-disable during credential preparation control. The latter produces zero fetch effects, stopped ledger and one correctly scoped unused-reservation refund.
6. Strengthens lost-outbox-ack acceptance: one fetch effect, one deduction reference, one reply-history row, one contact-count increment and no refund. The unchanged frozen payload remains in the same durable envelope/job. This is a queue/outbox deduplication test; it is not a new provider-crash exactly-once claim.

The migration guard initially exposed two fixture omissions: model-column generation omitted is_reply=false, then the synthetic account identifier did not match its sender ID. The actual reserve/readiness checks correctly rejected these fixtures. Both were corrected without product changes. These intermediate logs remain preserved.

## Verification

All test workers run serially. Clear inherited environment and preload `server/tests/helpers/followUpLocalOnly.cjs`, which blocks saved env reads and outbound TCP except high-port loopback. Use only disposable `followup_qa` on127.0.0.1:32770 and credential-free Redis on127.0.0.1:32769.

```sh
cd server
env -i PATH="$PATH" NODE_ENV=test \
 FOLLOW_UP_IMPLEMENTATION_DATABASE_URL=postgresql://audit:synthetic_local_only@127.0.0.1:32770/followup_qa \
 FOLLOW_UP_IMPLEMENTATION_REDIS_URL=redis://127.0.0.1:32769 \
 NODE_OPTIONS='--require=<absolute-repo>/server/tests/helpers/followUpLocalOnly.cjs --experimental-vm-modules --max-old-space-size=4096' \
 node node_modules/jest/bin/jest.js --runInBand --runTestsByPath \
 tests/configuredFollowUpOriginPostgres.test.ts tests/configuredFollowUpDispatchPostgres.test.ts
```

Executed results, without double-counting repeated development runs:

- Origin fixture final source: **14/14 passed**, actual registered worker/adapter/PG/Redis. All five missing-identity cases remain review_required without effects/credits, current staff/payer and subscription SQL gates remain real.
- Existing dispatch fixture: **13 passed, 1 skipped** in its normal run; then the previously omitted Redis opt-in was supplied and that exact remaining case ran: **1 passed, 13 filtered/skipped**. Thus **all14 distinct dispatch cases executed and passed** across those focused invocations; the report does not describe the first invocation as zero-skips.
- Total distinct scoped acceptance: **28 passed** across those two suites. Campaign's27 cases are prior owner evidence, not rerun or counted here.
- Full combined server `tsc --noEmit --incremental false`: **passed**, with6GB heap. Scoped fixture ESLint: **0 errors, 0 warnings**. Whitespace check passed. API and worker esbuild bundles passed.
- The first combined neighboring-suite/typecheck attempt still contained Campaign's synchronous pre-babc fixtures: **9 failed, 17 passed, 1 skipped** across the two suites, plus15 TypeScript diagnostics. Copying the exact already-reviewed babc dispatch/Email fixtures completed the declared composition; the corrected dispatch cases and full typecheck then passed. This is retained setup evidence, not a newly fixed product defect.

Local evidence directory `/workspace/followup-origin-current-evidence`: red-old-fixture.log, green-first/second/third.log, final.log, dispatch-final.log, dispatch-redis-final.log, types.log, types-final.log, lint.log, builds.log and COMPOSITION.json. Parent cannot directly read this separate filesystem; this committed report preserves the substantive evidence and exact composition. Candidate fixture SHA256: `1da4138172ea1738eab10353e671519fd9c0454ca665341abed724b3f4916e50`.

## Scope limits and remaining gates

The origin cases enter at the actual configured producer helper/reservation boundary, with an explicit synthetic current version1 no-template configuration. They do not rerun the full cron selection/approved-template renderer. Campaign's separate27-case supplement covers that path; this report does not borrow its pass count or mock subscription proof. Here real subscription/payer/membership SQL runs, while full credit pricing, external provider behavior, full migration deployment and registered-worker runtime-role RLS are not verified. Actual351 constraints/triggers are installed; the registered fixture connection is the disposable admin connection. Parent must retain Tenant/Campaign integration isolation gates.

The current-v8 combined frontend/browser suite was not rerun for this test-only change. Read-only history UI acceptance is separately published at `f781ded74f1c0998e0eda5d73be64cad6918d7c3`:25 server/browser and38 client cases. It has no replay/reauthorization authority. The previously queued CRM reminder baseline is explained and separately corrected by `a8e2978846e79525b48c3fb4ab8b94ed726dc791`:34 actual-persistence cases, no product changes.

Every second-pass finding remains accounted for in the original correction ledger: SP-F01/settings typing, SP-F02, SP-F03, SP-S02 and narrow D1/D2 consolidation are scoped fixes; SP-S01 producer and read-only review projection are fixed with the described dependencies; D3/D4 preserve existing provenance and legitimate separate products. D5 read-only review visibility is now covered, while operator replay/reauthorization and individual pending-outreach cancel/reschedule remain explicit separate contracts. SP-P01 no-op Save/running-sequence semantics and SP-P02 Hotel DST remain owner/product decision holds. No recovery principal, current-authority rebind or historical replay was invented.

Known unrelated baseline migration340 irreversible marker failure and unknown repository CI outcome remain visible. Required repository vscode_askQuestions verification remains **pending: tool unavailable**. Previously denied metadata reads are not retried. A prior `/proc/13729/cwd` read returned PermissionError; no signal was sent and that unrelated/uncertain process was left untouched. Checked-in push workflows do not match unique handoff refs; external-hook visibility remains uncertain from prior denied reads, not newly assumed safe/known.

No live providers, sends, customer data changes, paid calls, credentials/security-setting changes, deployment, new product migrations or v8 writes. This handoff is a coherent test/report delta, not a claim of deployed or combined-v8 readiness.

## Changed files in this delta

- server/tests/configuredFollowUpOriginPostgres.test.ts
- server/FOLLOW_UP_ORIGIN_CONSUMER_FIXTURE_2026-10-23.md

Final required verification: unavailable vscode_askQuestions remains pending.
