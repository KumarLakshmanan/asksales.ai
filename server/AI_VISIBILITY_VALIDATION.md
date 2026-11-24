# AI Visibility workbench — implementation and validation

10 September 2026. Scope: the 42 items in `docs/AI_VISIBILITY_UX_FUNCTIONAL_AUDIT_2026-09-09.md` (F01–F16, U01–U16, D01–D10).

The changes are in the working tree. Migration `server/migrations/249_ai_visibility_workbench.js` was applied to a disposable local QA database. Production and the primary development database were not migrated or deployed by this task. Other work already in the shared working tree is outside this change.

## Fresh website checks

Chrome exercised the application at `http://localhost:5211` against the actual authenticated API and audit worker at `http://localhost:8411`. The worker crawled the requested public websites; provider answers were not fabricated.

| Website | Completed QA audit | Pages crawled | Current SEO findings | Retained fix records | Provider outcome |
|---|---:|---:|---:|---:|---|
| aimplifylabs.com | 6 | 25/25 | 126 | 126 | OpenAI excluded; Gemini unavailable |
| codingfrontend.in | 4 | 19/19 | 69 | 69 | OpenAI excluded; Gemini unavailable |
| orocircle.com | 11 | 4/4 | 17 | 19 (17 open, 2 verified resolved) | OpenAI excluded; Gemini unavailable |

All three measurements disclose partial coverage and leave GEO unavailable. OpenAI credentials were not configured. Fresh Gemini requests returned quota/billing errors; one failed observation was preserved and the remaining three were skipped under one provider incident. These checks do **not** establish healthy OpenAI or Gemini access.

ORO's initial QA measurement had 19 SEO findings. The later crawl verified that two informational link checks no longer applied; their fix history remains available as verified resolved. The later run used the category “resort stays and villa staycations” and geography “Nandi Hills, Bengaluru,” grounded in its crawled title and description. Historical measurements retain their original context.

Scoring version 2 normalizes repeated page-level penalties. Its scores must not be compared directly with historical version-1 scores.

## Functional fixes

| Item | Implementation and evidence |
|---|---|
| F01 | Provider readiness distinguishes configured and excluded providers. Excluded OpenAI observations do not enter the expected-answer denominator. Verified in fresh runs on all three domains and coverage fixtures. |
| F02 | Provider-wide availability errors produce a single incident and stop redundant requests for that provider. Original failed/skipped observations remain inspectable. Fresh Gemini quota failures and availability fixtures verify this path. |
| F03 | APIs and shared measurement context select a completed snapshot; running attempts appear separately. Chrome kept ORO audit 5's findings visible while audit 11 ran. Rendered tests also cover mounted completed details during a newer run. |
| F04 | Shared invalidation refreshes related views and counts on mutations and terminal transitions. Chrome switched the mounted ORO SEO view to audit 11 without reload. Rendered tests cover changed findings, fix counts and late PDF recovery. |
| F05 | Signed OAuth context returns to the selected website's SEO route. Callback tests cover success, denial, token-exchange failure and invalid state. A PostgreSQL-backed GSC fixture covers property selection and dated sync. |
| F06 | Corrections increment an audit revision; raw provider answers and historical score snapshots remain unchanged. GEO, measurement context, comparisons, reports and exports disclose this policy. A real database test verifies the revision and score invariants. |
| F07 | Shared capabilities follow server roles for billing, connections, editing and review. Rendered tests cover owner, agency admin, editor and client reviewer across analysis, monitoring, GSC, catalog, competitors and GEO correction; route tests enforce server access. |
| F08 | Fix generation persists every finding. A real database test generates 81 fixes with the critical finding at position 81. The aimplify crawl retained all 126 findings in Fixes and downloads. |
| F09 | Discovery and SEO share `RobotsPolicy.ts`. Fixtures cover grouped/specific user agents, Allow exceptions, wildcards, end anchors, literal regexp characters and longest-rule precedence. |
| F10 | Informational findings have explicit totals and filters. Chrome showed ORO's two informational findings in the earlier measurement; rendered tests reconcile filtering and totals. |
| F11 | Configuration revisions persist independently of component state. Navigation preserves stale-measurement notices; a matching new measurement clears them. Chrome verified this for saved ORO settings. |
| F12 | Secondary query failures have explicit error/retry states. Rendered tests distinguish AEO errors from empty lists; the report library exposes PDF storage failures and search results distinguish no matches from no records. |
| F13 | History wording is status-first, including running, queued, failed and cancelled attempts. Only completed runs receive completed wording. Rendered tests cover zero-warning queued/running/failed/cancelled attempts; Chrome verified the separate running banner and retained completed history. |
| F14 | Competitor aliases and shared official domains are normalized without collapsing distinct properties. Competitor suggestion fixtures cover duplicate aliases and false merges. |
| F15 | Scoring and competitor metrics use one first-party ownership rule, including www and owned subdomains while rejecting suffix lookalikes. Shared fixtures verify it. |
| F16 | Website breadcrumbs resolve the project name and link the portfolio to the existing route. Chrome verified named breadcrumbs and navigation for all three domains. |

## Product and UX improvements

| Item | Implementation and evidence |
|---|---|
| U01 | Every website section has the website, completed audit, geography, locale, configuration revision, coverage and freshness context. Chrome checked all sections and website switching. |
| U02 | GEO shows successful/attempted providers, successful/expected observations and extraction coverage separately. The historic 1/3-provider, 4/12-observation case is covered by fixtures; real failures render 0/1 and 0/4. |
| U03 | SEO evidence includes source pages, checked destinations, HTTP status, redirect chains, images/metadata and schema errors when captured, with honest unavailable states and linked fixes. Engine and rendered evidence tests cover these fields. |
| U04 | SEO supports rule/page/individual grouping, severity/page sorting, search and a complete page inventory. Rendered tests access 25 failed/blocked pages, including the former >20 cutoff. |
| U05 | Version-2 scoring normalizes per-page penalties and discloses the sampled-crawl limit and evidence confidence. Fixtures compare repeated defects across small and large samples. |
| U06 | GSC supports selected date ranges, previous-period comparison, searchable query/page data, stored snapshots and all opportunities. Real database fixtures preserve 75 opportunities; rendered tests reach opportunity 75 and sync the chosen dates. |
| U07 | Generated AEO ideas open a track-question form with editable intent and target page. Rendered interaction tests verify the saved inputs. |
| U08 | Uncovered questions can create an explicitly labeled research brief without inventing an answer. Browser and PostgreSQL-backed tests cover question → brief → edit → review. |
| U09 | Settings expose geography, locale, category and custom GEO prompts. Question sets vary by business profile. Missing categories now yield branded questions rather than invented market context. Unit tests and ORO's new location/category-specific run verify relevance and cache flags. |
| U10 | GEO has provider, intent, branded/discovery, mention and citation filters, compatible-run comparison and accessible evidence buttons. Rendered tests verify intersections and prevent failed extraction from counting as brand absence. |
| U11 | Benchmarks disclose the tracked comparison set, observation count and mention-event denominator. Crawl gaps explicitly state the 25-brand/8-competitor-page limits. Populated rendered fixtures verify the benchmark and separate evidence links. |
| U12 | Fixes support assignment, due dates, URL/module search, persistent filters and resolution evidence. Stable identity carries work across runs; re-analysis distinguishes still present, not rechecked and verified resolved. Database, reconciliation and rendered mutation tests cover this; ORO retains two verified resolutions. |
| U13 | Assets open by exact generated link/content ID and support editing, version history, comments, evidence and exact-version approval. A real database test verifies conflicting edits, stale-approval rejection, approval invalidation after editing and idempotent CMS draft creation. |
| U14 | Commerce has its own Shopify catalog setup, sample feed, custom-column mapping, validation progress, snapshot dates and complete product drill-down. Chrome uploaded 75 labeled QA products, reached row 75 and filtered its missing price. A catalog-only Shopify fixture verifies that blog configuration is unnecessary for connection. |
| U15 | Reports have private iframe previews, dated libraries, comparison, complete CSV/JSON downloads and no-charge PDF retry. Chrome rendered PDFs and downloaded aimplify's 126 findings/fixes. Retry refreshes the file revision; storage failures are actionable and repeated failures stop the generating state. Older PDF truncation is disclosed. |
| U16 | Settings expose monitoring cadence, next run and expected cost. Every paid-analysis entry point requires a loaded estimate and owner billing capability. Browser checks and the four-role rendered matrix verify the controls. |

## Redesign packages

| Item | Delivered surface and validation |
|---|---|
| D01 | Grouped desktop navigation, website/measurement switchers, direct section routes and a mobile section selector. Checked in Chrome across all nine website sections. |
| D02 | Compact workbenches, semantic statuses, readable finding labels and visible focus. Chrome inspected light/dark layouts and all sections at approximately 391 CSS pixels; document width remained within the viewport. Portfolio statistics use one compact mobile row. |
| D03 | Searchable/filterable portfolio and overview with measurement health, coverage, three next actions and history below. Chrome verified all three site cards and portfolio filtering. |
| D04 | SEO summary and issue/page workbench with evidence detail; unconnected GSC is collapsed beneath the core findings. Browser and rendered tests verify navigation and evidence access. |
| D05 | AEO coverage table, question detail, focused creation/editing and secondary suggestions. Structural readiness is distinguished from question matching. Browser and large-list tests cover it. |
| D06 | GEO health strip, coverage-aware metrics, prompt/provider matrix, safe Markdown and evidence detail. Provider errors are consolidated. Browser and rendered filtering/Markdown tests cover it. |
| D07 | Side-by-side benchmark precedes management controls; sampled content gaps remain separate. Populated rendered tests verify the denominator, sample limits and evidence links. |
| D08 | Searchable prioritized queue and a focused detail/editor panel with assignment, evidence, assets and verification state. Browser and rendered mutation tests cover it. |
| D09 | Exact-asset review workspace with suitable brief/metadata/schema previews, version comparison, review and destination history. Browser and PostgreSQL-backed workflow tests cover the review invariants. |
| D10 | Commerce source/health/table flow and a compact report library with in-app preview. Chrome verified feed ingestion, pagination, PDF rendering, downloads and retry. |

## Validation commands

Final checks used Node 24.19.0:

| Check | Result |
|---|---|
| Client API/rendered interaction tests | 49 passed |
| Server AI Visibility and remote-fetch regressions | 202 passed |
| PostgreSQL acceptance with controlled external HTTP | 8 passed in the isolated database; intentionally skipped without the QA database variable |
| Client and server TypeScript | Passed (client checked by the production build) |
| Client production build | Passed; 262 routes generated |
| Server API and worker builds | Passed |
| `git diff --check` | Passed |

The downloaded 10-page aimplify PDF contains numbered entries 1–126 in both the SEO and action-plan sections. Representative findings/action-plan pages were rendered and visually inspected without clipping. JSON evidence contains the same 126 findings and recommendations; internal report storage identifiers are omitted, including audit-stage metadata. A final authenticated HTTP export of ORO audit 11 returned 200 with private/no-store headers, 17 current findings, 19 retained fixes and no internal storage references.

- Client: `pnpm --dir client exec vitest run src/__tests__/aiVisibilityWorkbench.test.tsx src/__tests__/aiVisibility.test.tsx`
- Server: `pnpm --dir server test --runInBand --testPathPatterns=aiVisibility`
- Remote-fetch regressions: `pnpm --dir server test --runInBand tests/safeRemoteFetch.test.ts`
- PostgreSQL acceptance: set `AI_VISIBILITY_QA_DATABASE_URL` to a disposable database whose name contains `_ai_visibility_qa_`, apply migration 249, then run `pnpm --dir server test --runInBand tests/aiVisibilityPostgres.test.ts`.
- Typechecks: `pnpm --dir client typecheck` and `pnpm --dir server typecheck`.
- Builds: `pnpm --dir server build:all` and `NEXT_DIST_DIR=.next-ai-visibility-build pnpm --dir client build`.
- Whitespace: `git diff --check`.

The PostgreSQL suite uses real service code and database transactions with controlled external HTTP responses for Google and CMS providers. It does not establish live Google authorization or live CMS access. No live GSC property or CMS test destination was connected. No report email or public share was sent; no destination was authorized for those actions.

## Release notes

Apply migration 249 before releasing the new server/client together. The migration is additive and includes the provider outcome constraints and durable configuration/correction/version/workflow data. GEO remains unavailable until configured providers can return real answers. The local test account's storage quota is independent of production; a real storage-limit failure was used to verify report recovery.
