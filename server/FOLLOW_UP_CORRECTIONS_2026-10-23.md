# Followups second-pass corrections — 2026-10-23

Scoped final acceptance passed **144/144 server/browser tests across 12 suites** and **107/107 client tests across 10 suites**. Full server/prescribed-client types and API/worker/clean-frontend builds pass. This is a scoped correction handoff, with explicit remaining decisions and integration gates. The original audits are preserved as separate historical artifacts; publishing a handoff is not acceptance on remote v8, a deployment or a green CI claim.

## Source and environment

- Exact base: `24c66b9cac2936ccbd119e39cf78b5b83b1e6212`, fetched 2026-10-23 16:22:32 UTC. Local branch: `codex/followup-second-pass-fixes` in the original `/workspace/salesmarketing` checkout. Previous audit/remediation branches and reports were preserved; no reset, force operation or independent merge was used.
- Remote identity: `https://github.com/<private-source-repository>.git`. Existing scoped destination: `refs/heads/handoff/audit-20261023-followups`, previously `b75f8142a20daeda543452237b2b1cf2c7291ff2`. The exact published tip and independent remote verification are in the handoff response; integration alone may write v8.
- During validation, v8 advanced to `a73dd61ed8876bd6774440ee2f3b06b4d7e63170`. Its three intervening commits change separate support/analytics files, with no overlap in this handoff's product files. They were fetched/read, not independently merged. Tests here validate base24c66b9 plus the listed corrections, not the combined newer v8 tree.
- Final read-only prepublication fetch at 2026-10-23 17:15:12 UTC observed v8 `e92ea9cca3eca7d025128f037877a91ae0148a60`. Later notification/email integration changes include shared Header and response-wrapper recovery fields. Static diff preserves successful DTO shapes and the Tenant helper contract, but those newer shared sections were not substituted into this checkout or claimed as executed combined acceptance. Integration must rerun the mounted APIs and frontend on its resulting tree. Migration340 is still unchanged at that observed remote.
- Linux x86_64, Node24.19.0, Next16.2.11/webpack, Chromium151, PostgreSQL16.15 (`pgvector/pgvector:pg16`) and Redis7.4.11. Tests use disposable `followup_qa` on loopback32770 and Redis32769, sequential Jest/Vitest workers. Browser viewport1440x900 and390x844 at default zoom/device scale1.
- Only synthetic local data was written. SMS/email/provider and credit effects were mocked. A Node guard blocked saved `.env` reads and outbound TCP except high-port loopback; browser routing blocked external HTTP and WebSockets. No production DB, real sends, payments, paid model requests, deployment, credential/security changes, or Page writes occurred.

## Architecture and ownership

`FollowUpSettings` and the standalone page use the shared wire DTO and the existing structural recovery ledger. Mounted settings API -> settings controller -> atomic revision-fenced settings persistence remains real in PostgreSQL acceptance. Template dialog -> actual API client/content-request key -> mounted content router/controller -> template/version/receipt transaction is tested with a lost HTTP acknowledgement.

Configured cron -> asynchronous `configuredFollowUpDispatch` -> Tenant's existing server authority capture -> channel reservation/outbox -> strict recovery -> QueueRegistry/Redis -> registered SMS worker is exercised against real local identity/subscription SQL. Email and social reservation/preflight boundaries are separately covered. Campaign retains generic EMAIL_SENDING/SMS delivery processor ownership; Tenant retains the authority resolver; Hotel retains booking orchestration. No competing provenance or authority helper was created.

## Per-finding ledger

| Finding | Status and confidence | Correction / acceptance |
| --- | --- | --- |
| SP-F01 P1, disabled-step/ID round trip | Fixed in scoped handoff; high | Shared `shared/followUpSettings.ts` keeps opaque string IDs and legacy positive numeric IDs. GET preserves enabled flags; PUT validates flags and uniqueness and orders enabled steps only. Disabled zero-delay rows remain disabled; disabled unapproved templates are not loaded. Client editor, summary, fingerprint and private-text-free recovery retain the same structure. Five real mounted-API channel cases failed before and pass after; real production UI Save also preserves DB rows and advances its fence. |
| Settings fixture type failures | Fixed; high | Complete typed `OutreachSettings` fixture and `followUpFenceAdvanced` result, with inferred channel/config types. All42 existing runtime tests remain; full server typecheck passes. No widened casts or weakened product types were added to this fixture. |
| SP-S01 P1, originating authority | Producer/recovery fixed; consumer/operator dependencies remain; high at tested boundaries | Producer resolves and persists owner/profile/business actor/billing organization/billing actor before reservation. Recovery uses `captureJobBusiness(payload,{requireOriginatingIdentity:true})`. Missing legacy fields and unavailable original membership/payer stay unsent in durable `review_required` with a stable `reviewReason`; the payload is never replaced by current authority. Twelve actual outbox/Redis/registered-worker cases cover all five missing fields, revoked staff, changed payer, subscription rejection and lost-outbox-ack deduplication. |
| SP-F02 P2, dialog focus | Fixed; high | Library and per-step template openers supply explicit return-focus refs. Escape returns focus to the actual opener. Two DOM tests failed before/pass after; production-browser acceptance covers both openers. Scope changes still remount private forms. |
| SP-F03 P2, stalled history/template create | Fixed; high | Reuses existing15-second `followUpRequest` for fetch and response parsing. History releases Refresh/Try again. Uncertain creates retain exact in-memory body and the existing receipt key across dismissal/reopen/explicit retry; fields cannot turn that uncertainty into a new intent. Ordinary cancelled drafts clear. Late confirmed responses do not rotate the retained retry identity. Actual API-client tests cover stalled fetch/body and late responses; production UI/mounted API/PG lost-ack retry creates exactly one template row. Abort is not represented as server cancellation. |
| SP-S02 P2, standalone connectivity | Reproduced, then fixed; high | Standalone settings now starts/reads the existing composer recovery ledger. Actual page -> composer test retains pending/uncertain intent, blocks Review against old reads and releases only after an attested advanced fence. Existing ABA/history/pageshow recovery code remains in place. |
| SP-P01 P2, unchanged Save and running sequences | Explicit product-decision hold | Existing no-op Save fence remains intact. Decide whether defaults affect future sequences only or unsent steps in existing sequences, and how that relates to configuration revision invalidation. No automatic historical replay or altered fence semantics was invented. |
| SP-P02 P3, Hotel DST/calendar policy | Explicit owner-decision hold | Hotel must define elapsed24-hour vs same-wall-clock days, gap/fold choices and impossible local dates at booking/reminder entry points. Existing elapsed follow-up timing and signed timezone/render clock remain unchanged. |
| D1 DTO duplication | Narrow consolidation fixed | One shared wire type/ID guard across controller/client/recovery. Legacy API compatibility remains a distinct contract. |
| D2 request/recovery duplication | Narrow consolidation fixed | Existing bounded-request and content-receipt namespace reused; no new retry-key store. Read, rejected and uncertain states remain distinct. |
| D3 provenance/render duplication | Resolved/preserved | One existing versioned `followUpProvenance` plus signed rendering context remains authoritative. No second fence/provenance abstraction added. |
| D4 channel/assistant/CRM duplication | Reviewed; preserve distinct products | Separate channel, assistant, campaign and CRM state machines retain their trust boundaries; no generic deletion/refactor. |
| D5 optional approval/recovery UX | Safe subset fixed; remainder awaiting ownership/decision | Created-template toast states approval is still required; uncertain creates link to the library. Read-model projection and explicit operator recovery for authority-review intents, plus pending single-outreach cancel/reschedule, remain separate work. They are not silently treated as delivered or automatically replayed. |

## Exact contracts and shared dependencies

1. **Producer API:** `await configuredFollowUpDispatch(channel, originId, enabledStepOrdinal, payload): Promise<ConfiguredFollowUpDispatch>`. All three actual cron call sites now await it. It uses Tenant's unchanged `captureJobBusiness`; identity is persisted inside `payload`, alongside the existing durable origin/ordinal and provenance. The Email lifecycle regression changes only the await and synthetic billing fixture tables; generic `workers/index.ts`, Tenant helper and Campaign delivery implementation are untouched.
2. **Review envelope:** `state='review_required'`, `reviewReason` (e.g. `JOB_ORIGIN_REQUIRED` or `ORGANIZATION_FORBIDDEN`), with original payload unchanged. SMS location: `sent_messages.follow_up_dispatches[ordinal]`; Email/social location: `outreach_messages.metadata.configuredFollowUpDispatch`. Transient SQL failures keep pending. The new state does not authorize any retry. Migration360 changes only its rollback guard to retain held SMS intents; no up/schema change or new migration ID was introduced.
3. **Campaign consumer dependency:** retain the five identity fields and versioned provenance, and recheck final readiness/effect claims. The parent's prior Campaign SMS disable/template/settings/stalled-worker findings remain Campaign-owned. An outbox lost-ack dedup test is not proof of provider-crash exactly-once delivery. No such claim is made here.
4. **Operator projection dependency, static-only:** current SMS history selects sent reply receipts, not the original SMS outbox envelope; the current browser history fixture also supplies an explicit synthetic empty endpoint. Durable review storage is accepted, but real user-facing review visibility/recovery is not accepted here. Root should coordinate the appropriate read-model owner before changing that shared section. A safe future projection must retain owner/business/origin/step, show reason and no automatic retry, and preserve actual receipt/uncertain status. No new automation principal, legacy reauthorization, billing or retention policy was invented.
5. **Reachability limits:** changed-payer tests mutate an isolated fixture mapping; they do not prove an unauthorized public mapping change. Staff-origin tests exercise the accepted helper boundary; configured cron normally originates under its existing server scope. This correction freezes that actual context and does not invent a historical staff automation policy. TEMP policy tables do not verify the full deployed RLS/resource-assignment trigger stack. Tenant N02 queueBridge-to-direct-executor is a separate finding; this outbox has no direct-send fallback.

## Evidence, reproduction and verification limits

Final scoped acceptance uses the existing installed binaries directly, not package installation. `server/tests/helpers/followUpLocalOnly.cjs` preserves the exact isolation guard used for these tests. Clear inherited environment values, set only explicit synthetic local fixture URLs, and preload that guard using an absolute `NODE_OPTIONS --require` path plus `--experimental-vm-modules`. It permits only loopback TCP ports32768+ and blocks saved `.env` file reads. Start a clean production frontend with `NEXT_PUBLIC_API_URL` and `BACKEND_URL` set to `http://127.0.0.1:32801`, listening on32800; the opt-in browser test mounts its own synthetic API on32801. Do not substitute saved application credentials/databases.

- Server: `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath` for `settings.test.ts`, `followUpStepRoundTripPostgres.test.ts`, `configuredFollowUpDispatchPostgres.test.ts`, `configuredFollowUpOriginPostgres.test.ts`, `emailQueueLifecyclePostgres.test.ts`, `bookingReminderPersistencePostgres.test.ts`, `reminderNotificationDeliveryPostgres.test.ts`, `templateRenderingClock.test.ts`, `contentTemplateRendering.test.ts`, `configuredFollowUpTiming.test.ts`, `followUpTemplates.test.ts`. **139 passing cases** on final product source. Opt-in `followUpCorrectionsBrowserPostgres.test.ts` adds **5 browser cases**, with `FOLLOW_UP_BROWSER_QA=1`, synthetic `OUTREACH_QA_DATABASE_URL` and local production frontend32800/API32801. Its mock auth/shell/module/brand-context collaborators are explicit; settings/template routers, controller validation, response envelopes and Drizzle/PG persistence remain real. History endpoint data is synthetic; its deadline/retry is real HTTP/browser behavior.
- Client: `node node_modules/vitest/vitest.mjs run --maxWorkers=1` over `followUpStepDto`, `followUpPage`, `followUpRecoveryUx`, `followUpTemplateReceipt`, `followUpRequest`, `followUpSaveRecovery`, `contentRequestKey`, `outreachCreation`, `followUpActivity`, `outreachDraftScope`: **107/107**, ten suites. Existing21 page assertions and42 server settings tests are retained. Existing client React `act(...)` warnings remain; no runtime assertions were weakened to hide product failures.
- Full server `tsc --noEmit --incremental false` and prescribed client `tsc --noEmit --incremental false -p tsconfig.typecheck.json` pass. Scoped lint has zero errors: client 0 warnings, server 16 existing `any` warnings in older test adapters; new browser/origin fixtures add no `any` warnings. API and worker esbuild bundles pass.
- Original default client build fails on preserved malformed ignored `.next/dev/types/validator.ts` generated output. A clean disposable copy of the exact tracked/current frontend product source, with SHA256 file manifest and existing dependencies, passes full production Next/webpack build and types. That exact build was used for browser acceptance. Next's temporary tsconfig include additions in the original checkout were removed without resetting other work. No saved environment configuration was changed. No type-ignore/build-error bypass was used.
- Browser-harness development failures (server-only DOM types, CSP-rejected string predicate and a closing-dialog locator) were retained as fixture diagnostics, then corrected using typed server fixtures and settled, focused locators with production CSP intact. They are not new application defect claims or accepted observer tests.
- `node --experimental-vm-modules --test scripts/tests/migration-safety.test.mjs`: **5 passed /1 failed**. The failure is unchanged Tenant migration `340_live_capacity_plan_retention.js` lacking `export const irreversible=true`. Its blob is `18b4791f4809984e2dce5859bae99c7b6570d981` both at base and locally. Root/Tenant must address that integration/CI gate; migration340 was not edited here.
- Full repository CI, provider canaries/live delivery, production authentication/RLS,16 optional PGlite persistence cases and deployment acceptance are unrun. No complete-assurance or green-CI claim follows from scoped local checks. `check-build-secrets` reads saved environment files and was not executed under this task's env-read isolation.
- Required `vscode_askQuestions` is unavailable in this environment. `.github/instructions/verification.instructions.md` says it “is REQUIRED and ABSOLUTE for every change.” This formal repository verification remains **pending**, not satisfied or bypassed. Parent already authorized safe local work/handoffs while retaining this gap. Historical forbidden GitHub hook/settings metadata reads were not retried; external hook visibility remains uncertain. Checked-in push workflows match main/v8/v7/staging, not the scoped handoff. No known handoff deployment trigger was observed.

## Original audit reconciliation and ordered remaining backlog

- Original F01/S01 durable dispatch, F04 variable grammar, F05/F06 signed rendering/timezone, F07 per-destination reminder receipts and Hotel helper rethrow are already integrated ancestors of this base. Current local regression suites preserve those contracts. Original Email F02/F03/S03 delivery fences are covered by the current Email lifecycle suite; separate Campaign SMS findings retain their own owner and acceptance gates.
- Original S02 active-sequence semantics and DST decisions remain SP-P01/SP-P02 holds. Pending single-outreach cancel/reschedule is an optional product/recovery backlog, not an invented implementation in this patch. Its future acceptance must race revisioned cancel/reschedule against claim, preserve old-job harmlessness and represent already-sending/uncertain outcomes.
- Priority1: integrate this exact tested handoff on the integration owner's current v8; rerun combined source acceptance. Coordinate Campaign's final SMS readiness/effect-claim work against the producer contract.
- Priority1: Root/Tenant resolves migration340 irreversible metadata and runs the migration-safety gate. Keep forbidden metadata/Insights publication holds unchanged.
- Priority2: establish the operator read-model/recovery owner and explicit legacy authorization contract; add real scoped history/API tests before implementing any replay action.
- Priority2: decide no-op Save/running-sequence semantics and Hotel DST/calendar rules. Then add focused acceptance for each chosen policy without weakening CAS/ABA guards.
- Priority2: make disposable PostgreSQL/Redis/browser fixtures routine in CI; verify complete RLS/assignment-trigger composition and the16 optional persistence cases. Preserve synthetic/provider isolation.
- Priority3: address existing test `act`/legacy test typing warnings and developer generated-build hygiene independently. Resolve formal unavailable-helper verification with the repository owner; it remains the final pending verification task.

## Archived report retrieval

The complete original audit, including the previously truncated F07 and every later section, is preserved byte-for-byte (including its three intentional Markdown hard-break trailing spaces; all non-archival diffs pass whitespace checks) in `FOLLOW_UP_AUDIT_ORIGINAL_2026-10-23.md`. The pre-correction second-pass report is preserved separately in `FOLLOW_UP_AUDIT_SECOND_PASS_2026-10-23.md`; its old observations and incomplete-harness notes must be read with this correction ledger and the retained origin-completion evidence, not relabelled as new current defects.

- server/FOLLOW_UP_AUDIT_ORIGINAL_2026-10-23.md: SHA256 `f62e053da869c9048613d75ff293dff1bf32b1e3a5d7a2540c439891a28c71fd`.

- server/FOLLOW_UP_AUDIT_SECOND_PASS_2026-10-23.md: SHA256 `b9136cbdf74a3204213f5fb2c8607b7fbf17ac695f2737c47808a12aae920f78`.

## Review points and changed-file manifest

- Settings API: `server/controllers/settingsController.ts:436`, `:467`, `:526`; typed fixture in `server/tests/settings.test.ts:11` and `:213`.
- Producer/recovery: `server/services/outreach/ConfiguredFollowUpDispatchService.ts:29`, `:220`, `:234`; actual cron callers at `server/services/cronService.ts:791`, `:802`, `:806`.
- Template key/deadline/focus: `client/src/components/follow-ups/FollowUpTemplates.tsx:61`, `:65`, `:85`; history deadline `FollowUpHistory.tsx:43`; standalone ledger at `client/src/app/dashboard/(main)/outreach/follow-ups/page.tsx:56`.

The build-source manifest matches 1758 current frontend/shared source files. Changed paths relative to the exact base (31 files, including these documentation/evidence artifacts):

```text
.github/instructions/client.instructions.md
.github/instructions/server.instructions.md
client/src/__tests__/followUpActivity.test.tsx
client/src/__tests__/followUpPage.test.tsx
client/src/__tests__/followUpRecoveryUx.test.tsx
client/src/__tests__/followUpStepDto.test.tsx
client/src/__tests__/followUpTemplateReceipt.test.tsx
client/src/__tests__/outreachCreation.test.tsx
client/src/app/dashboard/(main)/outreach/follow-ups/page.tsx
client/src/components/FollowUpSettings.tsx
client/src/components/follow-ups/FollowUpHistory.tsx
client/src/components/follow-ups/FollowUpTemplates.tsx
client/src/components/outreach/create/SavedFollowUpSummary.tsx
client/src/hooks/use-channel-follow-up-settings.ts
client/src/lib/follow-up-request.ts
client/src/lib/follow-up-save-recovery.ts
server/FOLLOW_UP_AUDIT_ORIGINAL_2026-10-23.md
server/FOLLOW_UP_AUDIT_SECOND_PASS_2026-10-23.md
server/FOLLOW_UP_CORRECTIONS_2026-10-23.md
server/controllers/settingsController.ts
server/migrations/360_configured_follow_up_dispatches.js
server/services/cronService.ts
server/services/outreach/ConfiguredFollowUpDispatchService.ts
server/tests/configuredFollowUpDispatchPostgres.test.ts
server/tests/configuredFollowUpOriginPostgres.test.ts
server/tests/emailQueueLifecyclePostgres.test.ts
server/tests/followUpCorrectionsBrowserPostgres.test.ts
server/tests/followUpStepRoundTripPostgres.test.ts
server/tests/helpers/followUpLocalOnly.cjs
server/tests/settings.test.ts
shared/followUpSettings.ts
```

Final mandatory repository verification task: `vscode_askQuestions` remains unavailable/pending; this handoff does not mark that gate satisfied.
