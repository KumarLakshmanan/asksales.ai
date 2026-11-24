# Proposals: second-pass corrections — 23 October 2026

Five confirmed corrections were implemented sequentially in the original audit chat. Only the final coherent, verified source snapshot is prepared for publication; sequential working commits and their failing-before evidence remain local. No signature/approval/reconciliation policy, generic delivery worker, shared tenancy core, migration, workflow, credential setting or deployment was changed.

## Baseline and dependency manifest

- Original second-pass audit: v8 `24c66b9cac2936ccbd119e39cf78b5b83b1e6212`, independently observed 15:27:18 UTC.
- Remediation began from the same SHA, fetched 16:25:08 UTC.
- v8 advanced by three commits to **`a73dd61ed8876bd6774440ee2f3b06b4d7e63170`**. Reconciled and rebased, then independently fetched again at **17:00:27 UTC**. Added changes concern support handoff authorization, support assignee bounds and analytics reporting windows; no proposal/client/shared source overlap was found.
- Final tested working source: `08aab068062cffa920f9d9e44bd9a70249e7881f`, directly based on the reconciled v8 through five local commits. Publication combines that exact nine-file source/test diff plus this report into one commit directly on a73dd61e. Local intermediate commits with subsequently corrected test typing are not published.
- Existing proposal publication `0917502b9aca0a255ec4d38772fe340795c5be23`, UI handoff `b226927f1b5aec58a5fb94babe30d363785bb17a`, historical editor restore `edf6727d4da8159cab5d03b7341a5fdb706d75e4`, Tenant/job-origin, Followups, Campaign, Instagram, Organic and Social integrations remain included. No duplicate merges or copies of their fixes were made.
- Dependencies: existing business/actor/billing scope and PostgreSQL RLS; existing one-default-per-business/user partial unique index; PostgreSQL transaction advisory locks; existing `isDefault`/terms template API contract and automatic commercial guard. All 331 existing migrations applied to disposable PostgreSQL; **zero new migrations**. No migration 420–429 was needed.
- Only `handoff/audit-20261023-proposals` is the publication target. The integration owner alone writes v8. Prior denied REST/hook operations and the separate Insights publication hold were not retried or bypassed. No known deployment trigger was changed. External hooks remain unknown; this is not a green-CI claim.

## Complete per-finding disposition

| Audit item | Final status | Evidence / remaining queue |
| --- | --- | --- |
| P2 concurrent default-template 500 | **Fixed** | Real concurrent create and mixed create/update tests failed before, pass after. Every successful create persists; exactly one default remains; other business default unchanged; foreign template update 404. |
| P2 missing default selector/approved terms configuration | **Fixed** | Two new client tests failed before, pass after. Real template UI saves by keyboard, reloads the choice/terms, and satisfies the unchanged automatic-commercials guard with actual approved-catalog persistence. |
| P3 fragmented mobile editor labels | **Fixed** | 390px label measured 60px high before versus <=24px acceptance. Both 390px and 1440px pass after, scale 1, no horizontal overflow, retained stale-save/reload/cancelled-restore acceptance. |
| P3 failed/uncertain delivery success styling | **Fixed** | Corrected before selection: three client failures/one pass; after: four pass. Real failed/uncertain DB receipts rendered through the actual page/API/service with only dispatch mocked. Uncertainty survives proposal refresh and offers no new-delivery action. |
| Newly reproduced webchat deep-link mismatch | **Fixed** | `?channel=web` selected email and prepare returned 404 CONVERSATION_NOT_FOUND. A dedicated browser assertion then reproduced expected web/received email. Allow-list now includes web; real webchat prepare/approve/delivery outcome paths pass without manually selecting the channel. |
| Reconciliation versus historical delivery receipt | **Explicit decision hold** | No outbox/reconciliation semantics changed. Historical uncertain provider observation and later seller reconciliation remain separate. Decide whether the response should expose an additional reconciliation receipt; never rewrite history or redispatch the original key. |
| PROP-D1 explicit public signature affirmation | **Explicit decision hold** | No new API affirmation or approval policy invented. Existing recipient-name fallback and customer confirmation flow remain unchanged. |
| P3 legacy implementation consolidation | **Awaiting fixture/parity dependency** | Caller inventory confirmed canonical mounted delivery/approval/revision paths. Legacy exports remain used by older direct-call tests and have different contracts. The 19 fixture/context failures prevent trustworthy parity acceptance for retirement; no separate functionality was deleted. Proposed next step is repair those fixtures, prove parity/required distinctions, then retire or adapt only redundant exports in this same chat. |
| Alleged stale line-items overwrite | **Withdrawn/resolved hypothesis** | Unsupported expectedRevision is rejected with 400 without mutation; editor's canonical versioned PUT rejects stale saves with 409. API uniformity is optional design work, not this reproduced defect. |
| Missing server PDF output route | **Withdrawn/resolved hypothesis** | Current caller uses shared client ProposalDocument/jsPDF. Both compiled public browser/PDF journeys pass. No current caller requires `/:id/pdf`. |
| Multiple durable defaults | **Resolved invariant concern** | Existing unique index held before and after; the reproduced defect was generic 500, corrected above. |
| Historical editor restore/save and eight first-pass proposal defects | **Integrated/resolved, regression retained** | All 38 original real database/HTTP/service/public browser/PDF cases pass on the reconciled source. Existing 28 editor recovery client tests also pass. No original UI-save fix was recreated. |
| Shared areas awaiting integration | **Resolved/superseded** | Their handoffs are ancestors of the reconciled base. This does not claim this chat executed every subsystem's acceptance. |
| Remaining broad coverage gates | **Unrun/reproduce-first** | Full role/module-denial/shell matrix, complete rich DOCX/PDF matrix, scheduler startup/outbound reminders, generic provider worker, actual onboarding boundary and full CI remain disclosed; no defect is inferred solely from absence of coverage. |

## Corrections and exact boundaries

### 1. Default selection serialization

POST/PUT `/api/proposals/templates[/:id]`, mounted by `server/routes/proposals.routes.ts:83–84`, call `ProposalService.createTemplate`/`updateTemplate` through the existing controller.

`server/services/ProposalService.ts:34` takes one transaction-scoped advisory lock keyed by immutable business profile and owner before reading/clearing/inserting a default. Create uses it at line 1068; update at line 1142. It handles the important no-current-default race. PostgreSQL retains the existing uniqueness invariant and releases the lock on commit/rollback. No global lock, ownership broadening or new migration was added.

Before: eight real mounted HTTP creates produced 500s; mixed update/create also produced 500s. Two new acceptance cases failed on scalar HTTP statuses. After: all eight distinct creates 201 and durable; mixed four updates/four creates 200/201; exactly one default in the selected business; another business's default unchanged; cross-business update 404. `defaults-before.{json,log}` and `defaults-after.{json,log}` retain this evidence. Final production-backed suite reruns both.

### 2. Explicit approved default terms in templates

`client/src/components/proposals/TemplateEditor.tsx:32,105,406–417` adds a business-only default checkbox and terms field with empty-default validation. Administrator publication remains distinct. `client/src/app/dashboard/(main)/proposals/templates/page.tsx:278,441` sends the existing isDefault field and shows the persisted default badge. It refetches the actual library after save.

The unchanged `AutomaticSupportProposalService.ts:27` and `ProposalApprovalService.ts:112–123` continue requiring approved default terms and catalog pricing. No terms/pricing guard or AI-send/review policy was weakened. Client before: six pass/two new failures; after: eight pass. A real compiled template page creates/saves, reloads/edits, retains keyboard-selected checkbox/terms, and the actual commercial guard accepts the offer using persisted catalog data. That is eligibility acceptance, not execution of an LLM or automatic send.

### 3. Mobile wizard labels without save/recovery changes

`client/src/components/proposals/ProposalEditor.tsx:310` gives whole step buttons a wrapping basis and keeps their labels intact. Only navigation layout changed; save/recovery logic and shared global CSS were not modified.

Before: desktop passed, 390px failed with Customer label height 60px. After: 1440x900 and 390x900 pass, device/viewport scale 1. Each journey also saves A, advances the revision through another authorized update, rejects stale B with 409, reloads recovery, holds a real Restore GET response, chooses Use current, edits C, releases the late response and proves C persisted. Keyboard Back navigation and no horizontal overflow pass. The 28 existing client recovery tests also pass.

### 4. Honest delivery outcome presentation

`client/src/components/proposals/ProposalDeliveryPanel.tsx:44,129–142` retains provider error/receipt data and renders sent as success, failed as a destructive alert, pending as pending and uncertain as an unconfirmed warning. Pending/uncertain states do not offer a fresh delivery. Definitive failure offers explicit review; sent retains explicit next-delivery functionality. The result is also rendered after the parent refresh changes status to delivery_unknown, rather than disappearing behind the non-editable return.

No claim, idempotency, refund, reconciliation or generic worker policy changed. Client tests: corrected baseline three fail/one pass, fixed four pass. Browser cases follow actual prepare/approve/send routes, real RLS/claims/outbox persistence and parent refresh; only the external dispatch seam returns a synthetic definite or uncertain failure. Both cases verify visible state/provider detail, correct durable proposal status and exactly one dispatch call.

### 5. Newly found webchat navigation mismatch

`client/src/app/dashboard/(main)/proposals/[id]/page.tsx:30,66` previously rejected web from its initial-channel allow-list even though the editor links with `?channel=web` and API/panel support it. This selected email for a bound web conversation; real prepare returned 404 CONVERSATION_NOT_FOUND. A dedicated browser regression confirmed expected web/received email. Adding web to the existing allow-list is the only product change. The focused after run passed the deep-link case and both real persisted delivery-outcome cases. No new channel or provider capability was invented.

## Final exact-source verification

Run on the rebased source a73dd61e + these corrections:

- Server: **201 passed, zero failed, 59 skipped, 260 selected**, 13 passing/three guarded skipped suites. `final-server.{json,log}`.
- Client: **44 passed, zero failed**, four suites. `final-client.log`.
- Combined executed passes: **245**. The 59 skips are not passes.
- The server result includes **46 real database/HTTP/service/browser cases**: all 38 original integrated cases plus eight new cases. There are **eight browser journeys against the compiled production Next UI**: two original public/PDF, one template/default, two editor viewport/recovery, two persisted delivery failures and one webchat deep link. Other server tests are related units/mocked-boundary checks, not claimed as real provider acceptance.
- Client production webpack build passed. The three newly integrated v8 changes were server-only; a Git comparison proved no client/shared byte differences between production-build source and the rebased source. The production browser run used that exact compiled UI against the rebased mounted server/services.
- API and worker builds passed again after rebase. Changed source/tests passed ESLint and Git diff whitespace checks.
- Client typecheck passed. Server typecheck reports only the two pre-existing `server/tests/settings.test.ts:201,222` fixture errors; no changed-file errors remain. Full repository typecheck/CI is not green.
- The 59 old PostgreSQL cases were not enabled in this final selection. Their separately executed audit result remains **40 passed / 19 fixture/context failures**, with exact case list in the preserved audit. Workspace 14/19, delivery 26/27, approvals 0/13. No readiness protection was weakened to make those fixtures pass.

Server command, from server/, under env -i with only synthetic local JWT/Redis/DB settings:

```sh
NODE_OPTIONS=--experimental-vm-modules \
PROPOSAL_AUDIT_DATABASE_URL='<loopback disposable proposal_audit_pass2 DSN>' \
PROPOSAL_AUDIT_BROWSER_URL=http://127.0.0.1:53000 \
./node_modules/.bin/jest --runInBand tests/*roposal*.test.ts --json
```

Client command: `vitest run src/__tests__/proposalDeliveryOutcome.test.tsx src/__tests__/proposalTemplateExperience.test.tsx src/__tests__/proposalEditorSaveRecovery.test.tsx src/__tests__/proposalSettings.test.tsx`. Typechecks: server `tsc --noEmit`; client `tsc --noEmit -p tsconfig.typecheck.json`. Production UI: isolated `next build --webpack`, then local production Next server. This tests compiled UI, not a deployed/packaged standalone installation.

## Mocks, isolation and limits

Real: fresh disposable PostgreSQL with 331 migrations, runtime RLS, JWT/auth/business/billing middleware, actual mounted proposals router, actual services, durable claims/outbox and browser Next proxy. New concurrent tests retain tenant isolation. Redis is disposable and loopback; no generic worker/provider send is executed by these fixes.

Mocked: external delivery dispatch (the mounted handler delegates to the real ProposalDeliveryService with only dispatch replaced), notifications, outbound email/identity helpers, LLM/knowledge gateway, credit effects and static synthetic branding. Ancillary browser shell reads (platform access display, preferences, profile list, organizations/wallet/notifications/assistant catalog) are mocked. Auth/me and every proposal API request are real. Browser HTTP external origins and external WebSockets are blocked; only loopback WebSockets may connect. Local progress WebSocket is unavailable and can log 404; realtime is not claimed validated. Conversation-activity shell data is not covered by this proposal-router harness and can show its error state.

Tracked env files were temporarily excluded from this isolated worktree during final execution; all app/DB/Redis/public URLs and secrets were supplied as synthetic loopback fixtures. The original checkout was preserved. An early production build was stopped after noticing tracked public production URLs, before any production-browser use, then rebuilt with fully isolated configuration. No provider send or customer/financial effect occurred. Temporary generated Next type paths and fixture configuration are not part of the patch.

Exploratory test setup failures remain in evidence and are not counted as product defects or fix acceptance: commercial guard initially received the create-response row rather than a full GET document; one outcome-test refresh initially ran at approval instead of after send; a precise label selector was replaced with the actual panel control; closing all development WebSockets interfered with Next HMR and was corrected to permit only loopback sockets. The deep-link defect was separately reproduced with expected web/received email after fixture corrections. Final production checks pass without those development-only assumptions.

Still unrun: complete role/admin/support/module-denial matrix; full shell/realtime integration; complete rich/malicious DOCX and PDF pagination/image/font combinations; full scheduler startup/outbound reminders; actual onboarding boundary; external provider accounts/deliverability/paid credits; standalone deployment packaging; full repository CI. No proposal object-storage write path exists in the inspected implementation, so none is claimed tested. Parent-reported broader integration checks are distinct from this executed evidence.

## Local source sequence and publication scope

The retained rebased sequence is `2d589368` (default lock), `2cc9abec` (default UI), `e3473432` (mobile labels), `ddf97733` (delivery outcomes), `08aab068` (webchat deep link). Original pre-rebase equivalents and failing-before artifacts are preserved locally. The final handoff combines the complete corrected source/test bytes; intermediate audit/typing failures are not published as independently ready commits.

Final runtime/test manifest: ProposalService; TemplateEditor; template library page; ProposalEditor; ProposalDeliveryPanel; proposal detail page; proposalTemplateExperience client tests; new proposalDeliveryOutcome client tests; new proposalTemplateDefaultsPostgres integrated tests. This report is the tenth file. No unrelated support/analytics changes, dependency manifests, env files, migrations, generic delivery worker or deployment triggers are in the outgoing patch.
