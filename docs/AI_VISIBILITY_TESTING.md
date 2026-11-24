# AI Visibility Test Guide

This guide covers the automated and deployment smoke tests for the SEO, AEO, GEO, commerce, competitor, recommendation, asset, report, monitoring, billing, and navigation functionality.

## Automated suites

### Server

Run from `server/`:

```bash
npm test -- --runInBand \
  tests/aiVisibilityEngines.test.ts \
  tests/aiVisibilityCrawler.test.ts \
  tests/aiVisibilityProviders.test.ts \
  tests/aiVisibilityAeoCoverage.test.ts \
  tests/aiVisibilityAlerts.test.ts \
  tests/aiVisibilityCompetitorSuggestions.test.ts \
  tests/aiVisibilityCompetitorIntelligence.test.ts \
  tests/aiVisibilityReportExport.test.ts \
  tests/aiVisibilityReportBranding.test.ts \
  tests/aiVisibilityCmsPublishing.test.ts \
  tests/aiVisibilityShopifyCatalog.test.ts \
  tests/googleSearchConsoleService.test.ts \
  tests/aiVisibilityRoutes.test.ts \
  tests/aiVisibilityFoundation.test.ts
```

The focused server suite currently contains 125 cases. Run it with the repository's supported Node.js runtime (Node 24.18 or newer).

| Suite | Cases | Coverage |
| --- | ---: | --- |
| `aiVisibilityEngines.test.ts` | 23 | Domain normalization, evidence-backed SEO findings and penalties, sitemap/robots consistency, prompt profiles and cache hashes, score weighting and fingerprints, CSV/JSON/XML commerce feeds |
| `aiVisibilityCrawler.test.ts` | 4 | Robots/sitemap discovery, HTML metadata, headings, canonicals, noindex, bounded SSRF-safe link checks, redirect evidence, explicit JSON-LD errors, images, content hashes, blocked/time-out/non-HTML failures |
| `aiVisibilityProviders.test.ts` | 12 | OpenAI Search and Gemini Search observation normalization plus Gemini-first strict extraction, fallback, validation failures, costs, missing credentials, live fidelity, and usage logging |
| `aiVisibilityAeoCoverage.test.ts` | 4 | Verified page matching, blocked/noindex exclusion, grounded answer blocks, and validated FAQPage JSON-LD |
| `aiVisibilityAlerts.test.ts` | 2 | Score decline, mention loss, schema regression, new-competitor and high-impact-fix detection plus first-audit and unchanged-evidence suppression |
| `aiVisibilityCompetitorSuggestions.test.ts` | 3 | Business Profile references, provider-observation evidence, cited-domain matching, source merging and owned/existing competitor exclusion |
| `aiVisibilityCompetitorIntelligence.test.ts` | 4 | Deterministic mention rate, share of voice, prompt wins, citation share, cited domains, verified page-type gaps, blocked-page exclusion, and grounded brief validation |
| `aiVisibilityReportExport.test.ts` | 3 | Multi-section audit export, explicit unavailable measurements, CSV quoting, and spreadsheet-formula neutralization |
| `aiVisibilityReportBranding.test.ts` | 2 | Approved-toolkit snapshots, safe brand colors, and fallback behavior |
| `aiVisibilityCmsPublishing.test.ts` | 4 | Encrypted verified connections, approval/version gating, unpublished CMS payloads, and idempotent reconciliation |
| `aiVisibilityShopifyCatalog.test.ts` | 4 | Admin API product pagination, real-field normalization, stable fingerprints, variant truncation disclosure, and explicit empty/limit/pagination failures |
| `googleSearchConsoleService.test.ts` | 4 | Signed/expiring project-bound OAuth state, property matching, API-row normalization, and deterministic opportunity thresholds |
| `aiVisibilityRoutes.test.ts` | 42 | Authentication ownership parameters, competitor intelligence and brief routing, verified suggestion and AEO coverage routing, grounded asset validation, Search Console and Shopify catalog ownership/routing, direct wallet billing, idempotent queue IDs, queue-failure refunds, schema-validated corrections, feed upload requirements, private PDF/CSV downloads, report email validation, and expiring report-share lifecycle |
| `aiVisibilityFoundation.test.ts` | 17 | Durable stage order, component pricing, disabled-by-default flag, queues/workers, Next.js routes, native sidebar disclosures, production Chromium configuration, no synthetic fallback contract, durable crawl/extraction/AEO/GSC evidence, alert idempotency, branded report delivery, hashed report shares, and safe CSV generation |

### Client

Use the repository-supported Node.js 24.18 or newer, then run from `client/`:

```bash
pnpm exec vitest run src/__tests__/aiVisibility.test.tsx --reporter=verbose
```

The 14 client cases verify:

- The AI Visibility sidebar and its Overview, SEO, AEO, GEO, Commerce, Competitors, Fixes, Assets, and Reports entries.
- Feature-gate mapping for root and nested AI Visibility routes.
- Project, audit, SEO, AEO question/coverage/asset, GEO, commerce, competitor intelligence/brief, fix, asset, report, and monitoring API paths.
- Commerce multipart file upload and owner-scoped Shopify catalog synchronization.
- Private PDF/CSV URL construction, report email delivery, and expiring report-share API contracts.

## Compilation checks

```bash
cd server
npm run build:all

cd ../client
pnpm build
```

The client production build must list these routes:

```text
/dashboard/ai-visibility
/dashboard/ai-visibility/seo
/dashboard/ai-visibility/aeo
/dashboard/ai-visibility/geo
/dashboard/ai-visibility/commerce
/dashboard/ai-visibility/competitors
/dashboard/ai-visibility/fixes
/dashboard/ai-visibility/assets
/dashboard/ai-visibility/reports
/dashboard/ai-visibility/audits/[auditId]
```

## Safe deployment smoke test

These checks do not authenticate, reserve credits, crawl a site, or call an AI provider:

```bash
for path in \
  /dashboard/ai-visibility \
  /dashboard/ai-visibility/seo \
  /dashboard/ai-visibility/aeo \
  /dashboard/ai-visibility/geo \
  /dashboard/ai-visibility/commerce \
  /dashboard/ai-visibility/competitors \
  /dashboard/ai-visibility/fixes \
  /dashboard/ai-visibility/assets \
  /dashboard/ai-visibility/reports
do
  curl --silent --show-error --location --output /dev/null \
    --write-out "%{http_code} ${path}\n" "https://dev.asksales.ai${path}"
done

curl --silent --output /dev/null --write-out '%{http_code}\n' \
  https://dev.asksales.ai/api/ai-visibility/projects
```

Expected results:

- Every dashboard route returns HTTP 200.
- An unauthenticated API request returns HTTP 401.
- A disabled account receives the platform module unavailable response after authentication.

## Manual authenticated acceptance cases

Use a development-only account with sufficient test credits. Do not use production billing or provider credentials for routine CI.

1. Confirm the account has effective access to `ai_visibility` and the sidebar is visible.
2. Choose a Business Profile with a valid HTTP/HTTPS website. Verify the workspace uses that profile automatically, unsupported schemes and credential-bearing URLs are rejected, and no separate project-domain form appears.
3. Review verified competitor suggestions. Confirm every suggestion names its Business Profile or provider-observation source, name-only observations require a confirmed website, and another user cannot read or update tracked competitors. After a completed analysis, verify share of voice, prompt wins, citation share, cited domains, and true page-type gaps. Create a counter-content brief and confirm its evidence URLs and draft asset linkage.
4. Refresh the analysis and confirm the two-provider credit ceiling is shown before launch, followed by the direct wallet charge, queued audit, 13 stage records, and live WebSocket progress. Confirm completed usage is charged exactly once and no separate maximum reservation is created.
5. Reload during execution and verify completed stages are not repeated.
6. Force one OpenAI Search or Gemini Search failure and confirm `completed_with_warnings`, an explicit failure row, and no simulated answer.
7. Cancel between stages and verify remaining stages are cancelled; if no billable work ran, verify the base charge is returned.
8. Review SEO evidence, AEO questions, GEO observations and citations. On SEO, connect a development Search Console account, confirm only Google-returned properties can be selected, sync 28 days, and verify the query/page rows and threshold explanation. Disconnect it and confirm the card becomes unavailable without a placeholder score or wallet charge. Confirm each AEO question shows its verified best page or remains explicitly uncovered; create grounded Answer Block and FAQPage drafts only when a source passage exists. Force invalid structured extraction and confirm the raw answer remains while derived metrics are unavailable, then save a correction and confirm it is retained and reused.
9. Upload valid CSV, JSON, and XML feeds; confirm an invalid or empty feed cannot produce a commerce score. With a development Shopify connection, sync a read-only catalog and verify pagination, source labeling, stable duplicate reuse, visible missing return/review signals, and no wallet transaction. Do not use a production store for this test.
10. Generate a recommendation asset, validate JSON-LD when applicable, and confirm its status starts as `draft`.
11. Open Assets and confirm CMS actions stay locked until the exact asset version is approved. With development WordPress/Shopify credentials, verify connection validation, encrypted storage, one unpublished remote draft, destination history, safe retry with the same intent, and no AI Visibility credit charge. Never point this test at a live publishing workflow.
12. Download the PDF and verify scores, unavailable pillars, provider/API fidelity, citations, fixes, methodology, the input fingerprint, and approved Brand Toolkit styling. Email it through a connected development sender and verify the durable receipt without an AI Visibility credit charge. Export CSV and verify the same unavailable measurements remain explicit. Create a 7-day link, open it without an authenticated session, confirm the PDF is no-store/no-index, then revoke it and verify it returns 404.
13. Confirm score decline, mention loss, new competitor, schema regression, and unresolved high-impact-fix alerts appear on Overview and can be acknowledged. For administrator-only monitoring verification, confirm a same-period sweep cannot create a second billed audit. Monitoring cost controls are intentionally not exposed in the simplified customer workspace.

## Verification record — 2026-08-15

- Server AI Visibility tests: **125 passed**.
- Client AI Visibility tests: **14 passed**.
- Total focused automated AI Visibility tests: **139 passed**.
- Server API and worker production bundles: **passed**.
- Client production build: **passed**, including all 248 application routes and all ten AI Visibility routes.
- Focused server and client lint: **passed**.
- Dev dashboard smoke test: **9/9 routes returned HTTP 200**.
- Dev unauthenticated API guard: **3/3 requests returned HTTP 401**.

Authenticated dev-browser verification should cover Business Profile workspace resolution, competitor tracking, AEO question editing, a real commerce feed, Shopify catalog connection readiness without triggering an external sync, a full audit, visible provider failures without synthetic substitution, live provider observations and citations, SEO findings, score calculation, wallet reconciliation, recommendation generation, content-asset linkage, CMS connection readiness and approval gating without a real external write, report retry after a storage failure, and PDF report download.
