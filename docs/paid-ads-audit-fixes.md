# Paid Ads audit fixes — 19 September 2026

The Paid Ads workspace now shares dashboard and account queries across Overview,
Campaigns, Recommendations, and Automation. Previous rows remain visible while
refreshing, with an updating indicator; bulk actions are unavailable during a
refresh or reporting error. Auth changes clear the shared QueryClient.

## Reporting and presentation

- Summary, hierarchy, creative comparison, and ad ranking use objective metrics:
  reach and CPM (per 1,000 impressions), clicks/CPC, leads/CPL, engagements/CPE,
  installs/CPI, purchases/CPA, and conversations/cost per conversation.
- Detail trends use the campaign objective with separate spend and result axes
  and accessible values. Missing objective results remain unavailable.
- The mixed-objective Overview trend explicitly labels conversions.
- Delivery filters run on the server. Provider-only local `report_only` state
  no longer hides ACTIVE/PAUSED provider results. Active includes Google ENABLED.
- Conversations, Conversions, Draft, and reporting currency are selectable.
- Active campaigns with zero delivery receive a warning. Paused/draft campaigns
  with zero delivery are neutral. Import requirements are distinct from failures.
- Overview groups delivery, measurement, connection, and decision issues, with
  contextual diagnostics, delivery review, recommendation, and sync actions.
- Single measured campaigns no longer claim better/worse comparative performance.
- Report-only technical details explain why managed reconciliation does not apply;
  missing managed values do not become false zeroes.

## Workflows and navigation

- Automation shows monitored consent counts alongside campaigns requiring import.
- The setup guide links import, business targets/evidence, account advisory mode,
  and optional pause consent. Settings remain accessible in every account mode.
- Bulk import, enable pause consent, and revoke consent require an in-product
  confirmation with campaign names. Each campaign has a success/failure receipt;
  failures remain selected for retry. Consent changes preserve saved thresholds.
- Campaign reviews and automation lists have search, monitoring filters, sort,
  and 15-row pagination. Unified inventory has 20-row pagination.
- Operational health is available through Show operational details.
- Create campaign opens a structured brief, then the Performance Marketing agent.
  The brief is inserted only on request, never automatically sent or published.
- Campaign breadcrumbs point to existing workspace destinations. Creative links
  preserve campaign account, reporting period, and return context.

## Validation

Focused automated validation includes provider-status and normalized-objective
API filtering, currency metadata, objective calculations and rendered CPM,
missing trend measurements, import partial failure, consent threshold preservation,
pagination, shared cache reuse, and retained rows during refresh. Production QA
must verify all four tabs, detail sections, creation handoff and responsive layout
in Chrome. Provider delivery and pause permissions must not be changed merely to
exercise the production UI.

## Completed production verification

- Paid Ads code commits: `e893da722`, `784b1dcb2`; included in production client
  revision `35bf9448c` alongside the Social Insights touch-control follow-up.
- 61 focused client checks (including four existing card-spacing checks) and 71
  server checks passed. Client TypeScript, isolated optimized Next.js build,
  production Next.js build/type checks, and API/worker bundles passed. The broader
  server TypeScript check still reports unrelated pre-existing repository errors.
- Deployment SSH disconnected after container recreation. Steps 8–12 were resumed
  successfully: reconciliation, all three health endpoints (200), container
  health, nginx validation/reload, and cleanup. Migration 284 from the parallel
  Social Insights task was preserved in the replacement API.
- Chrome verified all four workspace tabs, five active provider campaigns,
  26 paused campaigns, pagination, review search, grouped issues, operational
  disclosure, and coverage `0/2 monitored consented · 30 require import`.
- Bulk import and pause-consent confirmation dialogs listed affected campaigns;
  both were cancelled. Automated tests exercised successful/failed imports and
  preserved thresholds. No live pause consent or ad delivery was changed.
- The original awareness defect is corrected across summary, ranking, ad sets,
  ads, and creative comparison. A real account refresh succeeded; refreshed
  summary and ad hierarchy both showed spend INR 2,138.99 and CPM INR 2.56.
- Meta diagnostics, technical reconciliation, managed recommendation review,
  campaign targets and account settings loaded successfully.
- The creation brief arrived in the conversation and inserted into the composer
  without sending. The test text was cleared afterward.
- At a 392px CSS viewport, document width remained 392px and objective cards had
  16px top padding. Browser size was restored. Final Chrome console check was clear.
- Google was not ready in the account settings, so Google-specific live account
  verification was unavailable. Its reporting logic was tested automatically.
  Missing measurements, baselines, monitoring imports, and connection setup
  remain explicit states requiring real provider evidence or user configuration.
