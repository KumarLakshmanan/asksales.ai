# Followups second-pass audit — 2026-10-23

Audit only. No product changes, implementation commits, pushes, deployment, production database access, paid calls or live sends were performed. Original audit/remediation evidence and the clean original checkout at b75f8142a20daeda543452237b2b1cf2c7291ff2 remain preserved.

Environment: saved cloud workspace; Node 24.19.0; Chromium 151.0.7922.173 on Debian 13; disposable PostgreSQL 16 and Redis 7.2. The local Next server and all three disposable containers were stopped after capture. No synthetic service remains intentionally running.

## Baselines and reconciliation

- Initial remote v8: **438b4126d43b0f8f923e4fed6bae1e9b8c4dd37b**, observed **15:02:34 UTC**; fetched into an isolated detached audit worktree. Initial tests/build retain this baseline label.
- Updated remote v8: **24c66b9cac2936ccbd119e39cf78b5b83b1e6212**, independently fetched **15:10:47 UTC**, independently rechecked unchanged **15:25:47 UTC**. A second detached worktree contains this exact source. Only affected integration boundaries were retested; the broad earlier baseline was not repeated.
- Both original Followups commits baf9cfd54156c517bf235155830f71278673b2c1 and b75f8142a20daeda543452237b2b1cf2c7291ff2 are now ancestors of the updated baseline. Earlier 438b4126 did not contain the full original Followups handoff; its Hotel rethrow existed through a cherry-pick. Those earlier missing-integration observations are superseded, not current defects.
- Tenant 7b54373d / tenant-job-origin d896ced6, Campaign 6980711c, Instagram 62c70908, Organic 3cba92da, Social Listening 2a60c8c8 and Followups b75f8142 all return ancestry exit 0 against 24c66b9c. Their prior handoffs are **integrated source**, not awaiting integration. This does not constitute independent acceptance of all those domains or proof of production deployment.
- Migration 360 is included. Migration 570 and the Data 330/331 and Tenant 340 composition are also present; they are no longer pending remote integration. Actual production migration state was not inspected.

## Architecture and exercised boundaries

`/dashboard/outreach/follow-ups` and compose/Inbox use FollowUpSettings. Actual settings router mounts GET/PUT `/api/settings/integrations/:integrationKey/follow-ups` and the older PUT `/api/settings/outreach`. The controller maps between the public delay-unit DTO and stored channelFollowUps; saveChannelFollowUpSettings locks the scoped settings row and advances a persisted fence.

Template creation flows from FollowUpTemplateDialog through the shared API client/idempotency key to the actual content router, validator, contentTemplatesController, template/version records and request receipt. Repeated same-key POSTs persisted one template in the synthetic fixture.

Cron selects configured steps, captures versioned `followUpProvenance` and signed rendering context, and reserves a durable Email/social message or SMS dispatch envelope. Recovery uses stable retained BullMQ IDs. Campaign's generic EMAIL_SENDING processor consumes the shared EmailQueueDeliveryService, validates provenance after preparation, transitions the token-fenced provider-start claim and checks late reply/cancel/takeover immediately before its mocked provider. Tenant wraps job scope/actor/payer authorization. ReminderService uses independent destination receipts. Hotel's durable confirmation recovery awaits the actual reminder helper and preserves unfinished markers after failure.

API fixtures mount the **real settings/content routers**, validators, response wrapper, controllers and Drizzle persistence against PostgreSQL TEMP tables. Authentication, module availability, approved brand context and unrelated controllers are synthetic/inert. Thus route registration, response shape, settings persistence and template receipts were exercised, while real login, membership/RLS policy, brand approval data and billing authorization were not accepted by that fixture.

The production build belongs to **438b4126**, built during the initial audit before the integration update. Browser tests then used that local production UI against the **24c66b9c mounted API**. The FollowUpSettings, Follow-ups page, FollowUpTemplates, FollowUpHistory, recovery ledger and settings controller files are byte-identical across these baselines (`git diff --exit-code` passed for them). This is explicitly a mixed-baseline local browser check, not a fresh production build or live authenticated UI test of 24c66b9c. Transitive UI imports changed, so broader new-build acceptance remains a gate.

## Confirmed current defects

### SP-F01 — P1: No-edit save enables a disabled sequence step

**Evidence:** settingsController.ts:459 maps every stored step, drops its `enabled` flag, and returns it as an ordinary UI row. The same controller at :556 writes `enabled: true` for every row submitted to the integration endpoint. Both behaviors are unchanged at 24c66b9c.

**Reproduce:** PUT `/api/settings/outreach` with an enabled Email channel and two steps: disabled 1-hour step, enabled 1-day step. GET `/api/settings/integrations/email/follow-ups`, then PUT its unchanged DTO back with `expectedRevision`. The actual mounted routes return 200. PostgreSQL changes the first step from false to true. The production browser also reproduced this through the ordinary Save Settings button against the updated API.

**Expected:** viewing/saving without editing preserves disabled steps or explicitly obtains permission to enable them. **Actual:** hidden state changes on a successful no-edit save. **Impact:** an inactive step can join future automatic outreach and change enabled-step ordinals. No actual send was attempted. **Confidence:** high; real router/controller/persistence reproduction on both baselines.

**Proposal/acceptance:** preserve explicit per-step enabled state across the DTO and both editors, or present disabled rows and an explicit conversion action. Test false/true/false configurations, disabled out-of-order delays, nonnumeric legacy IDs, all five channels and a semantic no-op save. Preserve existing CAS/ABA protections. Owner: this Followups audit; shared settings contract overlaps the historical drafts chats 01a13393-d406-7589-a338-e17eb090b070 and 01a13470-1ec9-7250-89d5-8fdd8fae9075.

### SP-F02 — P2: Template dialog loses keyboard focus on close

**Route/files:** `/dashboard/outreach/follow-ups?tab=templates`; FollowUpTemplates.tsx:53 creates a controlled Dialog without a DialogTrigger or explicit return-focus target. The opener at :72 is outside that Dialog; :79 mounts it separately.

**Reproduce:** keyboard-select a channel, open Create template, type a synthetic name, press Escape. The dialog closes; after an additional bounded 1.5-second wait `document.activeElement.tagName` is `BODY`, not the opener. The focused acceptance test failed twice, the second time with the wait and an active-element capture. Arrow-key channel selection itself worked.

**Expected:** focus returns to the button that opened the dialog. **Impact:** keyboard/screen-reader users lose their place in a long page. **Confidence:** high for this unchanged component; browser build provenance is limited as described above.

**Proposal/acceptance:** connect the opener through DialogTrigger/asChild or explicitly restore focus using the opener ref. Cover Escape, Cancel and successful save from both the Templates page and inline step template creation, including a changed business/unmounted opener. Owner: Followups; deduplicate with the UI/accessibility audit rather than changing a generic Dialog wrapper globally.

### SP-F03 — P2: Unanswered history/create requests leave recovery controls blocked

**Evidence:** FollowUpHistory.tsx:42 calls api.get without a deadline/AbortSignal. Its Refresh button at :55 is disabled throughout loading. FollowUpTemplates.tsx:42 awaits api.post without a deadline; :53 refuses close while saving and :54-61 disables the Cancel/Create fieldset.

**Reproduce:** render the actual components with a transport promise that never settles; advance 61 seconds of fake time. History still says Loading history, Refresh is disabled, and no Try again exists. For template creation, fill valid name/content, submit, and advance 61 seconds: the dialog remains open and Cancel/Create remain disabled. These are two passing **observer** tests demonstrating the current limitation, not fixed-behavior acceptance tests. The request transport is mocked; no claim is made that the real server failed to respond in this audit.

**Expected:** a bounded wait offers recovery/dismissal while preserving uncertainty for a possibly committed POST. **Impact:** users must abandon/reload the view; template drafts/retry context become harder to recover. **Confidence:** high for the client state under a silent transport.

**Proposal/acceptance:** reuse a bounded request primitive; retain the template body and same request key after uncertainty. Closing the dialog must not imply the server write was cancelled. Reopen/retry must reconcile the existing template receipt, not create a second template. For history, keep existing rows and offer bounded retry; cancel stale requests on unmount/channel changes. Owner: Followups; shared API-client receipt handling is owned with the historical drafts/Data recovery contract.

## Static concerns and owner decisions — not confirmed production incidents

### SP-S01 — P1 review: Configured outbox has no immutable actor/payer snapshot

ConfiguredFollowUpDispatchService.ts:25-50 persists user/business/origin/step and provenance but does not capture businessActorUserId, billingActorUserId or billingOrganizationId. cronService.ts:777 constructs this payload without those fields. Recovery at ConfiguredFollowUpDispatchService.ts:249-264 passes it to QueueRegistry.addJob; queues/index.ts:416 invokes ordinary captureJobBusiness without `requireOriginatingIdentity: true`. jobBusinessScope.ts:121-125 can fill absent actor/payer from ambient recovery scope.

**Observed:** the audit's real reservation persisted an envelope missing those fields; strict capture correctly rejects it as JOB_ORIGIN_REQUIRED. **Unproven consequence:** a changed recovery actor/payer could be substituted later. The new end-to-end origin harness failed before enqueue because its TEMP schema first omitted is_reply, then status. No successful wrong-payer enqueue, unauthorized send or charge was demonstrated. Those two harness failures are preserved and are not application defects. Existing configured-dispatch and Email lifecycle tests mock QueueRegistry, so their passing results do not cover this capture boundary. Separate current Tenant origin controls passed 17 tests, establishing that the strict primitive works when callers use it.

**Scope qualification:** production configured cron normally fans out as the durable owner; a real member-to-owner promotion through that production entry point was not established. The principal for a newly generated automated follow-up must be explicitly defined separately from its later immutable recovery identity.

**Proposal/acceptance:** Followups + Tenant owners define and capture server-resolved authority before persisting an intent, then require that same snapshot on recovery. Never accept client-supplied identity or infer legacy authority from the recovery worker. Test real outbox -> actual QueueRegistry -> Redis -> runBusinessJob with changed default payer, revoked origin staff and missing legacy identity. Campaign continues to own generic EMAIL_SENDING; this concern belongs at reservation/recovery, not a second divergent consumer contract.

### SP-S02 — P2 investigation: standalone settings and compose recovery wiring differ

The dedicated page at page.tsx:49 passes no onSaveStart callback to FollowUpSettings. Compose does pass the scoped recovery ledger callback. The historical chained-timeout, stale-readable-token, GET attestation, PUT advanced acknowledgement, history/pageshow and actor/business ownership tests passed on 438b4126, and those contract files are unchanged at 24c66b9c. No regression in those corrections is claimed.

The outstanding scenario is a standalone-page PUT that remains unconfirmed while the user navigates to compose before the old PUT commits. Test this exact navigation and authoritative-read/fence ordering before calling it a bug. Consolidate recovery orchestration only after preserving private draft and original actor/business ownership behavior. Owner: historical drafts chats above + Followups.

### SP-P01 — P2 product decision: unchanged Save invalidates prepared dispatches

A focused current mounted-API/service observer confirms: after canonicalizing the settings, a no-edit PUT advances only the stored revision; configuration excluding revision is identical. Previously valid followUpProvenance then fails assertConfiguredFollowUpReady with "settings changed". This follows the deliberately advanced CAS fence in outreachSettings/functions.ts:46-48 and the delivery hash comparison in ConfiguredFollowUpDispatchService.ts:97-105. Recovery cancels a policy-stopped pending envelope.

Do not weaken the historical fence to remove this consequence accidentally. Decide whether no-op saves preserve prepared deliveries, explicitly stop them, or require renewed review. Separately decide how real edits apply to future steps of an already running sequence. Then test the chosen behavior together with the chained-timeout/ABA controls, late cancellation and no historical replay. This is a confirmed mechanism with **undecided product semantics**, not a newly declared defect.

### SP-P02 — P3 timezone policy/helper boundary

Current timezone.ts:16-72 maps New York 2027-03-14 02:30 to 06:30Z, which round-trips to **01:30**; the requested wall time is nonexistent. It chooses 05:30Z for the repeated 2027-11-07 01:30. It also normalizes 2027-02-30 to March 2. These are direct helper probes, not proof that Hotel HTTP validation accepts an invalid calendar date. Owner: Hotel timezone policy; shared Followups date rendering is separate and has signed-clock acceptance coverage.

Specify reject/shift behavior for DST gaps and earlier/later occurrence for folds, and require round-trip validation accordingly. Decide whether "one day before" means 24 elapsed hours or the prior local calendar day. Keep these decisions separate from rendering-clock stability and sequence replay policy.

## Safe consolidation and optional UX backlog

1. Consolidate the two settings DTO serializers/validators first: `/settings/outreach` retains per-step enabled while the integration route erases it. A shared typed mapping should preserve flags/IDs, effective duration and CAS acknowledgement without erasing legacy compatibility.
2. Share bounded request/recovery orchestration across standalone settings, compose settings, history and template creation. Preserve separate read-error, definite rejection and uncertain-write outcomes; keep the existing shared API idempotency primitive rather than adding another receipt store.
3. Keep one FollowUpProvenance contract and one signed TemplateRenderContext. There is now one producer/consumer versioned contract in integrated source; do not revive the preliminary configuredFollowUpFence alternative. Client/server rendering implementations may share grammar/test vectors while keeping browser escaping and server signing boundaries separate.
4. Do not flatten Email, social, assistant support and CRM reminder state machines into a generic sender: their claim, consent, approval and uncertainty semantics differ. Shared code should cover typed provenance and common validation; channel-specific provider-start/receipt transitions remain owned separately.
5. Optional UX: show explicit pending/review/cancelled-by-settings reasons after a save, distinguish template-created from template-approved, and explain the chosen future-sequence policy before users save it. The current layout has readable five-channel navigation, labeled delay controls and no horizontal overflow at 390px/100% zoom. Avoid redoing those working controls.

## Verification ledger

| Baseline/boundary | Result | Limits/evidence |
| --- | --- | --- |
| 438b4126 existing server scope | 61 passed / 7 suites | server-baseline.log; real local TEMP SQL where opted in; other collaborators mocked |
| 438b4126 client recovery/compose scope | 85 passed / 6 files | client-baseline.log; includes historical recovery corrections; React act warning retained |
| 438b4126 production build | passed | next-build.log; old baseline, not rebuilt broadly after integration |
| 24c66b9c mounted settings/template routes | 3 observer/control tests passed | disabled-step mutation, real fence/409 and template receipt replay; current-mounted-api.log |
| Mixed-baseline production browser | 1 navigation/layout/retry test passed | current API, unchanged audited UI files from earlier production build; browser.log/evidence JSON/screenshots; 390px scrollWidth=390, zoom=1, no page errors |
| Same browser keyboard focus acceptance | failed twice | keyboard-final.log; BODY after 1.5s; channel keyboard selection and close worked |
| 24c66b9c integrated delivery/receipt/clock + actual Hotel caller | 61 passed in 6 files | current-focused.log; seventh file's one new origin audit failed due incomplete fixture. Real PostgreSQL/BullMQ retention; providers/credits/account infrastructure mocked as stated in suites |
| 24c66b9c Tenant origin controls | 17 passed / 1 file | tenant-origin-controls.log; mocked identity authorization leaves configured-outbox integration unproven |
| 24c66b9c silent-transport client observers | 2 separately executed cases passed | history-observer.log, template-pending-observer.log; each demonstrates the defect/limitation, not a fix |
| 24c66b9c unchanged-save policy observer | 1 passed | unchanged-save.log and JSON; actual mounted API + actual readiness helper |
| Origin end-to-end audit harness | blocked by fixture incompleteness | original missing is_reply, then missing status; no enqueue result established; not a product baseline failure |
| Full migrated Hotel HTTP replay suite / full new Next build / live authenticated UI / paid providers | unrun here | actual Hotel side-effect caller tested; broader parent integration results not counted as this worker's runs |
| New full types/lint/remote CI | not rerun in audit-only phase | parent reports two existing settings-fixture TS errors and unknown prior CI failures; this is not a green CI claim |

Tests used empty process environments, the existing network/env-file guard, disposable loopback PostgreSQL/Redis and Chromium with external requests/WebSockets blocked. All providers were disabled/mocked. The Next production server's attempted env-file read was rejected by the guard; no env-file contents were read. Next generated a tsconfig include during the old build; only that generated audit-worktree change was restored to its exact audited contents. All three checkouts have no tracked changes. New files are synthetic audit harnesses/evidence only.

Useful commands are retained in the task transcript and COMMANDS.md. Logs, JSON, screenshots and all audit harnesses remain in /workspace/followup-second-pass. Original REPORT.md SHA256 remains f62e053da869c9048613d75ff293dff1bf32b1e3a5d7a2540c439891a28c71fd; original incremental bundle remains ca755eaa5e2a58983b2ef272c37dc88318061dff380d056d1d64edf8299a0147.

## Ordered next work, requiring the separate fix instruction

1. Fix SP-F01 with a shared lossless step contract and real router/DB no-edit acceptance.
2. Resolve/test SP-S01 with Followups + Tenant before treating recovery identity as fully accepted.
3. Fix dialog return focus and bound silent History/template-create operations while preserving uncertain-write receipts.
4. Review SP-P01 before changing delivery invalidation or editing running sequences; preserve historical CAS/ABA controls.
5. Exercise standalone-page late-save navigation (SP-S02) and settle Hotel DST policy (SP-P02).
6. After approved fixes/integration, run a fresh production build/browser pass for the final exact SHA, full migrated Hotel replay acceptance, required checks and remote CI diagnosis.

No new platform denial occurred in this audit. Previously denied metadata/hook reads and the Insights publication were not retried or routed through another owner. The unavailable repository-required vscode_askQuestions verification helper remains an existing pending gate; no product completion or complete assurance is claimed.
