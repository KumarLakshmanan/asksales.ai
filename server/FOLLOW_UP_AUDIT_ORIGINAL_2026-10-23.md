# Follow-ups, reusable templates and scheduling audit

**Repository:** <private-source-repository>  
**Audited branch/SHA:** remote `v8`, `35d6107b50aaabf238a2fc1fa39ff172bdf6b8f7`  
**Audit date/environment:** 2026-10-23, saved cloud environment, `/workspace/salesmarketing`, UTC  
**Result:** seven confirmed local findings: four P1 and three P2; three additional static concerns. No P0 identified in this focused audit. This is not assurance that untested paths are defect-free.

## 1. Checkout, instructions and safety

The initial branch was `work` at `09fe888ec8bdd3fa12ccee0e047cd1d876306222`, with a clean working tree. `git remote -v` identified `https://github.com/<private-source-repository>.git`. `git ls-remote --heads origin v8` returned the audited SHA. I fetched only `origin v8` and used `git switch --detach FETCH_HEAD`. A final remote read returned the same SHA. No reset, force, stash, rebase, merge, saved configuration change, commit, push or deployment was performed. Final `git status --porcelain=v1`, staged diff and working diff were empty.

No `AGENTS.md` was found under the repository or at `/workspace`; `/workspace/.agents` was empty. I read relevant `.github/instructions/server.instructions.md`, `client.instructions.md`, `email-outreach.instructions.md`, `verification.instructions.md`, and the Jest/Vitest configuration. The change-verification instruction was not triggered: application files were not edited. All report, harness and log files are outside the repository at `/workspace/followup-audit`.

Runtime: Node **24.19.0**; installed pnpm **11.19.0** versus requested **10.30.3**; Jest **30.3.0**, ts-jest **29.4.6**, TypeScript **5.9.3**, Drizzle **0.45.2**, pg **8.20.0**, Vitest **4.1.6**. Tests used installed tools directly; I did not synchronize dependencies or alter the lockfile. The requested model was GPT-6.1 Sol; the execution tools do not expose a model attestation, so this report makes no independently verified model claim.

All test commands used a clean process environment (`env -i`), `NODE_ENV=test`, server `SKIP_DB=true`, explicit timezone and an audit-only Node preload. The preload rejects environment-file reads and outbound TCP except ephemeral loopback test servers. Relevant tests were inspected for mocked database/provider dependencies. No application server, delivery worker daemon, production connection or paid model/provider call was started. Synthetic recipients use `.test` addresses in the new harnesses. No real email, SMS, WhatsApp/social message, invitation, payment or account mutation occurred. No public/live pages were used: all findings below are local evidence.

## 2. Scope and architecture map

In scope: channel follow-up creation/editing, reusable template creation/editing/approval/rendering, variable validation, elapsed schedules and timezone/DST behavior, reply/handoff cancellation, pending-work invalidation, duplicate submission/retry and interrupted flows. CRM reminders were checked only for follow-up scheduling and repeated delivery. Native WhatsApp provider templates, proposal lifecycle, broad CRM/tenant authorization, campaign billing and subscriptions are adjacent areas, not exhaustively audited here.

| Layer | Paths and responsibilities |
|---|---|
| Follow-up UI | `client/src/app/dashboard/(main)/outreach/follow-ups/page.tsx`, `components/FollowUpSettings.tsx`, `components/follow-ups/FollowUpTemplates.tsx`, `FollowUpHistory.tsx` |
| Outreach draft/review | `components/outreach/create/OutreachCreationPage.tsx`; `hooks/use-channel-follow-up-settings.ts`; `lib/follow-up-request.ts`, `lib/follow-up-save-recovery.ts` and scoped draft/recovery utilities |
| Settings API/storage | `PUT/GET /api/settings/integrations/:integrationKey/follow-ups`; `controllers/settingsController.ts`; `models/outreachSettings/functions.ts:21` locks the scoped row, patches one channel and advances/reconciles a revision fence |
| Reusable templates | `/api/content/templates` and use/edit/approve/duplicate/import operations; `controllers/contentTemplatesController.ts`; `models/contentTemplates/functions.ts`; template/version/receipt tables |
| Rendering/approval | `shared/templateVariables.ts`; `utils/contentTemplateRendering.ts`; `services/content/ApprovedTemplateResolver.ts`; `services/followUpTemplateService.ts` |
| Initial scheduled outreach | `controllers/outreachConversationsController.ts:2458`, `:2856`, `:2882`; `services/outreach/CreationService.ts:488` validates an explicit UTC/offset instant, one minute to 90 days; queue delay and confirmation deadline are persisted |
| Explicit creation follow-ups | `services/outreach/CreationFollowUpService.ts`: durable origin/step identities, approved account/recipient checks and activation recovery |
| Configured follow-ups | `services/cronService.ts:609`: minute sweep; Email uses durable outreach-message reservations, SMS a sent-message step CAS, social a conversation schedule and anchor |
| Delivery boundary | `workers/index.ts:618` Email; `:937` SMS; configured provider binding service; Email/social claim helpers; shared credit/provider services |
| Social/assistant schedules | `socialFollowUpService.ts`; `assistants/AssistantFollowUps.ts` and `AssistantConfiguration.ts`; assistant replies have separate published-sequence/outbox/availability gates |
| CRM reminder follow-ups | `components/crm/ContactReminders.tsx`; `/api/crm/reminders`; `ReminderService.ts`; explicit contact-email opt-in, assignment, completion, snooze and notification retry |

API/worker business context is carried through `tenancy/jobBusinessScope.ts` and `businessContext.ts`; I inspected these to avoid incorrectly treating scoped queries as global ones. Forced RLS and real concurrency behavior were not validated against a database in this run.

## 3. Executed tests and coverage

**Existing tests: 433 passed**: server **227** across **16** suites, client **206** across **11** files. Four optional database suites were selected but skipped: **33 tests**, not passes. **Audit harnesses: 18 passed** across six files. These observer tests assert the reported defective behavior, so their green status confirms reproductions, not correctness. Six timezone cases were additionally replayed under `America/Los_Angeles`.

| Area | Status | Evidence and limits |
|---|---|---|
| Settings validation, exact combined delays, conflicts and enabled flags | Passed with mocked persistence | `settings.test.ts`, client `followUpPage.test.tsx`; actual SQL save locking remains unverified |
| Failed saves, cancelled template dialogs, duplicates, dismissals, scope changes and uncertain delayed replies | Passed | `followUpPage`, `outreachCreation`, `followUpSaveRecovery`, `followUpRequest`, `outreachDraftScope` client tests |
| Reusable create/edit/approve/copy/render | Passed for covered cases; failed for F04/F05 | `contentTemplateLifecycle`, `contentTemplateVersions`, `contentTemplateRendering`, client reusable library/reuse tests plus audit harnesses |
| Canonical variables, aliases, HTML escaping, structured email sections | Passed for covered cases; failed for malformed syntax | `templateVariables`, `emailTemplateSections`, follow-up template tests; F04 |
| 1h/24h origin-relative timing; UTC parsing; delayed delivery | Passed | `configuredFollowUpTiming`, `emailFollowUpBehavior`, `socialFollowUpBehavior` |
| DST | Passed for elapsed-duration contract and selected assistant availability cases | Audit spring/fall 24h cases; existing `outreachAssistantConfiguration.test.ts` exercises an actual New York opening across fall DST; browser gap/fold selection unrun |
| Reply/handoff cancellation | Passed for early checks; failed during Email preparation | Existing creation/social tests and `worker-gaps.test.ts`; F02 |
| Channel disable after queueing | Failed locally | Actual Email processor with latest settings fixture disabled; no settings query before mocked send; F03 |
| SMS failed queue submission | Failed locally | Actual scheduler and pending selector with stateful synthetic persistence; F01 |
| CRM create/edit/snooze/completion controls and core reminder service | Passed for covered cases | `crmReminderControls.test.tsx`, `reminderService.test.ts`; repeated partial delivery fails F07 |
| Template receipt atomicity, simultaneous first settings saves, real SQL scoping | Blocked/unrun | Missing isolated PostgreSQL engine; optional suites skipped |
| Email/social process-kill recovery | Static-only | S01; no real Redis/PostgreSQL crash injection performed |
| Global sequence edits affecting already-running sequences | Static-only | S02; product semantics also need definition |
| Real browser desktop/mobile, real Redis/BullMQ persistence and actual provider outcomes | Unrun | No app startup, credentials or live-provider requests |
| Full application test suite/build/typecheck/performance | Unrun | Audit targeted this scope; no source change required broad build validation |

Logs: [server baseline](/workspace/followup-audit/server-baseline.log), [server additional](/workspace/followup-audit/server-additional.log), [client baseline](/workspace/followup-audit/client-baseline.log), [audit harness](/workspace/followup-audit/harness.log), [LA timezone replay](/workspace/followup-audit/timezone-la.log). Exact repeatable commands and file lists are in [run-audit.sh](/workspace/followup-audit/run-audit.sh).

## 4. Confirmed bugs

### F01 — P1: SMS follow-up is consumed when queue submission fails

**Confidence: high for the application branch; database/provider boundaries mocked.**

Evidence: [cronService.ts:827](/workspace/salesmarketing/server/services/cronService.ts:827) claims/advances the sent-message step before phone validation and `queueRegistry.addJob`. The surrounding error handler logs an error without undoing that claim. [cronService.ts:1236](/workspace/salesmarketing/server/services/cronService.ts:1236) treats the stored counter as completed work and skips it on subsequent scans. CAS implementation: `cronService.ts:1445`.

Reproduction: `cron-gaps.test.ts` supplies a due one-step SMS sequence and synthetic sent-message row, lets the real claim path persist step 1, and rejects the mocked queue call with `Synthetic Redis queue outage`. Actual: marker **1**, accepted jobs **0**, next pending scan **[]**; a second scheduler call does not submit again. Expected: a definite enqueue rejection leaves recoverable pending work. Impact: silently lost customer follow-ups after transient Redis failure; the same ordering also consumes a step when no current phone exists.

Remediation: validate recipient before claim; persist a durable delivery/outbox row with the step transition; dispatch/reconcile by a stable origin/step identity. As an interim measure, handle definite enqueue rejection with a guarded rollback, while preserving uncertain enqueue outcomes for reconciliation.

Acceptance: inject queue rejection, missing phone and scheduler restart after claim; every eligible step must eventually have exactly one durable delivery or an explicit stopped/failed state. Retrying must neither skip nor double-send it.

### F02 — P1: Email can send after reply/cancellation or human takeover during preparation

**Confidence: high, actual Email worker and claim helper; synthetic persistence and sender.**

Evidence: [workers/index.ts:641](/workspace/salesmarketing/server/workers/index.ts:641) checks the original binding and paused/replied state; `:660` claims delivery; `:671` then awaits credit preparation and later thread lookups; [workers/index.ts:719](/workspace/salesmarketing/server/workers/index.ts:719) calls the sender without a final cancellation check. Claim SQL at [emailFollowUpService.ts:147](/workspace/salesmarketing/server/services/emailFollowUpService.ts:147) checks cancellation/replies only at claim time. Social delivery already has a distinct final `confirmSocialFollowUpDelivery` guard (`socialFollowUpService.ts:385`).

Reproduction: `worker-gaps.test.ts` lets early checks pass, then makes an inbound reply/cancellation visible inside the mocked asynchronous credit reservation. Actual: sender called once, worker reports success. Human takeover in that same window also still sends. Control: a cancellation visible before binding is suppressed. Expected: a committed stop event during preparation prevents crossing the provider boundary. Impact: unwanted automatic Email after a person replies or staff take ownership.

Remediation: add a final guarded state/version check as close as possible to provider invocation, after preparatory awaits; release unused reservations and persist cancellation. Do not promise mathematically atomic cancellation across an external provider call already underway.

Acceptance: insert reply, opt-out, closure and takeover at every preparation await; sender stays untouched when the stop event precedes final authorization. Separately reconcile an already-started provider request without an automatic resend.

### F03 — P1: Disabling configured follow-ups does not invalidate an already-queued Email

**Confidence: high for Email; SMS/social extension is static-only.**

Evidence: [saveChannelFollowUpSettings](/workspace/salesmarketing/server/models/outreachSettings/functions.ts:21) only updates settings. The configured queue payload [cronService.ts:797](/workspace/salesmarketing/server/services/cronService.ts:797) carries neither the channel revision nor selected template provenance. [ConfiguredFollowUpDeliveryService.ts:13](/workspace/salesmarketing/server/services/outreach/ConfiguredFollowUpDeliveryService.ts:13) checks original account, recipient, reply and conversation state but never current channel enablement. The Email worker also does not load current channel settings.

Reproduction: `worker-gaps.test.ts` runs a queued configured Email with the fixture's latest channel settings disabled and otherwise valid original binding. Actual: sender called; executed SQL reads only original binding and delivery claim, never settings/templates. Expected: turning off automatic channel follow-ups prevents unsent configured work from sending. Impact: “disabled” automation can still deliver while backlog or provider cooldowns drain.

Remediation: carry an explicit settings revision/policy with pending work, recheck channel enablement at final delivery authorization, and visibly cancel or reconcile pending deliveries when disabling. Define whether edited defaults should update, cancel or preserve existing schedules.

Acceptance: queue a job, disable the channel, execute it; zero provider calls and an explicit cancelled history record. Re-enable should follow a documented restart rule, with no stale backlog burst. Repeat for rate-limited/delayed jobs and all five channels.

### F04 — P2: Unsupported placeholder syntax bypasses save and unresolved-variable checks

**Confidence: high, actual create controller and renderer; persistence mocked.**

Evidence: the shared recognizer [templateVariables.ts:82](/workspace/salesmarketing/shared/templateVariables.ts:82) only recognizes tokens starting with a letter and containing a restricted set of characters. Both unknown and unresolved detection depend on that recognizer. [contentTemplatesController.ts:191](/workspace/salesmarketing/server/controllers/contentTemplatesController.ts:191) and `:211` consequently save/approve text whose unrecognized placeholders were never validated. The server renderer repeats the same narrow regex (`contentTemplateRendering.ts:8`).

Reproduction: create an Email template containing `Hello {{1}}`, `Hello {{ first name }}` or `Hello {{}}`. `controller-variables.test.ts` receives **201**, `isApproved:true`, `variables:[]`. `variables-time.test.ts` preserves each token while reporting `unknown:[]`, `unresolved:[]`. Expected: reject unsupported placeholder syntax or explicitly encode literal braces. Impact: raw placeholders can pass approval/preview checks and reach message bodies. These are generic Email tests; native WhatsApp positional-template support is a separate grammar.

Remediation: scan all brace-delimited constructs, validate them against the channel grammar, and reject malformed/unresolved constructs consistently across save, preview and delivery. Keep an explicit literal-escape mechanism if needed.

Acceptance: cover numeric/empty/space-containing, nested/triple/unbalanced braces, valid aliases, and intended literal braces; unsupported tokens fail before approval and never reach a sender.

### F05 — P1: Scheduled saved-template delivery fails solely because the date changed

**Confidence: high, actual approved-template resolver and delivery assertion with fake clock.**

Evidence: [ApprovedTemplateResolver.ts:38](/workspace/salesmarketing/server/services/content/ApprovedTemplateResolver.ts:38) rerenders current template content during delivery and compares it literally with the reviewed snapshot at `:47`. [contentTemplateRendering.ts:37](/workspace/salesmarketing/server/utils/contentTemplateRendering.ts:37) derives dynamic date variables from a fresh wall clock. There is no pinned rendering time in this assertion. Queued creation delivery invokes this assertion at `CreationFollowUpService.ts:64`.

Reproduction: `date-template-delivery.test.ts` reviews an approved Email template `As of {{current_date}}, hello {{first_name}}` at `2026-10-23T23:59Z`. The identical snapshot/version/recipient passes then. Move the clock to `2026-10-24T00:01Z`: it rejects with **409 TEMPLATE_RENDER_CHANGED**, despite no edit. Expected: an authorized scheduled send should follow a deliberate stable policy for dynamic values. Impact: scheduled or delayed saved-template outreach crossing a day/month/year boundary can fail and misleadingly claim template/recipient changes.

Remediation: pin approved dynamic values/rendering instant/timezone in the review snapshot and use them for later integrity checks, or explicitly render for the scheduled instant and disclose that policy during review. Preserve real version, brand and recipient invalidation.

Acceptance: review shortly before midnight and deliver afterward using each current-date/month/year variable; unchanged approval must remain valid under the declared policy. Real template/recipient changes must still fail.

### F06 — P2: Dynamic date variables depend on worker host timezone

**Confidence: high for inconsistent function output; user-facing severity depends on intended timezone policy.**

Evidence: [contentTemplateRendering.ts:38](/workspace/salesmarketing/server/utils/contentTemplateRendering.ts:38) uses `toLocaleDateString('en-US')`, local `getFullYear()` and a month formatter without `timeZone`. The function accepts a clock but no timezone. Client fallback preview uses browser locale/timezone in `client/src/utils/templateVariables.ts:78`.

Reproduction: render `{{current_date}} / {{current_year}}` at the same instant, `2027-01-01T00:30Z`. UTC process: **1/1/2027 / 2027**. LA process: **12/31/2026 / 2026**. Both runs are preserved in logs. Expected: an explicit workspace/user/business timezone and formatting policy independent of worker location. Impact: wrong date/year for the intended business, inconsistent preview/delivery and deployment-dependent behavior.

Remediation: propagate a validated IANA timezone and explicit locale from approved context or an explicit product-wide policy; use it for all dynamic fields and pin it with the rendering snapshot. Fix alongside F05.

Acceptance: identical instant/context produces identical text on hosts in UTC, LA and Kolkata; local midnight, month/year rollover and both DST transitions are covered.

### F07 — P2: A partial reminder failure repeats the already-sent internal notification

**Confidence: high for delivery orchestration; persistence, claim and email services mocked. CRM overlap.**

Evidence: [ReminderService.ts:466](/workspace/salesmarketing/server/services/ReminderService.ts:466) sends the internal notification first, then optional customer email at `:491`. A contact failure enters common backoff, clears `lastSentAt` at `:547`, and retries the entire reminder. No independent accepted-delivery receipt is stored for the internal notification.

Reproduction: `reminder-retry.test.ts` processes an opted-in synthetic reminder. Internal email succeeds, contact email fails. Process the retry: internal email succeeds a second time before the contact email is retried. Actual: **four mocked calls**, with the same internal notification accepted twice. Expected: retry only the failed destination once its sibling delivery was acknowledged. Impact: duplicate owner/member reminders and misleading overall failed state after a partially successful operation. Provider-uncertain outcomes were not exercised here.

Remediation: track separate internal/customer delivery state and idempotency keys, preferably as outbox entries; keep the reminder action state separate from notification outcome.

Acceptance: internal success/contact failure, reversed failure order, post-acceptance persistence failure and restart all retry only unresolved destinations. Rescheduling must create a new intentional notification identity.

## 5. Static concerns requiring integration confirmation

| ID / priority | Concern, evidence, reproduction plan and expected result |
|---|---|
| S01 / P1 | **Email/social reservation-to-queue crash gap.** Email reservation commits a queued row and advances its origin (`emailFollowUpService.ts:73`), then cron separately submits the job (`cronService.ts:779`, `:794`). Exception rollback exists, but process death bypasses it. Future Email scans use the advanced counter (`:1077`). Social reservation moves schedule to queued (`socialFollowUpService.ts:301`), while due scans select only active schedules (`:193`). `recoverCreationFollowUps` recovers a different creation activation path, not these configured delivery reservations. Confidence medium-high from reachable code; no real process kill/Redis test. Validate by killing after SQL commit and before enqueue, then restarting: every orphan must be re-enqueued once or surfaced for review. Use an outbox/reconciliation scan and stable job IDs. Shares root cause/remediation with F01. |
| S02 / P2 | **Editing active defaults has inconsistent semantics.** Email/SMS read the current enabled step list and use a count as index (`cronService.ts:1074`, `:1232`); social persists a copied `steps` list at activation (`socialFollowUpService.ts:110`) and later reads that snapshot (`:222`). A settings save changes only the settings row. Removing/reordering periods can skip or reinterpret Email/SMS remaining steps while existing social sequences keep old values. Product contract is unspecified, so not a confirmed bug. Define “future sequences only” versus “update unsent steps”; test changes after step 1, template replacement, disable/re-enable and multi-step backlogs, with an explicit revision policy and stable step identities. |
| S03 / P1 | **Selected template/brand approval can change after configured queueing.** Cron verifies template before creating the job (`cronService.ts:669`), but the resulting Email/SMS payload lacks template ID/version and delivery does not reload it (audited job keys and worker reads in harness log). No end-to-end template revocation test was run. Validate queue → delete/edit/revoke brand/template → execute. Expected: cancel/review according to approved-content policy rather than silently deliver stale material. Share delivery provenance/invalidation work with F03; overlap with content-governance audit. |

## 6. Improvements and ordered backlog

1. **P1 — Delivery authorization:** F02 + F03 + S03. Put current stop state, channel enablement, reviewed template/brand and account/recipient checks at the final provider boundary. Preserve uncertain outcomes for reconciliation. Acceptance is the worker race/disable/revocation matrix above.
2. **P1 — Durable dispatch:** F01 + S01. Add outbox/recovery semantics consistently across SMS, Email and social, with stable origin/step IDs. Run isolated PostgreSQL/Redis fault-injection at each commit/enqueue/ack boundary. Avoid rolling back an enqueue whose outcome is unknown.
3. **P1 — Stable dynamic rendering:** F05 + F06. Specify reviewed-vs-scheduled-time semantics, pin rendering context and timezone, and retain the existing integrity checks for real changes.
4. **P2 — Strict variable grammar:** F04. Share broad token scanning and explicit validation across all generic template save/preview/send paths; keep native provider-specific grammar separate.
5. **P2 — Partial reminder delivery:** F07. Separate destination receipts and notification/action states, with restart-safe identities and explicit opt-in retained.
6. **P2 — Define existing-sequence editing behavior:** S02. Apply the same contract across all channels; expose whether changes affect pending work and show a preview of affected steps.
7. **P2 — Add pending-message controls.** The reviewed single-outreach route creates delayed work, while `FollowUpHistory.tsx` is read-only and the inspected single-outreach routes expose no dedicated cancel/reschedule operation. Campaign cancellation is a different path. Add scoped pending-send cancel/reschedule with an expected revision, final delivery fence, and explicit “already sending/uncertain” state. Integration acceptance: race cancel/reschedule against claim, preserve old job harmlessness, and never create two sends. This is a usability/recovery improvement, not an asserted missing-contract bug.
8. **P2 — Make DST choices explicit.** Current initial outreach and reminder forms convert browser `datetime-local` through JavaScript `Date`; local timezone is displayed. Follow-up “days” are elapsed 24 hours, which passed tests and is not itself a defect. Clarify elapsed-versus-same-wall-clock wording, reject nonexistent spring-forward local times, and disambiguate repeated fall-back times where clock-time scheduling is offered. Browser validation remains unrun.
9. **P2 — Make the isolated DB suites routine.** Provide a known local fixture engine/tooling and run the existing 33 skipped tests plus the new fault-injection matrix in CI. Test complete request middleware/envelopes/RLS/transactions, not only controller mocks. Preserve the no-production/provider guard.
10. **P3 — Improve test evidence quality.** Resolve existing client `act(...)` warnings, label tests that only assert source text, and align the installed package manager with the declared version in the audit/CI environment. No application failure was attributed solely to those warnings or version mismatch.

## 7. Baseline failures, historical leads and blockers

**No failures in the selected existing runnable tests.** The client emitted React `act(...)` warnings, and Jest emitted experimental VM-module warnings. These do not prove a product bug. The initial custom harness invocation used an absolute `@jest/globals` import and failed before running tests; the audit-only harness was corrected to use Jest's normal resolver and all 18 observer tests passed. That tooling error is not a baseline failure.

Historical creation/template-save errors were treated only as leads. Current client tests cover draft retention, repeated clicks, stable recovery keys, account/business remounts, uncertainty ledgers, bounded requests, conflicts and delayed responses. Current server code includes channel row locking/revision fences and an atomic template/version/receipt transaction (`contentTemplates/functions.ts:56`). The audit did **not** reproduce a generic “template creation always fails” or ordinary “save follow-up loses the draft” defect. Real database receipt/scoping/concurrency behavior remains unconfirmed because the integration fixtures did not run.

**Exact remaining blocker:** executing `followUpSettingsPersistence.test.ts` requires an isolated `FOLLOW_UP_QA_PGLITE_MODULE` under `/tmp`; the PostgreSQL suites require an explicit isolated `OUTREACH_QA_DATABASE_URL`. Neither was available. A temporary dependency read/install into `/tmp/followup-audit-deps` failed with **EAI_AGAIN / getaddrinfo registry.npmjs.org**. No repository dependency was changed. Outcome is **failed/unavailable**, not an approval denial or uncertain business write. I did not point tests at the saved onboarding or any production database. Four optional suites/33 tests therefore remained skipped. Static analysis and mocked tests completed independently. No auto-review denial, pending approval or unknown external mutation remains.

## 8. Reproduction artifacts and consolidation notes

All artifacts are under `/workspace/followup-audit`:

- `REPORT.md` — this report; `environment.txt` — checkout/runtime record.
- `run-audit.sh` — exact safe replay commands using installed tools.
- `isolate.cjs`, `jest.config.cjs` — audit isolation/configuration only.
- `cron-gaps.test.ts` — F01 and configured payload evidence; Email enqueue rollback control.
- `worker-gaps.test.ts` — F02/F03; early-cancellation control.
- `controller-variables.test.ts`, `variables-time.test.ts` — F04/F06, UTC/DST checks.
- `date-template-delivery.test.ts` — F05 midnight reproduction.
- `reminder-retry.test.ts` — F07 partial delivery reproduction.
- Logs listed in section 3 and `harness-deps.log` for the exact optional-tool failure.

For consolidation: F01/S01 concern dispatch reliability; F02/F03 concern outreach delivery cancellation; F04/F05/F06 concern generic content templates/variables/scheduling; F07 overlaps the CRM reminder audit. S03 overlaps template approval/governance. Assistant availability was sampled to distinguish its separate support sequence from configured outreach defaults; this report does not replace the independent support-agent audit. Tenant/pricing/plan/limit coverage belongs to the other audit chats.
