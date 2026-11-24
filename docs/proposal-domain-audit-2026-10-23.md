# Proposal domain audit — 23 October 2026

## Boundaries and provenance

This chat owns catalog, templates, line items, documents/PDF, approvals,
proposal delivery receipts, public proposal capability/response lifecycle,
idempotency, proposal follow-ups and CRM transitions. The existing proposal UI
save fix and generic email worker remain with their original owners. No shared
tenancy/authentication/billing core changes, Pages, pushes or deployments are
authorized during the initial local-only phase. The later publication
authorization and its narrower remote target are recorded below.

Saved checkout: `09fe888ec8bdd3fa12ccee0e047cd1d876306222`, clean branch `work`.
Fetched and fast-forwarded audited v8 base on 23 October:
`35d6107b50aaabf238a2fc1fa39ff172bdf6b8f7`. No proposal service/controller or
public route changes occurred between the saved and fetched revisions. All
18 new regressions were repeated before implementation on this exact base:
**5 passed / 13 failed**, reproducing all four findings below.

No AGENTS.md or .agents/skills files were found in the accessible checkout or
workspace. Saved startup notes were read; their old instruction to preserve
source is superseded by the explicit audit/remediation request. The all-worker
startup script was not used. External providers are forbidden in this harness.
The GitHub REST API request to `api.github.com/repos/KumarLakshmanan/salesmarketing/commits/v8`
received CONNECT HTTP 403; that API path was stopped. Git smart HTTP is a
separate permitted transfer that completed successfully. No REST API retry or
platform access bypass was attempted.

## Findings recorded before implementation

Definitions: **reproduced** means observed using executing application code;
**source-demonstrated** means a concrete code path without a completed runtime
reproduction; **static concern** needs further evidence; **product decision**
needs an intended policy; **unrun** has no execution evidence in this audit.

| Priority / ID | Evidence classification | Finding and exact reproduction | Initial result |
| --- | --- | --- | --- |
| P1 PROP-01 | Reproduced, real HTTP + PostgreSQL + runtime RLS | Seed a sent offer with a valid 43-character token. Hold an UPDATE lock changing its token hash to NULL (or token expiry to the past). Start POST `/public/:token/accept`, `/reject` or `/view`. Wait until `pg_stat_activity` proves the handler's UPDATE is blocked, then commit revocation. `ProposalService` writes by proposal ID/status without rechecking the capability in the mutation. | All six variants return 200 and mutate the offer after revocation/expiry. Expected 404 and no mutation. |
| P2 PROP-02 | Reproduced, real HTTP + PostgreSQL + runtime RLS | Set `valid_until=NOW()-INTERVAL '1 second'` while status is sent and token expiry is in the future. POST `/public/:token/feedback` with a valid question/request key. `ProposalLifecycleService.publicRecord` reads only token expiry and submit checks only status. | 201; feedback is inserted, offer becomes viewed, follow-ups pause and notification is attempted. Expected 410 without these effects. |
| P2 PROP-03 | Reproduced, real HTTP + PostgreSQL + runtime RLS | Submit eight concurrent identical feedback POSTs with one request key; then reuse a key with changed content; separately replay a successful request after acceptance. | One DB row but eight notifications; changed payload returns old row with 201; replay after acceptance returns 409. Expected one set of effects, 409 for changed payload, stable receipt for exact replay. |
| P2 PROP-04 | Reproduced, real HTTP + PostgreSQL + runtime RLS | Seed accepted/rejected/superseded state with valid token and past offer date. POST `/public/:token/view`, then compare GET and persisted state. | View response reports expired for all three; GET and DB retain the terminal state. Expected consistent terminal state. |
| P2 TEST-01 | Reproduced test coverage limitation | Run existing proposal workspace/approval/delivery PostgreSQL suites on a newly migrated database. Older fixture tables omit business-scoped conflict indexes/columns and mandatory organization context. | Baseline selection: 81 pass, 19 fail across six suites. Failures include missing business_profile_id/review policy table, mandatory billing organization, and an SMS fixture mismatch. Do not report these suites as fully passing or reinterpret all fixture failures as product defects. |
| Decision PROP-D1 | Product decision | Signature-required public acceptance falls back to the stored recipient name when the request omits a name. UI prefills that name and asks for confirmation. | Whether explicit signature entry/affirmation must also be enforced by the API requires a product/legal decision; no stricter contract is invented here. |
| Concern PROP-C1 | Static concern | Follow-up resume and scheduling, CRM event replay, template-default concurrency, and delivery recovery need additional lifecycle/failure checks. | Inventory only at this checkpoint; no defect claim. |

Initial new regression suite: **5 passed / 13 failed / 18 total**. The passing
checks cover valid view/read, revoked and expired tokens at request entry,
same-owner cross-business RLS isolation, and competing accept/reject with winning
response replay. Source has not yet been changed at this checkpoint.

## Inventory verified in the checkout

| Surface | Implementation |
| --- | --- |
| Seller pages | `/dashboard/proposals`, `/new`, `/[id]`, `/[id]/edit`, `/catalog`, `/templates`, `/settings`, `/analytics`; team review `/support/proposal-reviews`; administrator template library |
| Customer page | `/proposal/[token]`: view tracking, shared document renderer, PDF download, acceptance/rejection, question/change request thread, replacement link |
| Public HTTP | GET `/api/proposals/public/:token`, POST `/view`, `/accept`, `/reject`; GET/POST `/feedback`; public business capability scope precedes seller authentication |
| Seller HTTP | Proposal list/create/generate/suggest/brand/detail/update/delete; source/resolve; catalog create/update; templates/import/favorites; prepare/approve/send/recover-delivery; approvals/timeline/versions/related/performance/analytics; comments; reminders; follow-ups preview/configure/pause; feedback reply/resolve; revision; review policy; onboarding resources |
| Domain services | `ProposalService`, `ProposalWorkspaceService`, `ProposalDocumentService`, `ProposalApprovalService`, `ProposalDeliveryService`, `ProposalLifecycleService`, `ProposalTemplateLibraryService`, `AdminProposalTemplateService`, `AutomaticSupportProposalService` |
| Jobs | `processProposalEvents`: expiry, stale delivery/follow-up reconciliation, CRM stage/activity projection, onboarding ticket creation and retry. `ReminderService`: proposal owner reminders and customer follow-ups. Delivery outbox stores durable provider receipt/uncertain outcome. Generic email worker is excluded. |
| Models | `proposals`, `proposal_line_items`, `proposal_templates`, `proposal_catalog`, `proposal_versions`, `proposal_events`, `proposal_approvals`, `proposal_review_policies`, `proposal_feedback`, `proposal_reminders`, `proposal_comments`, template favorites/audit; related delivery outbox, CRM contacts/activities, support tickets/team members |
| Gates/settings | Proposals module access; seller authentication and business membership/permissions/RLS; support proposal tool configuration; review-before-AI-send default true; team review amount/discount/manual pricing rules; automatic approved catalog/default terms checks; delivery provider binding/readiness; signature/offer/token expiry; onboarding opt-out and plan; per-reminder timezone/status/pause-on-reply |
| Storage/PDF | Version snapshots and template snapshots are JSON in PostgreSQL. PDF is generated in-browser by jsPDF from the same `ProposalDocument` element. No proposal object-storage write path was found; DOCX import uses in-memory upload/parsing. |

## Coverage matrix at the initial findings checkpoint

| Area | Executed evidence | Remaining / classification |
| --- | --- | --- |
| Public token validation and business permission | Actual HTTP handlers, public capability middleware, unprivileged runtime role and full migrated schema | Race defects reproduced as PROP-01; seller login/module permission browser journey unrun |
| Public response concurrency/retry | Concurrent accept vs reject; same-winning-action replay, no repeat notification | Pass; revoked/expired-after-lookup variants fail |
| Public feedback | Concurrent requests, changed payload, expiry, terminal retry through HTTP | PROP-02/03 reproduced |
| Public view/reload | GET and POST compared to durable DB status | PROP-04 reproduced; rendered reload unrun |
| Catalog/line item pricing | Existing unit/document and partial PostgreSQL baseline | Existing fixtures have limitations; additional actual integrated checks pending |
| Templates/version snapshots | Existing template/document suite passes; older workspace fixture partial | DOCX import, concurrent default selection and version browser journey unrun |
| Approval and stale review | Existing approval PostgreSQL baseline attempted | Fixture drift blocks most checks; real migrated schema checks pending |
| Delivery receipts/failure/retry | Existing dependency-injected delivery suite passes; real DB delivery baseline mostly passes | External providers mocked; no real sends. Full account binding/browser journey unrun |
| Follow-ups/cancellation | Older workspace tests partially pass; synthetic Redis responds PONG | Actual worker execution and cancellation race unrun; generic worker excluded |
| CRM transitions/onboarding retry | Existing workspace suite partially passes | Full actual CRM service transaction/retry test pending; no false completion from a CRM mock |
| Rendered responsiveness/PDF | None yet | Unrun at 100% zoom / real desktop/mobile widths; actual PDF content/download unrun |
| Object storage | No domain write path in inspected implementation | Not applicable to version/PDF persistence; no object service claimed tested |

## Reproduction environment

### Additional findings recorded before their fixes

| Priority / ID | Evidence | Reproduction and observed result |
| --- | --- | --- |
| P1 PROP-05 | Reproduced with real CRMService and runtime RLS | Attach a synthetic CRM contact in `new`, accept through the public HTTP handler, then execute `processProposalEvents({userId,proposalId})`. The outer proposal event transaction inserts a CRM activity (acquiring a foreign-key KEY SHARE contact lock) before `CRMService.updatePipelineStatus` opens another transaction and selects that contact FOR UPDATE. `pg_stat_activity` showed the inner connection waiting on the outer transaction, which awaited that inner call. The test timed out; the synthetic query was canceled, then a bounded lock-timeout regression reproduced the unprocessed event and unchanged contact. The older suite mocked CRMService and could not detect this. No shared CRM file change is needed: order CRM synchronization before proposal-side contact-reference writes. |
| P2 PROP-06 | Reproduced in Chromium at 390px, scale 1 | A valid proposal number near the allowed 50-character maximum shares a non-wrapping flex row with the company name. `.proposal-brand strong` shrinks until the word “Synthetic” occupies two separate line rectangles; screenshot shows fragmented company words. At 1440px it fits. The browser regression asserts that the ordinary company word stays intact. The document header should wrap its metadata at small widths. |
| P2 PROP-07 | Reproduced with migrated PostgreSQL and the actual event processor | Create pending, paused and future-snoozed customer follow-ups, set the offer to accepted/rejected/expired, and process its events. In each of three regressions only pending is cancelled; paused and snoozed remain active lifecycle records because `reconcileProposalExpiry` filters only pending/processing. Expected all three to cancel on a terminal response/expiry. |
| P1 PROP-08 | Reproduced with lock-controlled HTTP requests and database clock | Set token expiry 500ms ahead. Hold SELECT FOR UPDATE on the unchanged proposal, start feedback/accept/reject/view, verify the request is waiting, wait until the database clock passes token expiry, then release. Feedback returned 201 and the other actions 200 after expiry. SQL predicates can run before the row-lock wait, and NOW() is fixed at transaction start. Expected 404 and no effects. All actions require a post-lock elapsed-time check and must retain that lock through mutation. |

The rendered customer journey itself passed at 1440px and 390px before the
additional branding assertion: real Next page → public HTTP → scoped PostgreSQL
→ viewed, feedback/pause, PDF download with extracted title and item text,
acceptance and reload. No API response mocks were used for these browser tests.
The brand-layout assertion then failed at 390px (expected one word rectangle,
received two). This distinguishes an actual rendering defect from the passing
no-horizontal-overflow check.

Fresh disposable PostgreSQL 16/pgvector container `proposal-audit-pg` on loopback
port 55432, tmpfs data; database name `proposal_audit`. Fresh disposable Redis
container `proposal-audit-redis` on loopback port 56379 with persistence disabled.
All 318 audited-base migrations were applied with explicit local database variables
under `env -i`. No inherited application environment, production DSNs, accounts
or customer data were used. Synthetic fixture administration uses the documented
system database context; application operations use `createBusinessScopedPool`
and `salesmarketing_business_runtime`, with RLS enabled. No auth rules are
disabled. Email/AI/knowledge/credit boundaries throw if unexpectedly invoked;
notification calls are captured locally. The test guards localhost and the
disposable database name before writing fixtures.

```sh
env -i PATH="$PATH" HOME=/tmp NODE_ENV=test \
  NODE_OPTIONS=--experimental-vm-modules \
  PROPOSAL_AUDIT_DATABASE_URL='<disposable local proposal_audit DSN>' \
  ./node_modules/.bin/jest --runInBand tests/proposalPublicLifecyclePostgres.test.ts
```

Raw logs are retained locally under `/tmp/proposal-public-base-before.log`, `/tmp/proposal-public-before.log` and
`/tmp/proposal-audit-baseline.log`; final handoff evidence will record the audited
base, remediation commits, exact changed files and bundle checksum/size.

## Final remediation and verification

All eight reproduced findings above were remediated sequentially in this chat.
Final verified source commit: `512fe11db084b8ad0f5cb8f227a0d8fc10b7269b`.
The final documentation commit and portable bundle metadata are recorded in the
handoff manifest alongside this report. No migration was needed; 420–429 remain
unused. The proposal UI save implementation, generic email worker and shared
CRM/tenancy/authentication/billing core files were not changed.

| Finding | Local remediation commits | Result |
| --- | --- | --- |
| PROP-01 capability revocation/expiry races | `11d7e6449f0d268b1f7a87fc7f40eb4d4b131877`, completed by `512fe11db084b8ad0f5cb8f227a0d8fc10b7269b` | Token-bound mutations; row lock acquired before post-wait validation and retained through writes; six revocation/changed-expiry races pass. |
| PROP-02 expired offer feedback | `345784525c813b54ccc7620f992b2672218c01ea` | 410 with no new feedback, reminder pause or notification. |
| PROP-03 feedback idempotency | `941b000a09b8f096723425003c1d30de03e0d1e2` | Stable receipt replay, one notification for concurrent identical requests, 409 on changed payload, replay after terminal response without repeating effects. |
| PROP-04 terminal view state | `fac21b57282b3b3ec4bab7eb932fbe129504aef9`, retained in final serialized implementation | Accepted/rejected/superseded remain authoritative. |
| PROP-05 CRM self-blocking | `51efaf31568d581fd3138fb5969946a2205e41b8` | CRM synchronization precedes proposal-side contact FK writes. Actual CRM tests pass for linked and inferred contact, plus forced activity-write failure/retry. CRM commits independently; a later proposal projection failure leaves its event pending, and retry repairs it without duplicating the transition. |
| PROP-06 narrow document branding | `88c350c8df2312dceca50f0665ab386efe9b177b` | Header wraps long metadata, preserving readable company words. Desktop/mobile rendered and PDF checks pass. |
| PROP-07 terminal follow-up cancellation | `87a4fb2b7ddd26298b7383cc9c6323a1eb27753c` | Pending, processing, paused and snoozed reminders cancel after response/expiry. Three terminal-state regressions pass. |
| PROP-08 elapsed token lifetime during lock wait | `d0d11c7d7c0a9fb238d67f906b6887d2ff7f06eb`, `512fe11db084b8ad0f5cb8f227a0d8fc10b7269b` | All four public mutation routes reject expired-after-wait tokens without effects. |

Final exact file manifest relative to the audited base:

1. `client/src/components/proposals/ProposalDocument.tsx`
2. `server/services/ProposalLifecycleService.ts`
3. `server/services/ProposalService.ts`
4. `server/services/ProposalWorkspaceService.ts`
5. `server/tests/proposalPublicLifecyclePostgres.test.ts`
6. `docs/proposal-domain-audit-2026-10-23.md`

### Final coverage matrix

| Area | Final execution evidence | Explicit limit |
| --- | --- | --- |
| Public capabilities and permissions | Real public middleware/controllers, runtime RLS, same-owner cross-business denial; invalid/revoked/expired entry; six changed-capability races; four naturally elapsed-token lock waits | Seller JWT, membership-role/module denial through the complete production app login flow remains unrun. |
| Responses and reload | Competing accept/reject, winning-action replay, terminal late views, real customer acceptance/reload at both viewport sizes | Signature policy decision PROP-D1 remains open; stricter API affirmation was not invented. |
| Feedback and reminders | Eight concurrent requests, changed payload conflict, exact terminal replay, expired offer rejection; follow-up timezone preview/replacement; pause on feedback; terminal cancellation for paused/snoozed/pending | Actual outbound reminder-email worker remains excluded; Redis was an isolated connectivity smoke check, not a claim of worker coverage. |
| Catalog, line items, templates and versions | Six concurrent same-key draft creates; real catalog identity/pricing resolution; retired item rejection; existing quoted price retained after catalog changes; template snapshot retained after template edit; version snapshot and stale update rejection | Catalog editor and template editor seller browser journeys, concurrent default templates and full malformed DOCX import matrix remain unrun/static concerns. |
| Approval and delivery | Real policy save/lookup; two concurrent team decisions; stale review rejection; actual webchat delivery with one durable outbox/message receipt and stable replay; changed-key-payload conflict | External provider account binding/sends are not validated by a real provider. Mocked provider seams cover definite and uncertain failure with persisted DB outcomes and no request-key resend. |
| Cancellation during delivery | Session switched to human mode after durable claim; eligibility rechecked, provider not called, draft/token restored | Generic email worker cancellation/reconciliation remains its original owner's scope. |
| CRM and job retry | Actual CRMService, real RLS, linked/inferred contact, one won transition; deliberately failed proposal activity write and successful idempotent retry | Full worker process was not started; processor invoked directly in persisted business scope. Actual SupportService automatic onboarding creation remains unrun in this new suite (older suite mocks it). |
| Rendered document/PDF | Real Next page → public HTTP → migrated DB at 1440×900 and 390×900, device scale/zoom 1; zero page errors; no horizontal overflow; intact brand word; feedback/pause, acceptance/reload; real PDF bytes and pdftotext title/item content | No full client production build or exhaustive PDF pagination/image/font combinations. No proposal object-storage write path exists in inspected source; object storage is not claimed tested. |

Final related Jest run: **229 passed, 59 skipped, 288 total** across 13 passing
and 3 skipped suites. Of the passing tests, **38 are the new integrated suite**
(36 HTTP/service/database scenarios and two real browser/PDF journeys); **191
are related existing unit tests**, including mocked-provider tests. The old
three PostgreSQL suites were not enabled in the final run: their separately
attempted baseline failures are recorded under TEST-01, not counted as passing.

Commands/evidence:

```sh
# From server/, with only the explicitly supplied disposable local environment:
env -i PATH="$PATH" HOME=/tmp NODE_ENV=test \
  NODE_OPTIONS=--experimental-vm-modules \
  CLIENT_URL=https://proposal-audit.example.test \
  PROPOSAL_AUDIT_DATABASE_URL='<local disposable proposal_audit DSN>' \
  PROPOSAL_AUDIT_BROWSER_URL=http://127.0.0.1:53000 \
  ./node_modules/.bin/jest --runInBand --testPathPatterns 'proposal|Proposal|reminderService'
```

The optional browser tests require Chromium at `/usr/bin/chromium`, pdftotext,
and the real client dev server on port 53000 proxying to the test harness on
58080. It runs with `env -i`, `NEXT_DIST_DIR=.next-proposal-audit`, explicit
loopback API/backend URLs and telemetry disabled. Browser routing aborts every
non-loopback-origin request. The harness never mocks public API responses.
Starting Next added only its generated type paths to client tsconfig; those
temporary generated changes were removed before handoff.

Touched server source/test ESLint and the document component ESLint pass.
API and worker esbuild bundles pass; `git diff --check` passes. Repository-wide
server typecheck remains **failing** with the same two errors in unchanged
`server/tests/settings.test.ts:201` and `:222` seen before these fixes. No
errors are reported for the changed files. Shared test/settings correction is
left to its owner; this is not reported as a clean repository-wide typecheck.

During that initial local-only phase, no production credentials/DSNs, accounts/customer data, external sends/posts,
charges/refunds, paid APIs, security-setting changes, pushes, deployments or
Pages writes were used. The denied GitHub REST API action remains stopped;
the requested Git fetch succeeded independently. The handoff includes an
incremental Git bundle against the exact audited base, with SHA256 and byte
size, plus sanitized reproduction/final logs and synthetic screenshots/PDFs.

## Publication follow-up in this same audit chat

The user subsequently authorized GitHub publication of independently verified
fixes, and the parent limited this chat to
`refs/heads/handoff/audit-20261023-proposals`. No direct v8 push, force push,
deployment, live send, shared generic delivery-worker change or Pages write is
authorized. The previously denied GitHub REST `/commits/v8` read remains
stopped; normal Git fetch/push is separately authorized.

Normal Git transport fetched current v8 as
`c33cab7fece727585abaaaaa8512208413c34c7f`. The original audited base
`35d6107b50aaabf238a2fc1fa39ff172bdf6b8f7` is its ancestor. The only intervening
v8 commit changes hotel/settings authority files, with no overlap in this
six-file proposal patch. The UI handoff resolved exactly to
`75b9bd1dba2775a3677babea6d1280a19b23f758`; its 29 changed files have zero
intersection with this patch. Its proposal editor/save recovery and detail page
changes are not recreated or included here. The generic worker remains with
Campaigns. The local original 12-commit audit history remains on `work`.

The publication branch starts at current v8 and contains a single combined
final patch, rather than publishing historical intermediate commits whose tests
intentionally failed before the next sequential correction. All five outgoing
source/test files are byte-identical to the final original verified files;
only this report adds the publication record. Exact ancestry, file/blob/SHA256
manifest, published commit, remote verification and updated bundle are in the
publication handoff artifacts.

The two checked-in workflows trigger pushes only on `main`; neither is a
deployment workflow. No PR, manual workflow or known deployment trigger is
invoked. External hooks remain unknown. No forbidden hook or REST read was
retried, and unknown hooks are not represented as verified absent.

### Exact publication verification and the 59 legacy cases

Retesting on the publication base produced **229 passed / 59 skipped / 288
total** in the related selection, including **38 new integrated checks** (two
real browser/PDF journeys at normal zoom, 1440×900 and 390×900). The same fresh
318-migration PostgreSQL database and disposable Redis were provisioned under
an explicit cleared environment. Touched lint and API/worker builds pass.
Repository-wide typecheck still reports only the two unchanged settings-test
errors at lines 201 and 222; it is not green.

The 59 skipped cases were then separately enabled, without repairing or
weakening their fixtures. Actual result: **40 passed / 19 failed / 59 total**.
This is a separate run, not a claim that the 59 skipped checks passed.

| Legacy suite | Cases | Separately passed | Failed | Failure evidence |
| --- | ---: | ---: | ---: | --- |
| `proposalWorkspacePostgres.test.ts` | 19 | 14 | 5 | Missing `proposal_review_policies` in the cloned schema; missing business async context in generation; recreated catalog missing `business_profile_id` (two cases); company fixture missing mandatory `billing_organization_id`. |
| `proposalApprovalPostgres.test.ts` | 13 | 0 | 13 | Its handcrafted `proposal_review_policies` table has `user_id` primary key and no `business_profile_id`, whereas the production service uses `ON CONFLICT(business_profile_id,user_id)`. Cases fail before their intended assertions. |
| `proposalDeliveryPostgres.test.ts` | 27 | 26 | 1 | SMS fixture inserts a plaintext QA secret without provider verification or encryption metadata. Current MSG91 readiness requires `providerVerifiedAt`, `encryptionVersion`, `encryptionKeyId`, `encryptedAt`, sender binding and no readiness error. `review.ready` is false; expected true. No credential-security rule was relaxed to make it pass. |

The exact 59 case titles, statuses and failed messages are returned in
`LEGACY-59.md` and the JSON/log evidence. The five failing workspace cases are
webchat draft binding, catalog-constrained AI pricing, stable catalog lookup,
campaign/catalog tool draft creation, and business-profile template inclusion.
The 13 approval failures cover active reviewer selection, immutable requests,
changes requested, concurrent decisions, tenant policy/default automatic sending,
automatic authorization and six negative eligibility variants, and foreign/
inactive/stale decisions. The SMS failure is the reviewed sender/account case.
These failing fixtures and the full-application coverage limits above remain
open. The published patch is scoped verified remediation, not repository-wide
or complete proposal-feature integration clearance.

Remaining product decision: PROP-D1, whether signature-required acceptance must
require fresh explicit name/affirmation at the API rather than falling back to
the persisted recipient name. No new signing contract, dedicated revoke UI/API,
or multi-channel follow-up policy was invented. Seller/member/admin auth browser
journeys, malformed DOCX imports, concurrent template defaults, actual automatic
onboarding and exhaustive PDF image/font/pagination combinations remain unrun.
