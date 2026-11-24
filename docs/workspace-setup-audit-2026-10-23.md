# Setup and ordinary preferences audit — 23 October 2026

Publication/revalidation update: see `onboarding-publish-20261023.md` for replay onto fetched v8, exact Notifications coordination, outgoing commit mappings, and authorized handoff-branch publication. This report preserves the original audit checkpoint and evidence.

## Baseline and boundaries

Audited base: `35d6107b50aaabf238a2fc1fa39ff172bdf6b8f7` on local `v8`, safely fast-forwarded from the clean saved `09fe888ec8bdd3fa12ccee0e047cd1d876306222` checkout after `git fetch --no-tags origin v8`. The remote advertised the same SHA. No push, deployment or production connection is authorized or performed.

No `AGENTS.md`, repository `.agents/skills`, or mounted workspace skill files were supplied. The verification skill was read. Original owners' unintegrated fixes/manifests are absent. Parent coordination was requested; shared Tenant membership/permissions/pricing and UI navigation guards must be deduplicated by the parent. This audit does not implement those core changes, change credentials/security settings, or write AskSales Pages. New migrations, if necessary, are reserved to 490–499; none are currently planned.

## Inventory

The companion `workspace-setup-audit-inventory-2026-10-23.txt` records every page/layout under `/setup/*` and `/dashboard/settings*`, setup components, relevant models, controllers and services at the baseline. Settings integrations/outreach/leads/ads/team are inventoried as interfaces owned by their corresponding audit owners; this audit covers business setup and ordinary account preferences, not their credential, pricing, sending, or automation internals.

| Boundary | Implementation |
| --- | --- |
| Setup routes | `/setup/business-profile`, `/setup/business-profile/new`, `/setup/brand-toolkit`, `/setup/brand-toolkit/:profileId`, `/setup/account-verification`; their layouts and setup wrapper |
| Setup API | POST `/api/setup/analyze-website`; GET `/api/setup/onboarding-status`; GET/PUT/DELETE `/api/setup/drafts/:draftKey`; POST `/api/setup/website-analysis/jobs`; GET/DELETE `/api/setup/website-analysis/jobs/:jobId`; POST `/:jobId/retry` |
| Business API | GET/POST `/api/settings/business-profiles`; GET/PUT/DELETE `/:id`; POST `/:id/archive`, `/:id/restore`, `/:id/default`; GET categories; singular `/api/company-profile` compatibility adapters |
| Shared interfaces | `/api/auth/mark-setup-complete` and `/setup-complete`; `/api/content/brand-toolkits` creation/update/list; setup image/logo uploads; knowledge entry/extracted-text reads; invitations/members delegated to Tenant |
| Ordinary account settings | GET/PUT `/api/settings/profile`, `/api/settings/profile/notification-preferences`, `/api/settings/preferences`; PreferencesContext, formatting, theme, locale, date/time, currency and timezone |
| Jobs | GENERAL `workspace-website-analysis`; standalone dispatcher; scoped job restoration; queue stable UUID; 3 attempts/exponential backoff; queued/running/completed/failed/cancelled; progress AsyncLocalStorage and persistence/cancel advisory lock |
| Models | `company_settings`, `user_preferences`, `users` ordinary profile/notification fields, `workspace_setup_drafts`, `workspace_website_analysis_jobs`; handoffs to `brand_toolkits`, knowledge base and storage; default preferences and memberships are shared Tenant interfaces |
| Schema | Existing migrations 129, 131, 276, 299, 304, 305, 322, 323 and subsequent baseline migrations; do not rewrite applied migrations |
| Configuration | No dedicated setup feature flag found. Redis availability, GENERAL worker dispatch, active owner/business scope, setup/approval status, source versions, request keys, `forceRefresh`, explicit business header, and platform/module access affect behavior. Test/dev environment variables are not product flags. |

## Findings and coverage recorded BEFORE implementation changes

1. **SETUP-01 — P2, reproduced, legacy website URL normalization.** New regression tests on the audited SHA: 3 fail, 6 pass. `HTTPS://creator.example` is rewritten to `https://HTTPS://creator.example`; `ftp://creator.example` and `file://creator.example/path` are accepted as websites and enter the crawler/provider path. The queued endpoint already rejects unsupported schemes and handles case insensitively. Repro uses the real legacy controller with synthetic crawler/LLM/knowledge/storage providers, so this proves controller behavior, not live crawl reachability. Evidence: `issue-01-before.log`.
2. **SETUP-S01 — P1, source/static, shared cancellation persistence boundary.** The worker holds a cancel advisory lock in a transaction, but the work callback performs global-db writes outside that transaction, and knowledge/profile writes are separate commits. Cancellation after an earlier commit can leave partial handoffs. Existing tests cover cancellation while the provider is held, not all commit-order interleavings. Reproduce before any change; coordinate transaction contracts with parent/core owners.
3. **SETUP-S02 — P2, source/static, ordinary timezone mirror.** Preference upsert and user timezone update are separate writes. Failure between them can return 500 after preferences persist. Profile updates mirror back to preferences similarly. Reproduce a failure before proposing transaction changes; coordinate shared user-model ownership.
4. **SETUP-D01 — decision.** Define whether cancellation promises only to prevent future writes or to undo knowledge/assets already saved during an analysis. Define recovery/cleanup for partial handoffs and whether refreshing an existing cached knowledge entry should replace or add versions. No destructive cleanup policy is invented here.
5. **SETUP-I01 — improvement.** Existing fixture adapters do not uniformly enforce real draft CAS/tombstone semantics. Preserve real HTTP/PostgreSQL coverage alongside UI fixtures; fixture-only green tests cannot establish full durability.

| Coverage at pre-fix checkpoint | Status | Evidence/limits |
| --- | --- | --- |
| Latest baseline and instructions | Passed | Fetch complete; clean baseline SHA recorded; instruction locations checked |
| Server setup validation, controller handoff, settings and scope unit suites | Passed | 66 tests, 4 suites on audited SHA; synthetic providers |
| Client draft/setup/profile-switch unit suites | Passed | 20 tests, 3 suites on audited SHA |
| Added legacy URL regressions | Failed | 3 failed / 6 passed before fix |
| Real HTTP/PostgreSQL recovery suite | Blocked at this checkpoint | Disposable PG18.4 running at loopback:55439; migrations stop at 040 because pgvector is absent; no migration skipped or marked applied |
| Responsive browser setup scenarios | Running | Actual Chromium at CSS widths 390, 768, 1440, scale 1, normal zoom. Initial first scenario reaches account review but fails console check due audit API-origin/CSP mismatch; harness configuration must be corrected without changing application security settings |
| Real Redis queue persistence/restart | Blocked | Redis source download returned HTTP 403; no denial bypass/retry. Queue fixture coverage is not real Redis coverage |
| Owner-change recovery/shared permissions | Unrun/pending coordination | Original owners' local fixes unavailable; no core reimplementation |
| Live crawling, AI, embeddings/object-store readiness | Unrun by request | Mocked providers/disposable objects only; no real uploads, paid APIs or external mutations |
| Final lint/types/build/regression | Unrun | Run after sequential confirmed fixes |

## Sequential fixes and final verification

### SETUP-01

Fixed only legacy setup-controller normalization: recognize HTTP(S) schemes case insensitively and reject explicit unsupported schemes before applying the HTTPS default. Existing URL/cache formatting and the queued-service interface remain compatible. All 9 controller tests and 5 onboarding validation tests pass after the fix (`issue-01-after.log`); the same 3 failing-before regressions remain in the suite. No live provider was used.

### SETUP-02 — recorded before fix

**P2, reproduced on PostgreSQL 18.4: deleting a workspace with retained business records returns 500 instead of the actionable 409/archive response.** The complete migrated database's real JWT/HTTP/scoped-PostgreSQL recovery suite has 16 passes and 1 failure (`recovery-baseline.log`). PostgreSQL returns `23001` (`restrict_violation`) for the `ON DELETE RESTRICT` business foreign key; the controller only recognizes `23503` (`foreign_key_violation`). The existing test checks transaction rollback, retained setup files/toolkit/job, absence of cleanup receipts and no provider object deletion. Retain that test and add support for the additional integrity SQLSTATE without changing deletion, membership, permissions, or billing logic. This finding is specific to the tested PostgreSQL version; no production database was inspected.

Fixed the response mapping for both PostgreSQL integrity codes. All 17 real JWT/HTTP/PostgreSQL recovery scenarios now pass (`issue-02-after.log`), including scoped drafts/CAS/tombstones, idempotency, permission denials, analysis progress/cancel/retry/queue failure, profile/toolkit conflicts, completion, archive/restore and deletion rollback. Redis, analysis providers and object deletion remain mocked in that suite.

Further final verification, integration manifest and portable incremental bundle details follow below. Pre-fix evidence above remains preserved.

### SETUP-03 — recorded before fix

**P2, reproduced: concurrent partial notification-preference saves lose an unrelated edit.** Two authenticated HTTP PUTs set `leadAlerts=false` and `campaignUpdates=false`. A real PostgreSQL row lock holds both updates until their preceding reads complete. Both return 200, but the final GET has `leadAlerts=true` and `campaignUpdates=false`. The new deterministic regression fails while the other 17 HTTP/PostgreSQL scenarios pass (`issue-03-before.log`). Replace this controller's read/merge/write with an atomic JSONB merge, preserving defaults, unspecified keys, validation, actor scoping and 404 behavior. This changes ordinary synthetic preference data only; no messages or security settings are involved.

Fixed using one account-scoped `UPDATE ... RETURNING` that merges defaults, the current database JSONB value and only validated requested keys. The new concurrency regression and all other recovery scenarios pass: 18/18 (`issue-03-after.log`). The test also checks invalid input and another account's unchanged preferences. It uses real JWT middleware and real PostgreSQL locks, not an in-memory CAS approximation.

### SETUP-04 — recorded before fix

**P2, reproduced in Chromium: ordinary preference selectors have no accessible field names.** The Language, Locale, Timezone, Date Format, Time Format, Color theme and Currency labels are visually adjacent but not associated with their SelectTrigger controls. A browser regression cannot find the Language combobox by its field name (`issue-04-before.log`); all seven controls share this source defect. Associate each existing label and trigger with an ID. This is ordinary preferences UI and does not alter navigation guards or security settings. Retain the named-control assertions and test save interruption/retry/reload at all three real viewport widths.

Fixed all seven label/trigger associations. All 6 new Chromium scenarios pass at 390, 768 and 1440 CSS pixels (`issue-04-after.log`): named controls, language/locale/date/time/theme/currency changes, interrupted save, retry and reload, plus ordinary profile validation and retained edits after failure. These six use explicit API fixtures and do not prove real notification delivery or translation completeness. They never open or mutate security settings.

## Final coverage and limits

| Area | Result | Evidence and remaining limits |
| --- | --- | --- |
| Backend regression | Passed: 98 tests / 6 suites | `server-delivery-regression.log`: 70 unit/controller/validation/scope tests, 24 JWT/HTTP/PostgreSQL recovery scenarios, 4 onboarding PostgreSQL scenarios |
| Creation and selection | Passed for covered cases | Real creation/idempotency/version conflict; default selection from another active workspace and foreign-profile rejection; browser creation pins the saved profile for toolkit requests |
| Durable drafts | Passed for covered cases | Real CAS/tombstones/authorization, 8 concurrent saves yield one winner and seven conflicts; client offline recovery, error/retry/source conflict and reload tests |
| Jobs/progress/cancel/retry | Passed with queue/provider fixtures | Real durable rows, 8 concurrent submissions yield one active job, scoped polling, standalone GENERAL dispatcher, failed queue submission, retry, late-provider cancellation and archive cancellation. Redis transport/durability/restart remains blocked |
| Archive/restore and recovery | Passed for covered cases | Last-active restriction, retained linked history, restore, stale version guards, setup cleanup rollback and durable mocked object cleanup. Ownership-transfer integration remains pending shared-owner coordination |
| Profile/brand/knowledge handoff | Passed for covered local cases | Real company/toolkit/knowledge persistence and cross-business cache isolation; two Chromium flows create workspace → clear tab storage/reload → save toolkit → verify database and cleared draft. Crawling/AI/embedding/object providers remain synthetic |
| Ordinary preferences/profile | Passed for covered cases | Real HTTP/database profile validation/update, preferences canonicalization, actor isolation, successful timezone mirrors, atomic concurrent notification updates; 6 fixture-backed browser scenarios validate named controls, error retention, retry and reload |
| Client regression | Passed: 66 tests / 9 suites | `client-delivery-regression.log` |
| Responsive browsers | Passed: 36 fixture-backed scenarios plus 2 browser/real-HTTP/database scenarios | 390/768/1440 CSS pixels, device scale 1, normal zoom. 114 setup captures and two integrated review screenshots. Overflow assertions cover exercised states; the two integrated screenshots were visually inspected. Physical devices/onscreen keyboards were not tested |
| Scoped lint | Passed | Changed server controllers/tests: 0 errors, 2 existing warnings; changed client page/tests/config: 0 errors |
| Full source lint | Failed on unchanged baseline files | Server: unused `readFileSync` in `tests/newSupportPipeline.test.ts:2`; client: `prefer-const` for `notifications` in `e2e/settings-redesign.spec.ts:14`. Generated `.next*` directories were excluded from source lint. These files are unchanged from the audited base |
| Type checks | Client and server production code passed; full server check failed | Full server has two pre-existing outreach test-mock errors in `tests/settings.test.ts:201` and `:222`; file unchanged from baseline. Production-only diagnostic excludes tests and passes. No type checking was disabled in the application/build |
| Builds | Passed | Server API and standalone worker build; complete client webpack production build including TypeScript and page generation. Old saved `.next/dev/types` contained malformed code and `.next/types` referenced removed admin routes; only those disposable generated caches were moved out before clean build. Auto-added audit cache paths in tracked tsconfig were reverted |
| Route aliases/settings subsystems | Static inventory; dynamic coverage incomplete | Legacy `/dashboard/settings/company*` aliases and other owners' team/integration/outreach/leads/ads configuration were inventoried. Their full dynamic behavior, central permission/pricing implementation and UI navigation guards are delegated interfaces |
| Live providers and production | Unrun as requested | No production DSNs/data, paid APIs, live uploads/sends/posts, refunds/payments, credential/security-setting changes or deployment |

### Open findings and decisions for the parent

- **SETUP-S01 / SETUP-D01, source/static, pending:** reproduce failure/cancellation between knowledge and profile commits, then agree the transaction and artifact-retention contract with the shared owners. The existing callback locks cancellation but uses global-db writes outside its transaction. Provider-held cancellation is verified; every commit ordering is not. No shared transaction API or cleanup semantics were silently replaced.
- **SETUP-S02, source/static, pending:** successful timezone mirrors are verified. Failure injection between the two preference/user writes and atomic rollback remain unrun. Coordinate a shared user/preference transaction interface with the parent before changing core user-model behavior.
- **Owner changes/recovery, pending:** the original 14 owners' local fixes and change manifest were unavailable in this environment. The parent must deduplicate these small changes and rerun transfer/revocation/deactivation recovery against the integrated Tenant contracts. A manifest was requested during work; no reply/approval was assumed.
- **Redis, denied download / unrun integration:** `https://download.redis.io/releases/redis-7.4.1.tar.gz` returned HTTP 403. No attempt was made to bypass that denial. Real Redis enqueue deduplication, worker restart and delivery retry remain unverified. Database job concurrency was exercised independently with a queue fixture.
- **Full-repository gates, failed:** return the exact unchanged lint/type failures above to their owners. This delivery does not claim repository-wide green checks.

## Reproduction and integration

The test environment used Node 24.19.0, Chromium, PostgreSQL 18.4, pgvector 0.8.7 and 318 actual baseline migrations. PostgreSQL was isolated at loopback/socket port 55439 with a synthetic `setup_audit` role and the two prefix-guarded disposable databases named below. The database bootstrap used the npm `@embedded-postgres/linux-x64@18.4.0-beta.17` binaries and pgvector source `c82c81e22e48d32698e8d637442628f90ed84b8a`; PostgreSQL 18 header source was `6c4172b34dfbdaceb89305e241d9eb60926890fc`. Only headers were generated from that source; the tested server was the actual packaged binary. Missing vector support was resolved by installing the compiled extension in the disposable server, without skipping/marking any migration or replacing SQL types.

Use a fresh fully migrated **local synthetic** database and explicit local migration configuration. No application environment file is a safe source of database coordinates. Existing test suites require the PostgreSQL socket in `/tmp` and use `PGPORT`/`PGUSER`.

Run the local frontend from `client`:

```sh
NEXT_PUBLIC_API_URL=http://localhost:3100 NEXT_PUBLIC_WS_URL=ws://localhost:3100 NEXT_TELEMETRY_DISABLED=1 NEXT_DIST_DIR=.next-setup-audit ./node_modules/.bin/next dev --webpack --hostname 127.0.0.1 --port 3100
```

Run the backend regression from `server`, after preparing the two disposable databases:

```sh
PGUSER=setup_audit PGPORT=55439 NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules WORKSPACE_RECOVERY_TEST_DATABASE=salesmarketing_workspace_recovery_qa_20261023 WORKSPACE_ONBOARDING_TEST_DATABASE=salesmarketing_workspace_onboarding_qa_20261023 WORKSPACE_AUDIT_BROWSER_URL=http://localhost:3100 ./node_modules/.bin/jest --runInBand tests/workspaceSetupRecoveryPostgres.test.ts tests/workspaceOnboardingPostgres.test.ts tests/workspaceWebsiteAnalysisController.test.ts tests/workspaceOnboarding.test.ts tests/settings.test.ts tests/businessScopeBoundaries.test.ts
```

The browser/database scenarios are opt-in through `WORKSPACE_AUDIT_BROWSER_URL` and reject nonlocal frontend origins. They use valid synthetic JWT cookies and the real HTTP authentication/scope/billing middleware. The application-shell auth view, wallets/module status, Redis/throttling and providers are fixtures. Actual setup, profile/toolkit, draft, job and preference requests use the test HTTP server and PostgreSQL. Unexpected browser mutations outside the allowed setup API are blocked and asserted absent. The production server, global CSRF middleware and live-provider canary are not started.

Run all 36 fixture-backed scenarios from `client`:

```sh
../node_modules/.bin/playwright test -c playwright.setup-audit.config.ts
```

The four fix commits are:

1. `5dd4459df8941e7cb39ac3c15918ccb4ac0a91cb` — legacy website schemes.
2. `3f0181dd75139619fe2ee891679fe1263d1d08a6` — PostgreSQL RESTRICT/archive guidance.
3. `ebd9e659134efa64e5f47e7417e1fb56e0286270` — atomic ordinary notification preferences.
4. `11229628f0607cad28f432b93e4b1baa47bcdd44` — accessible preference selectors and browser regressions.

The final evidence/test commit, complete file manifest, bundle SHA-256/byte size and test artifact hashes are recorded in the external delivery manifest to avoid a self-referential commit hash. The incremental Git bundle contains only commits after `35d6107b50aaabf238a2fc1fa39ff172bdf6b8f7`. Parent integrates into v8; no push or deployment was performed. No migration was added, changed, or reserved beyond the supplied 490–499 range. AskSales Pages remain the parent's responsibility.
