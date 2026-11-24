# Dashboard and agent operations

Implemented against the user-approved `goal-objective.md` attachment. All eight requested areas are implemented and locally verified. This work has not been pushed or deployed; production contacts, campaigns and provider credentials were not changed by these checks.

Baseline: `origin/v8` at `92cb9a4c6383edb1276a2e2f468834cb01cfaf09`. Branch: `codex/dashboard-agent-operations-20261102`, in the `dashboard-agent-operations/salesmarketing` worktree. The retained implementation commits are `3c2573984`, `fa039d69e`, `bac81c3f6` and `03506403a`; the final retry, engagement and export stage follows them.

## Completion checklist

| Area | Implemented behavior | Verification |
| --- | --- | --- |
| Excel analysis and import | Multiple Excel/CSV files and worksheets, duplicate-file detection, normalized phone/email identities, mapping and issue-review drawers, explicit import, durable progress and resumable chunks | Six actual workbooks analyzed read-only; parser, storage/RLS, quota and real CRM importer tests; browser upload-to-import |
| Unified campaign reporting | One canonical dashboard/agent service with campaign, prepared campaign, import, workspace, channel, account, date and message-kind filters; receipts, responding customers, failure groups and retry times | Native PostgreSQL reconciliation and scoped-agent tests; desktop report browser flow |
| Campaign preparation | Full imported audience, exact account, approved template and values, send schedule and ordered follow-ups saved into an owned draft; opens the existing populated composer review | Native preparation/idempotency fixtures including 575 recipients; composer UI tests; browser template drawer, 12-hour follow-up and review |
| Queue management | Eligibility and exclusion preview, original deadlines, explicit fingerprint-bound confirmation, durable existing-intent recovery and resumable receipts | Native retry/queue tests, authority/expiry/cooldown/race checks; browser recovery with outbound intent count unchanged |
| Reports and downloads | PDF, Word, Excel and offline conversation HTML from one immutable timestamped snapshot; authenticated downloads, quota accounting, expiry and resume | Native snapshot/permission/resume tests; actual format generation and browser downloads; Word and PDF rendering inspected |
| Customer engagement | Authoritative CRM identity reconciliation, typed replies, quick replies, menus, recorded links and verified booking actions; paged protected history | Merge-chain, account, audience and engagement PostgreSQL fixtures; desktop history drawer and mobile browser view |
| Assistant diagnostics | Existing readiness and diagnostics exposed through agents, with draft/published/runtime distinctions and exact settings links | Module/scope and diagnostics tool tests using existing application services |
| Results and navigation | Business-bound result cards, campaign/contact/download actions, live operation progress, recoverable errors; every new operation wired into routing and registries | Agent contract/routing/grounding checks, UI business-switch and link checks, browser navigation |

## Application entry points

- Contacts → Import opens `/dashboard/crm/import/analyze`. Upload files, check counts and mappings, review ambiguous rows, then explicitly import selected ready contacts.
- An imported audience can open `/dashboard/outreach/prepare`. Saving preparation opens `/dashboard/outreach/prepared/:id` in the existing completed composer review. Recipient consent and sending remain explicit in that review.
- Outreach → Reports opens `/dashboard/outreach/reports`. Filters are shared with `/dashboard/outreach/engagement`, `/dashboard/outreach/retries` and report generation.
- Report downloads open `/dashboard/outreach/reports/exports/:id`; all four formats use the displayed saved snapshot. Resume generation preserves that snapshot and files already completed.
- Customer history opens in a drawer with the existing inbox link. Assistant diagnostics link directly to the assistant and failing settings section.

Agents use the same services as these APIs. Tools include:

- `list_contact_workbooks`, `analyze_contact_files`, `get_dashboard_operation`, `review_contact_import`.
- `analytics_query` for the canonical campaign report and `query_assistant_diagnostics` for readiness.
- `get_outreach_preparation_options`, `prepare_outreach_campaign`, `get_prepared_outreach`.
- `preview_outreach_retries`, `get_outreach_retry_preview`.
- `query_campaign_customers`, `query_campaign_history`.
- `create_campaign_export`, `get_campaign_export`.

Import and retry tools prepare explicit dashboard reviews. Preparing a campaign does not send it. Agents can produce scoped results and progress cards without obtaining arbitrary SQL, SSH or file-path access. Agent file analysis accepts exact owned StorageService IDs, rather than arbitrary local paths or URLs.

## Data and recovery invariants

- Every read, staged file, operation, export and mutation is pinned to the authenticated business and actor. Background jobs retain all five original business/billing identity fields. Revoked authority does not fall back to the business owner.
- Analysis and reporting do not import contacts, send messages, refresh providers or mutate customer records implicitly. Read-only agent turns expose no delivery tools.
- Canonical reporting reconciles current outreach messages, legacy jobs and sent-message projections without counting a provider message or durable intent twice. Legacy activity `totalSent` now consistently means provider accepted; `totalMessages` includes queued and failed intents.
- Provider acceptance includes delivered messages and messages awaiting a receipt. A missing receipt is neither a confirmed delivery nor permission to resend. UI, agent facts and all export formats preserve this distinction.
- Customer totals follow authoritative CRM merge roots, saved channel aliases and conversation contact links. No fuzzy name/phone/email matching merges customer identities. Replies must match the customer, channel and original receiving account after the recorded send. A reply alone does not prove interest in the offer.
- Shared email addresses never merge distinct phone recipients during import. Dates in phone columns and ambiguous existing identities require review.
- Saved preparation uses its own report filter, durable review hash, stable bulk identity and launch receipt. Lost cache, reloads and repeated requests cannot silently create another batch. An ambiguous launch remains held for report review.
- Retry previews expire after five minutes. Confirmation rechecks current receipts, versions, authority, policy and original sending expiry. Accepted, delivered, active, uncertain, expired and unsafe historical records are excluded.
- Recovery updates existing send intents and reuses stable BullMQ jobs. It never creates replacement outreach records. It preserves a later saved schedule/provider cooldown and email RFC identity. Eligible WhatsApp 131049 recovery requires the scoped failure evidence, original approved template and consent; its next attempt is at least four hours later and respects any longer deadline.
- Recovery receipts, outbox state and cursor checkpoints survive interruption. An unconfirmed preview cannot be resumed as a confirmed recovery. A duplicate worker job cannot reset another live sending claim.
- Operations and staged files expire after 30 days. Immutable input bytes are hash-deduplicated within the business and actor, charged through the existing organization storage ledger, and released after the final reference expires. Upload limits protect memory/storage; worker batches do not impose a 10,000-contact product cap. The legacy CSV endpoint queues larger files instead of rejecting them.
- Exports capture the canonical report, complete customer set and protected history in one repeatable-read snapshot. Persisted snapshot bytes are the sole input for every format and for resumed generation. Downloads are private, authenticated and scoped; files and snapshots have a 100 MB resource budget and 30-day expiry.
- Conversation text is privacy-masked and HTML/XML escaped. Excel formula-like text remains text; long conversation values are split into numbered cells without truncation. Offline HTML has no external resources or scripts. Report rendering disables scripts and external network access.
- Typed messages, quick replies, menu selections and other native events remain distinct. Recorded link events can include scanners; bookings require a verified attributed record. Phone-call button clicks and untracked WhatsApp URL clicks are explicitly unavailable, not zero.

## Verification recorded November 2, 2026

The latest complete server run passed **331 checks across 16 suites**, with one optional PDF-render test skipped in that run. The actual-render suite separately passed **all four checks** with system Chrome. A final four-suite report/format/analytics/queue run passed **19 checks**, with the same optional render check skipped. Focused final card tests passed **six server checks**. These overlapping runs must not be summed.

Covered suites include `campaignReportingPostgres`, `campaignReportFormats`, `dashboardOperationsPostgres`, `dashboardAgentOperations`, `outreachRetryManagementPostgres`, `outreachQueuePostgres`, `analyticsScopePostgres`, `contactWorkbookAnalysis`, `outreachImportSourcesPostgres`, `outreachCreationFollowUps`, `outreachCreationOptionsReadiness`, `emailRateLimitWorker`, `semanticRouterRegression`, `outreachReadOnlyAgent`, `agentToolContract` and `responseGrounding`.

- Native operation tests execute migration 580, real ownership guards, RLS and storage reserve/release functions under an unprivileged business runtime. They cover immutable reviews, concurrent claims, interrupted chunks, 10,001 contacts, expired inputs, quota rollback and recovery under the original actor.
- The real CRM importer was separately checked for replay without duplicate contacts, normalized local/+91 identities, ambiguous identities, email-only membership and a 575-recipient synthetic audience.
- Native export tests prove that resuming after live data changes reuses the saved snapshot and quota reservations. Retry tests cover rejected unconfirmed resumes, accepted-message exclusions, late receipts, preserved later schedules, RFC IDs, missing Redis, expiration and revoked authority.
- The obsolete sent-message-only analytics fixture now uses the canonical service and model-derived temporary fixtures; it does not copy or depend on public production tables.
- The complete six-suite UI run passed **80 checks**. A subsequent focused card run passed **five checks**, including valid campaign/retry/download links with IDs and query parameters. Both client and server TypeScript checks passed. Changed server/client ESLint checks passed. `git diff --check` passed.

`dashboardOperationsBrowser.test.ts` passed its complete desktop/mobile story against actual Next pages, Express feature controllers, parser, report/engagement/preparation/export/retry services and isolated PostgreSQL/RLS. It uploaded two identical multi-sheet workbooks, detected the copy, reviewed/imported three synthetic contacts, selected an approved synthetic template in the drawer, saved a 12-hour follow-up, opened the populated composer review, inspected customer history, recovered an existing intent and downloaded all four actual report formats. There were no browser JavaScript errors, worker errors, unexpected auxiliary routes or HTTP 5xx responses. The original four outbound intents remained four; no provider send occurred.

Browser-test boundaries: the authenticated session and provider catalog are synthetic; the browser harness uses a synthetic CRM-import adapter, with the real importer verified separately. Delivery dispatch is stubbed and no live provider is contacted. Agent registry/routing/grounding tests verify tools and receipts without paid live-model inference. This is local acceptance evidence, not a production smoke test.

Browser evidence and images are in `.local/dashboard-agent-operations/browser/`. Actual downloaded PDF/Word/Excel/HTML files were validated. Word was rendered with hidden Microsoft Word and inspected after converting to page images; PDF output was rendered with Poppler. The bundled document renderer could not run because LibreOffice is unavailable on this Windows host; native Word supplied the visual check instead.

The actual six workbooks were only read for analysis: **46,396 source rows**, five distinct files plus one exact copy, **30,300 unique plausible phone entries** (30,216 Indian mobile format), **8,874 unique emails**, **39,124 unique contacts**, 6,916 duplicate rows and 356 rows without a usable identifier. The previous manual contact count was one higher because Corporate Database / Zomato Guest Data 2025 row 851 contains an Excel date in the phone column. No actual workbook contacts were imported by development verification.

## Deployment handoff

1. Integrate this branch through the normal review/release process. This implementation has not been pushed, merged into v8 or deployed by the current goal.
2. Run migration **580** before starting code that reads or processes dashboard operations. It adds operation/file/row state, ownership/storage guards and reporting indexes; this branch's migration includes campaign exports, preparation and retry recovery.
3. Deploy both the API and worker builds, then the matching client. Existing Redis/BullMQ and the per-business operation/outreach recovery cron must run. Staged files use the existing organization storage ledger; do not bypass reservations or RLS.
4. PDF workers need the existing supported system Chromium setup. No additional package dependencies or lockfile changes were introduced for the report formats.
5. Smoke-test scoped read-only reports, a synthetic file preview, a prepared review and authenticated export downloads after deployment. Confirm runtime readiness and provider authorization before any separately authorized real delivery.

All database acceptance used the isolated loopback PostgreSQL 18 cluster on port 55437, database `implementation_synthetic`; no production database reads or writes were required for this implementation. SSH remains appropriate for deployments and infrastructure incidents, while the requested operational workflows now have application services, dashboard views and agent tools.

Local environment note: H: filled during a generated webpack-cache write. Automatic approval review rejected deletion of that test cache, so it was left in place. Browser acceptance completed using a fresh preview output on C:. This does not change application source or deployment requirements, but local disk capacity may need attention before further builds.
