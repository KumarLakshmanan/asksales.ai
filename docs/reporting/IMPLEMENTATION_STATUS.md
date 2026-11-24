# Reporting implementation and integration ledger

Date: 2026-10-23. Repository: KumarLakshmanan/salesmarketing. Exact audit and patch base: **35d6107b50aaabf238a2fc1fa39ff172bdf6b8f7**. HEAD remains detached at this base; changes are local and uncommitted. No push, commit, remote merge, deployment, saved configuration change or production migration/backfill was performed.

Environment: `/workspace/salesmarketing`, saved cloud environment `ccarenv_b64_Y2NhcmVudl9kZTYwMDNjNDAyOTA4MTkxOGVhYTM2YWYzYzdhOThlOA`, Debian 13/Linux x86_64, Node 24.19.0, npm 11.9.0, Docker 28.4.0, Chromium 151.0.7922.173. Requested model: GPT-6.1 Sol; repository tools cannot independently attest the host model. Original audit report is preserved byte-for-byte (SHA256 `f68c7024f2f011a975eee87268837c1caf8ae24ec86101ceeff027c23dca7522`). Original witness harnesses remain evidence of the base defects. New in-repository tests assert the corrected acceptance conditions; original witnesses were not rewritten to appear green.

## Outcome and ownership

Patched all 14 confirmed issue groups within reporting ownership, with bounded acceptance coverage. Historical damage, remaining semantic decisions and untested deployment behavior remain explicitly open. No P0 was identified in the original scope; its 14 confirmed groups were eight P1 and six P2. Original full audit, architecture map, expected/actual evidence, priorities and reproduction details are bundled separately as `original-audit/REPORT.md`.

Changes own reporting/ingestion/attribution dates, currency, numeric precision, SQL and grain. OAuth/token authentication, tenancy/access controls, payments and live provider operations were not changed. Parent owns integration and the AskSales.AI Page. Shared files must be reconciled with the other owners before combined testing.

## Per-issue implementation status

“Patched / verified locally” means the specified synthetic acceptance checks passed on this source snapshot. It does not certify historical data or live-provider completeness.

| ID / priority | Final behavior and principal files | Evidence and remaining limit |
|---|---|---|
| R01 / P1 | `MetaAdsService.readDailyInsights` requests daily facts with `time_increment=1`, fully consumes pages before returning, checks source dates/identity, rejects partial/repeated/conflicting pages; `AnalyticsIngestionService` upserts each actual source day. | `reportingCorrections.test.ts` overlap/correction fixture; `metaDailyReporting.test.ts` complete pages, failure, replay and duplicate tests; PostgreSQL replay/cache test. Existing contaminated rows are **not repaired**. |
| R02 / P1 | Decimal conversion values survive Meta readers, paid dashboard/trends/compare serialization, campaign-cache SQL and conversational aggregation. | Card/row/chart 1.75 fixture and actual PostgreSQL upsert/cache replay; existing currency/evidence/insight tests. Existing rounded caches still require approved reconciliation. Display-only formatting may round explicitly. |
| R03 / P1 | Campaign daily Meta reads request `action_values`; shared `MetaInsightMetrics` applies the existing objective/alias selection policy consistently to counts and values, retaining fractional values. | Daily conversion-value fixture and paginated weighted-rate adapter test. Present purchase value is preserved. Missing value availability is recorded in source metadata; existing numeric scalar defaults can still show zero when unavailable. This is not a new revenue-recognition policy or proof of economic profit. |
| R09 / P1 | Selected platform also constrains `pm.platform` in current, previous and daily fact aggregates, including multi-platform parent campaigns. | Controller and real PostgreSQL fixture with different Meta/Google facts. Multi-platform selected-account parent eligibility remains the pre-existing account model; not certified beyond selected platform filtering. |
| R10 / P1 | Compare query binds the complete ID array with `sql.param(... )::int[]`; returns deterministic campaign order and each campaign's own currency. | Actual PostgreSQL execution for valid arrays, currency labels and fractional results. Cross-currency ranking remains a product policy, not an implicit FX conversion. |
| R12 / P1 | First-party booked and won values aggregate independently by their recorded currencies. Adds `bookedRevenueByCurrency` and `wonPipelineValueByCurrency`; legacy scalar fields are nullable when totals are incomparable. Detail UI renders maps with explicit currencies. | Actual PostgreSQL mixed-currency linked bookings/CRM fixture; frontend formatting test. Lifetime outcomes of an event-time lead cohort are labelled; custom stages, missing prices, refunds and allocation among campaign touches still need decisions. |
| R13 / P1 | New migration **370_reporting_metric_precision.js** widens percentage-point CTR from NUMERIC(5,4) to NUMERIC(9,6); model agrees. | Fresh disposable PostgreSQL migration/upsert stores 10%; rollback with 100% refuses atomically and preserves facts. No migration applied outside disposable QA. |
| R15 / P1 | Explicit matching local `campaign_id` takes precedence. Provider/UTM fallbacks only admit rows with no local campaign association. Managed diagnostics campaign lookup includes selected account. | PostgreSQL conflicting-local-ID fixture and existing diagnostics tests. Fallback provider-ID/account ambiguity without a local association remains a static identity-model concern. |
| R04 / P2 | Accepted provider `ENABLED` is included with ACTIVE/PUBLISHED in the dashboard active count. | Controller provider-cache fixture plus existing paid dashboard tests. |
| R05 / P2 | Trends and compare share inclusive UTC 7/30/90-day date helpers and an upper bound; hourly SQL bounds both ends of the most recent 24 hours. | Deterministic UTC boundary fixture and actual seven-day PostgreSQL exclusion of eighth-day/future facts. PostgreSQL fixtures set UTC; arbitrary database session zones/DST deployments were not exercised. |
| R06 / P2 | Refresh validates actual calendar dates, paired presence and supplied empty values before ingestion; impossible dates cannot normalize into another day. | Controller test asserts no ingestion; provider tests assert no call for invalid date. |
| R08 / P2 | Numeric recorded zero scores contribute to conversational averages; existing nonzero ICP fallback is retained. | Zero/nonzero source fixture. Default-zero versus explicitly scored provenance still needs a schema/semantic contract. |
| R11 / P2 | Ad-set API reads `ad_unit_metrics` at ad_set/ad_group daily grain, returns identities and `grain: child_daily`, validates pagination, stable order, limit+1 and `nextOffset`. | Controller fixture and real PostgreSQL 110-child-row pagination without repeated or missing rows. Offset pagination is not a snapshot across concurrent ingestion; concurrent/export reconciliation remains unrun. |
| R16 / P2 | Supplied malformed social start/end filters return 400 before reading snapshots; actual calendar validity checked. | Controller no-read fixture and existing frontend/social validation tests. |

### Safe improvements included

- C01: Home money uses `ReportingMoneyService` currency maps and separate daily/lifetime budget dimensions. Incomparable legacy scalar totals are null. Home UI uses recorded labels and a neutral icon rather than an assumed currency. Old cached response shapes are refreshed. SQL, component and full HTTP browser checks cover the new contract.
- C02, partial: Outbound counts exclude queued/failed/incoming rows; opened/clicked counters retain cumulative timestamp/count evidence. Actual PostgreSQL home-controller fixture verifies this. Weekly conversions still use lead `updatedAt`, and channel “conversions” still represent sent messages; authoritative lifecycle/metric naming decisions remain open.
- C03, partial: Social API reports the raw 10,000-snapshot cap via `freshness.truncated` and count; UI displays a warning. It still has a cap. This warning does not make large-history totals complete.
- Daily provider selection is shared by report-only cards, charts and detail traces so exact duplicate facts do not inflate one surface but not another. Exact duplicates are removed; divergent same-day cached rows are not automatically reconciled. Meta's new daily reader does reject conflicting source duplicates.
- `this_month` and `last_month` provider presets now use UTC calendar boundaries. Out-of-window/unavailable lead evidence remains null. Summed daily reach remains explicitly an approximation rather than unique period reach.

## Final-source verification

All following results apply to the final 28 code/test/fixture files in `tested-source-hashes.json`; a post-test hash comparison reported **no drift**. Documentation was finalized afterward. No repeated audit rerun was used to retrieve deliverables.

| Check | Result | Evidence / limits |
|---|---|---|
| Selected backend Jest tests | **PASS: 210 passed; 8 skipped; 26 files** | `backend-results.json`, `backend.log`, `run-backend.sh`. Skips are opt-in support DB checks; not passed acceptance. Includes reporting, ingestion, ads, conversation, social, support/AI visibility and CRM unit coverage. |
| New actual-SQL integration | **PASS: 11 passed; 1 file** | `postgres-results.json`, `postgres.log`, `run-postgres.sh`; disposable PostgreSQL 16, cached pgvector image, network none, tmpfs, no published ports/application data. Generated application SQL executed through docker exec; not the saved application database or full migrations/RLS stack. |
| Selected client Vitest tests | **PASS: 74 passed; 14 files** | `client-final-results.json`, `client-final.log`, `run-client-final.sh`. Vitest aggregate suite count is 26 describe groups; actual testResults contains 14 files. |
| Browser journey | **PASS: 1 test; desktop 1440 and mobile 390** | `browser-results.json`, `browser-production.log`, screenshots; fresh built app over permitted localhost HTTP. Mocked shell and dashboard GETs; external requests blocked. Currency/budget cadence visibility verified, no business mutation. Not full live-auth/provider/DB E2E. |
| Client full TypeScript | **PASS** | `client-types-verified-final.log` empty; successful preceding completed compiler receipt and final production build also typechecked. Earlier progress claimed completion prematurely; an actual later compiler found the missing nullable currency-map interface, which was fixed before final build/test/hash freeze. |
| Server full TypeScript | **BASELINE FAILURE: 2 diagnostics** | `server-types-verified.log`: unchanged `server/tests/settings.test.ts:201` TS2322 and `:222` TS2352, incomplete mocks/cast. `typecheck-base.cjs` + `server-types-baseline.log` independently reproduce exactly two at base using a virtual source host. No new final-source diagnostic. |
| API and worker bundles | **PASS** | `server-build-final.log`; esbuild produced both entrypoints. Bundling does not replace typecheck. |
| Full client production build | **PASS** | `client-build-verified.log`; compile, typecheck and all route/static generation complete in env-free source snapshot. Isolated temporary tsconfig excluded stale generated dev route types; application configuration untouched. |
| Changed-file ESLint | **PASS with warnings** | `server-lint-verified.log`: 0 errors/92 warnings (explicit-any test fixtures and style among them). `client-lint-verified.log`: 0 errors/1 existing hooks cleanup warning. Not warning-free. |
| Whitespace / patch / original evidence | **PASS** | `git diff --check`; original audit hash check; final patch checked against a separate temporary index initialized from exact base, without staging the real index or modifying HEAD. See packaging manifest. |

Serial/resource-bounded tests used clean allowlisted environments and network preloads; no production credentials loaded. The PostgreSQL fixture is opt-in (`REPORTING_LOCAL_QA=1`) and creates its own synthetic local database. Test container cleanup completed; owned production preview was stopped after the browser run.

### Reproduction and artifacts

Extract the bundle and inspect `manifest.json` before applying anything. `reporting-fixes.patch` contains all modified/new implementation, regression and documentation files. It is based on the exact SHA above. `changed-files/` mirrors their final bytes. `evidence/` contains final logs/results, serial runner scripts, network guards, base-compiler helper, and screenshots. `original-audit/` holds the original report and evidence archive. No environment files, credentials, dependency trees, preview build output or saved configuration are included.

Run the supplied runners from the original directory layout or adjust only their absolute evidence-output/preload paths to an isolated checkout. They invoke installed Jest/Vitest directly; install from the existing lockfile only under your normal approved process. For PG use only the opt-in disposable fixture. Do not point runners at production. The browser spec is included in the patch under `client/e2e/`; the evidence Playwright config points at a permitted local production preview and one Chromium worker. Existing `client/e2e/fixtures/app` provides its mock shell/mutation guard.

## Integration order and shared-file dependencies

1. Preserve original audit evidence and inspect the exact patch/manifest at base. Parent resolves overlapping owner patches; do not copy over later changes blindly. Shared areas: `campaignAnalyticsController.ts`, `dashboardController.ts`, `performanceMarketingController.ts`, `socialAnalyticsController.ts`, `analyticsExecutor.ts`, `CampaignDetailPage.tsx`, home `page.tsx`/`DashboardStats.tsx`, marketing analytics UI, provider metrics/diagnostics. No authentication/token implementation was edited.
2. New **unapplied** Reporting migration uses reserved **370–379** (only 370 used). Data owns 330–331; Tenant owns 340–349. No applied/deployed migration history was renamed. Baseline has migrations through 329. Combined ordering must run earlier files first. Functional prerequisite: performance_metrics from 001; fractional-conversion schema from 270. No functional dependency on a particular new Data/Tenant migration.
3. In a separately authorized rollout, widen CTR before rolling out ingestion. Current patch is local only. Downgrade refuses on out-of-range data rather than silently losing facts.
4. Parent must run combined final-source checks after integration, including tenant scoping and authentication dependencies; these results apply to this isolated patch, not to a future combined tree.
5. Historical reconciliation is a separate gated operation. See `HISTORICAL_RECONCILIATION_PLAN.md`; no actual backfill/business-write SQL or source fetch was executed.

## Ordered remaining backlog / owner decisions

| Order | Status / priority | Concrete next step and acceptance |
|---|---|---|
| 1 | Integration / P1 | Reconcile shared code and schema ordering, run combined synthetic tests; selected owner/account/platform scopes must agree across detail, card, chart and exports. |
| 2 | Historical repair pending / P1 | Approve account/campaign/window/source snapshots and precise diff. Rebuild only proven contaminated Meta rows and affected caches; source-day union, replay, corrections and currency totals must reconcile before any business reliance. Missing provenance is unknown. |
| 3 | C04 decision / P1 | Specify provider-specific correction/attribution windows, paused/ended campaign refresh eligibility and clock convention. Test delayed outcomes beyond seven days and account-timezone rollover; do not automatically extend paid provider calls from this patch. |
| 4 | C02/C05 decisions / P2 | Define authoritative won-transition timestamps/re-entry counts, custom stage types, booking status/refunds/missing prices and lifetime multi-touch allocation. Add lifecycle-backed reporting; don't relabel updatedAt as a conversion event or infer FX. |
| 5 | C03 partial / P2 | Replace capped raw social scans with SQL/current-evidence pagination or complete aggregate queries; compare >10,000 corrected snapshots and exports to source with stable snapshot semantics. |
| 6 | C06 decision / P2 | Decide activation and idempotency keys for unused pixel queue; no active caller found during audit. Design deterministic late/duplicate/conflicting event handling before activating it. |
| 7 | C07 decision / P2 | Define typed date-scoped conversational interface and comparable ranking rules. Current canonical tool has no structured date parameters and typed date_range remains unsupported. Test same-currency/comparable-grain comparisons and explicit unavailable responses. |
| 8 | Semantics / P2 | Distinguish unscored default-zero provenance, missing provider conversion values and ambiguous fallback account identities. Preserve availability and source evidence in API/UI; add tests for each approved decision. |
| 9 | Improvements / P3 | Reduce explicit-any/style warnings in new test fixtures, add more browser journeys for paid detail/pagination and social truncation, strengthen concurrency/export snapshot reconciliation. Do not weaken acceptance tests. |

## Blockers, denied actions and unrun limits

- Baseline server TypeScript remains blocked by the two pre-existing settings-test diagnostics above; those files belong outside reporting and were preserved.
- Eight opt-in support DB tests skipped. Full repository integration/system suites, production tenant/RLS stack, live provider fetches, real auth, real exports/PDF rendering and large/concurrent data volumes were not exercised. Local mocked + SQL evidence is not complete assurance.
- Early audit broad traversal received access denials for `/workspace/.onboarding/salesmarketing/postgres` and Redis `appendonlydir`; those unrelated targets were not used or retried. Independent permitted work continued.
- Preview diagnosis attempted reading `/proc/9726/cwd`; OS returned PermissionError 13. This denied read was not retried. Subsequent cleanup used permitted UID/known-command process inspection only.
- Standalone component browser navigation to `file:///workspace/reporting-implementation/component-browser/index.html` was **denied** with `net::ERR_BLOCKED_BY_ADMINISTRATOR`. That action was not retried/bypassed and standalone file smoke remains blocked. The later successful browser test used the originally permitted HTTP full application; it did not serve the denied file.
- No approval-review rejection, pending business write or uncertain production mutation occurred. No requests for security-setting changes, production data repair or external outreach were made. All application changes remain reviewable local files.
