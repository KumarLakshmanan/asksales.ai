# Onboarding handoff — 23 October 2026

## Scope and ancestry

Initial audit base: `35d6107b50aaabf238a2fc1fa39ff172bdf6b8f7`. Publication base, fetched explicitly: `c33cab7fece727585abaaaaa8512208413c34c7f`. The five original audit commits were preserved on local v8, then applied without conflicts to `handoff/audit-20261023-onboarding` based on publication v8. All eleven original audit file contents are byte-identical after replay. Parent alone integrates v8; this handoff does not push v8, force push, create a PR, deploy, or change providers/security credentials.

The actual diffs of Tenant `7b54373dd2e9d91c81bd0a90f5dc607b4c08df8b` (55 files), UI `75b9bd1dba2775a3677babea6d1280a19b23f758` (29 files), and Admin `8a502b2a9c0c95091dbebe7095be14704e39c143` (10 files) have **zero file intersections** with the eleven onboarding files. Their branches are not merged into this handoff. File disjointness does not establish integrated ownership-transfer/recovery behavior. Repository workflows were inspected at fetched v8: push triggers are main-only; no workflow changes or hook reads/overrides were performed. External hooks remain unknown.

Notifications was resolved and fetched at `71cc3d7ea7c8e38fba14ef14aa61f2c2609ecc77`. Its 66-file diff against the original audit base also has zero file intersections. The shared-route reproduction, rather than inbox/realtime implementation, was inspected for semantic deduplication as described below.

Parent subsequently identified Notifications publication `3f52a84fb969b317a3ba813df140e7cf78077e08` and assigned its dirty-fields-only form correction and two-tab test to Notifications. Onboarding owns the existing partial-key API merge. Both parties explicitly agree that full stale objects remain unprotected by a partial-key merge; no second concurrency mechanism is added.

## Four confirmed findings and commits

| Finding | Failing before | Fix and passing after | Outgoing fix commit |
| --- | --- | --- | --- |
| P2 SETUP-01: legacy website endpoint rewrites uppercase HTTPS and accepts explicit unsupported schemes into provider work | 3 failing / 6 passing controller tests | Case-insensitive HTTP(S) recognition; reject explicit unsupported schemes before adding HTTPS. 9 controller + 5 onboarding tests pass | `d6c4e6519e4883818f84c01ba615e4ec34b52f0e` |
| P2 SETUP-02: restricted workspace deletion returns 500 rather than archive guidance on PostgreSQL 18 | 1 failing / 16 passing real HTTP/PostgreSQL tests | Recognize SQLSTATE `23001` alongside `23503`; preserve rollback and return 409. 17/17 recovery cases pass | `10eba49d92a6fa2edd9587b6684f357a33fcc093` |
| P2 SETUP-03: concurrent partial notification-preference updates lose an unrelated key | 1 failing / 17 passing real HTTP/PostgreSQL tests; both PUTs return 200 but one false value becomes true | One actor-scoped JSONB merge UPDATE/RETURNING. 18/18 recovery cases pass, including deterministic PostgreSQL row-lock concurrency | `680019ecf78bee5160e9664d5da05f656e6d08b6` |
| P2 SETUP-04: seven preference selectors have no accessible label association | Chromium cannot find Language combobox by field name | Associate each label and trigger by ID. Six fixture-backed Chromium scenarios pass at 390/768/1440 CSS pixels, with save failure/retry/reload and ordinary profile retention | `a97246d8345457571823b8de63b70f2010f8949b` |

Coverage/report commit: `68f694dec9022289a8bd54eec23b9da622f3d2ef`. Original fix IDs, detailed inventory, historical before/after evidence and limits are retained in `workspace-setup-audit-2026-10-23.md`. The final publication-manifest records the final report commit and independently observed remote SHA.

## Exact shared contract for Notifications, through parent

This fix adds **no shared helper**. Its sole implementation entry point is `updateNotificationPreferencesHandler` in `server/controllers/userProfileController.ts`, currently line 200. Route registration is `PUT /api/settings/profile/notification-preferences` in `server/routes/settings.routes.ts:137`. The corresponding GET returns defaults plus saved preferences.

Allowed supplied keys are `emailNotifications`, `leadAlerts`, `campaignUpdates`, and `weeklyReports`; each must be boolean. The actor is `req.user.id`, not the selected business owner. Unknown keys are ignored. Invalid supplied booleans return 400; a missing user returns 404; database errors return 500. One UPDATE merges, in this order, defaults → current stored JSONB (or `{}`) → supplied allowed keys, updates `updatedAt`, and returns the merged object. Unspecified keys and another account's values remain unchanged. No model helper/API or migration changes are required.

The deterministic regression is `preserves concurrent changes to different ordinary notification preferences` in `server/tests/workspaceSetupRecoveryPostgres.test.ts`, currently line 416. A real PostgreSQL lock holds two actual authenticated HTTP UPDATEs until both have reached the database; final GET must retain both edits. It also checks invalid input and another actor's unchanged preferences. This is shared settings storage behavior; inbox/realtime delivery remains Notifications-owned.

Notifications' `server/tests/accountNotificationsPostgres.test.ts` imports this same production handler, registers the canonical settings route and reproduces the same two partial payloads under a real row lock. Its `[coordination] concurrent preference patches retain both opt-outs` is opt-in via `NOTIFICATIONS_SHARED_REPRO=1`. The evidence `qa/notifications-audit/evidence/09-shared-preferences-repro.log` records one lost false value before this patch. This is the same partial-write defect, so reuse outgoing commit `680019ecf78bee5160e9664d5da05f656e6d08b6`; parent should ask Notifications to rerun that retained test after integration. Their full Redis/socket fixture suite has not been run here and was not replaced with a competing patch.

**Coordination limit:** atomic merge protects partial requests that change different keys. Provided keys remain last-writer-wins, with no revision/CAS field. The existing settings form sends its entire loaded notification object. A stale full-object save can therefore overwrite a supplied key despite the atomic merge. Notifications and parent must distinguish that full-form race from this reproduced server partial-update race, and agree changed-fields-only payloads or an explicit revision contract. Reuse this implementation for this route; do not add a competing server read/merge/write patch. No additional concurrency mechanism is introduced here.

The preference-label change is separate, in `client/src/app/dashboard/(main)/settings/preferences/page.tsx`; it changes only seven label/trigger associations. Its regression is `client/e2e/ordinary-preferences-audit.spec.ts`. It does not alter inbox, realtime, language translation, navigation guards or notification delivery.

## Exact source/file manifest

Production changes: `server/controllers/setupController.ts`; `server/controllers/businessProfilesController.ts`; `server/controllers/userProfileController.ts`; `client/src/app/dashboard/(main)/settings/preferences/page.tsx`.

Tests/harness: `server/tests/workspaceWebsiteAnalysisController.test.ts`; `server/tests/workspaceSetupRecoveryPostgres.test.ts`; `client/e2e/ordinary-preferences-audit.spec.ts`; `client/e2e/workspace-setup-audit.spec.ts`; `client/playwright.setup-audit.config.ts`.

Reports/inventory: `docs/workspace-setup-audit-2026-10-23.md`; `docs/workspace-setup-audit-inventory-2026-10-23.txt`; this publication note. The publication manifest contains exact content SHA-256 hashes and commit mappings. No migrations, shared core owner helpers, workflows, hooks or environment/credential files change.

## Pending owner/recovery/transaction contracts

- **Tenant owner recovery — pending integration:** parent integrates the original Tenant branch and tests transfer, revocation and deactivation against setup jobs/drafts and handoffs. No core ownership patch was reimplemented here.
- **SETUP-S01 / D01 — source/static, decision pending:** the analysis commit callback holds the cancellation lock in a transaction but global-db writes run outside that transaction, and knowledge/profile commits are separate. Define transaction propagation and retention/rollback for artifacts already committed. Provider-held late cancellation is covered; all commit interleavings are unrun.
- **SETUP-S02 — source/static, pending:** successful timezone mirroring is covered. Failure/rollback between user and preference writes requires a parent-coordinated shared transaction contract and remains unrun.
- **Redis — denied/unrun:** Redis 7.4.1 source download returned HTTP 403 in the original audit. That target has not been retried or bypassed. Database concurrency plus queue/provider fixtures do not prove Redis durability/restart.
- **Baseline gates — failed:** full lint retains unchanged errors in `server/tests/newSupportPipeline.test.ts:2` and `client/e2e/settings-redesign.spec.ts:14`; full server types retain unchanged outreach mock errors in `server/tests/settings.test.ts:201` and `:222`. Scoped lint, server production types and builds are separately recorded. No unrelated core patch is included to clear those gates.

## Coverage distinction and publication

Original final verification: 98 backend tests (including 24 real JWT/HTTP/PostgreSQL scenarios, two of which drive Chromium), 66 client tests, 36 separate fixture-backed browser scenarios, and server API/worker plus client builds. Actual PostgreSQL 18.4/pgvector and 318 migrations were used. Responsive browser widths are 390, 768 and 1440 at scale 1 and normal zoom. Browser-to-database setup flows bridge actual setup APIs to the test HTTP application; app-shell auth views/module status/wallet and Redis/AI/object providers are synthetic. The production server/global CSRF stack, live providers, real sends/posts/uploads and physical-device keyboard behavior remain unrun.

Publication revalidation runs the exact outgoing code on fetched v8, including the new base's `settingsModuleAccess` regression. Final results, source hashes, branch/remote SHA comparison, incremental bundle hashes and explicit failed/unrun limits are recorded in the accompanying publication manifest. No Pages are written by this audit chat.

The outgoing revalidation has 127 backend tests/7 suites and 66 client tests/9 suites passing, both builds passing, scoped lint passing, and server production types passing. Full server types retain the same two unchanged outreach mock errors. The 36-case browser run recorded 35 passes and one `ERR_ABORTED` on a preference-page reload amid Next Fast Refresh; that exact case passed on a focused unchanged-code retest. The full-run failure remains preserved. Optional real-browser/database app-shell sockets were isolated after evidence of a local Next proxy loop; this is a test fixture boundary, not a product/realtime patch. Live Redis/socket acceptance remains unrun here. The publication manifest records the final fixture retest and combined-ref checks.
