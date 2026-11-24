# Google Ads publishing audit — 2026-08-30

## Scope and safety boundary

This audit traces the two required Google Ads entry paths:

1. AI Conversation Builder / conversation Content Studio (`AdCopyTab` → `PublishCampaignModal`) and the durable conversation approval widget (`publish_ads` / `publish_google_ads`).
2. Content Studio / Saved Templates (`/dashboard/saved-templates/ads` → `/dashboard/saved-templates/ads/publish`).

Provider mutations were not performed during the read-only phase. The live workflow is expected to stop at review unless a fresh, explicit activation confirmation is present and both the tenant and environment mutation gates are enabled.

## Read-only finding matrix

| Area | Conversation / chat path | Content Studio / Saved Templates path | Read-only finding | Required correction |
| --- | --- | --- | --- | --- |
| User intent and objective | Conversation widget exposes objective and persists its reviewed value; Content Studio modal infers from creative plus thread history. | Publishing page infers from selected asset and approved ICP when present. | Partial. The modal drops the selected conversation business profile and silently loads the first profile. | Propagate the selected business profile into the modal and persist its authoritative snapshot. |
| Selected business/workspace | Conversation page knows `selectedBusinessProfileId`. | Content assets/templates carry business profile and brand toolkit IDs. | Fail on the modal path; pass for asset-backed library items. | Preserve and display the selected profile/toolkit provenance. |
| AI prefill | Campaign name, URL, objective, ICP targeting, and keywords are prefilled. | Similar prefill exists for content assets. | Partial. Load failures are swallowed in the modal, leaving defaults that can look authoritative. | Show actionable readiness/prefill errors without exposing secrets. |
| Creative identity and revision | Durable widget accepts asset IDs and a revision, and stores a creative snapshot. Modal creative IDs are UI IDs such as `db-123`. | Content assets have versions; templates have version history. | Partial. Template revisions cannot enter the flow, and the modal does not persist normalized asset/version provenance. | Normalize asset IDs, persist source type/ID/version, and snapshot the exact creative used. |
| Saved Template compatibility | Not applicable to the conversation widget unless converted to an asset. | Reusable ad templates render without a “Review campaign” action; the publish page only accepts `assetId`. | Fail. Saved Templates cannot initiate a campaign. | Add a template deep link and load the exact owner-visible template/version into review. |
| Missing/invalid creative | Server requires at least one ad copy and validates Google RSA fields and keywords. | Empty asset lists produce an error state. | Partial. Synthesized RSA text can contain duplicate assets, and Saved Templates cannot enter review. | Deduplicate synthesized assets, preserve missing-creative errors, and add entry-path regression coverage. |
| Google credential and customer readiness | Readiness verifies OAuth, developer token, 10-digit customer, account reachability, currency, timezone, and rejects manager accounts. Durable widget displays a requested provider ID but server rechecks configured credentials. | Review page displays the verified account snapshot returned by Ads settings. | Mostly pass. Requested account IDs are advisory and not reconciled against the selected customer in the conversation resolver. | Reject a requested Google account ID that differs from the verified selected customer. |
| Campaign/ad-group/ad hierarchy | Durable queue creates campaign budget → campaign → one ad group and RSA per allocation, then keywords. | Same server workflow. | Pass for normal completion. Provider resource names are stored for campaign, budget, ad groups, and ads. | Add reconciliation evidence for uncertain/crash windows. |
| Headlines/descriptions/URLs/paths | Server validates 3–15 headlines (≤30), 2–4 descriptions (≤90), valid final URL, and paths (≤15). | Review UI exposes keywords, paths, tracking template, URL suffix, and final URL. | Partial. Default headline synthesis can create duplicate headlines, which Google may reject; tracking/final suffix validation is only length-based. | Deduplicate synthesized RSA text and surface provider-safe validation. |
| Budget units and currency | Widget collects minor units and converts once to major units; provider maps major units to micros. | Page/modal collect major units and server persists decimal major units. | Pass for conversion math and cap enforcement. | Keep unit conversion tests and display exact currency/account match. |
| Bidding | Widget relies on stored/default Google config. | Review page exposes budget mode, the supported no-target bidding strategies, match type, keywords, negatives, language IDs, paths, and tracking fields. | Pass for the reachable UI. The API also validates target values if Target CPA/ROAS are supplied by another client. | Keep target-dependent strategies out of review until their required values are collected. |
| Dates and timezone | Widget converts local datetime to an ISO instant. | Page/modal use date-only inputs converted to UTC. Account timezone is captured. | Fail. Provider date mapping slices UTC and can shift a user-selected date relative to the Google customer timezone. | Persist schedule timezone/date semantics and map provider dates in the selected account timezone. |
| Locations/languages/audiences/network | Locations require Google resource IDs; languages and network flags are mapped. Keywords provide search intent. | Age/gender controls are presented and required even for Google-only campaigns, though they are Meta-only. | Partial/misleading. | Scope age/gender to Meta, make Google-only validation truthful, and clearly label Google keyword/location/language targeting. |
| Approval and action-time confirmation | Conversation widget is backed by a durable, expiring, single-claim approval receipt. | Direct modal/page publish immediately after one button click and always set `autoActivate: true`. | Fail on direct UI paths. | Require a fresh explicit activation/spend confirmation and enforce it server-side. |
| Mutation gates | Tenant `live_provider_mutations_enabled` and environment `AD_PROVIDER_MUTATIONS_ENABLED` are both required. | Same. | Pass. Gated actions are persisted and deferred. | Keep the gated state truthful and non-successful in UI copy. |
| Durable persistence before submission | Campaign, creative snapshot, allocations, audit record, and queue rows are committed before workers mutate providers. | Same. | Pass. | Add exact source revision and activation confirmation to the durable snapshot/audit. |
| Idempotency and duplicate prevention | Widget claim is durable; campaign and queue keys are unique. | Per-open request keys prevent double-click duplicates. | Partial. A validation-failed direct review reuses the same key forever, so edits replay the stale failure. A worker crash after provider creation but before local resource persistence can leave an uncertain orphan. | Rotate keys after an editable failed review; persist/reconcile provider resources stepwise using deterministic resource identity. |
| Internal → Google mapping | Budget, campaign, bidding, network, dates, geo/language criteria, ad groups, RSAs, and keywords are explicitly mapped. | Same. | Mostly pass, subject to timezone and target-value defects above. | Add contract tests for every mapped field. |
| Google → internal mapping | Resource names and queue provider outcome are recorded; local status waits for provider success. | Same. | Partial. Keyword resource names remain only in the action outcome, and no explicit uncertain state exists. | Persist keyword receipts/evidence and distinguish retryable/uncertain reconciliation from confirmed failure. |
| Blocked/gated/queued/partial/failed/confirmed states | Conversation executor returns blocked, gated, queued, failed, or partial success; worker records processing/succeeded/failed. | Direct UI maps draft, validation failed, gated, queued, running, provider failed, published, and active. | Partial. Direct client type omits `blocked`, `partial_success`, and `uncertain`, while rejection copy can claim a draft was saved when none was created. | Unify state vocabulary and make rejection/recovery copy evidence-based. |
| Retry and reconciliation safety | Queue has attempts, leases, stale-claim recovery, provider resource graph checks, cleanup, and audit history. | Same. | Partial. Reconciliation begins only after a local campaign resource exists. | Reconcile deterministic Google resource identity before retrying uncertain work. |
| Deep links, reload, back/forward, detail/analytics | `/dashboard/ads?tab=campaigns` and provider detail links exist. | Publish page uses query parameters and returns to a caller-supplied path. | Partial. `from` accepts arbitrary strings and template identity is absent. Concurrent paid-ads navigation work owns the detail-page changes. | Constrain return paths to internal dashboard routes and add template/version parameters. Do not edit the concurrently owned paid-ads workspace files. |
| Error sanitization and recovery | Controller hides unexpected server failures; provider validation errors remain actionable. | UI shows API messages. | Partial. Modal silently ignores settings/inference failures; raw provider error text is stored and later displayed without a stable sanitized code. | Preserve a sanitized user message plus internal/provider evidence separately. |

## Implemented corrections

The correction pass fixed the defects directly reachable in the two entry paths without touching concurrently owned paid-ads workspace files:

- restore compilation and test coverage for the shared modal;
- preserve business profile, asset/template ID, and exact version provenance;
- allow Saved Templates to open the campaign review page;
- add fresh activation/spend confirmation and enforce it in the server contract;
- validate requested Google customer identity;
- make Google-only targeting and bid-strategy validation truthful;
- rotate editable failed-review idempotency keys;
- make schedule-to-provider date mapping timezone-aware;
- add deterministic Google resource reconciliation/persistence and receipt coverage;
- sanitize return paths and error/state copy.

The already-dirty paid-ads workspace/detail/navigation files are explicitly outside this task’s edit ownership. Their behavior will still be tested in Chrome, and any remaining discrepancy will be reported as an ownership blocker rather than overwritten.

Additional provider-safety work now:

- persists the selected creative source, exact asset/template revision, schedule semantics, account snapshot, and activation confirmation before queueing;
- revalidates confirmation and account readiness when an existing campaign is queued and again inside the provider worker;
- persists provider resource receipts as each Google resource is created and reconciles a deterministic campaign/ad-group/ad graph before a retry;
- records retryable provider outcomes as `uncertain` instead of misreporting a confirmed failure;
- deduplicates synthesized RSA assets and validates keyword length, final URLs, tracking templates, URL suffixes, and Google copy limits;
- sanitizes provider-facing errors into stable codes while retaining internal evidence for audit and recovery.

The Google API integration remains on v25. Google released v25 on 2026-07-22, released the non-breaking v25.1 update on 2026-08-19, and currently lists v25 sunset for August 2027. Campaign budget mapping continues to use micros and preserves the Search-campaign date requirements documented for campaign total budgets.

References:

- [Google Ads API release notes](https://developers.google.com/google-ads/api/docs/release-notes)
- [Google Ads API sunset dates](https://developers.google.com/google-ads/api/docs/sunset-dates)
- [Google Ads campaign budget overview](https://developers.google.com/google-ads/api/docs/campaigns/budgets/overview)

## Validation evidence

| Check | Result |
| --- | --- |
| Client publishing contracts | PASS — 2 files, 7 tests |
| Server provider/domain contracts | PASS — 7 suites, 32 tests |
| Server TypeScript check | PASS under the repository's Node 24 runtime |
| Focused client/server lint | PASS with warnings only; no errors |
| Server production build | PASS (`build:all`) |
| Authenticated Chromium, Conversation Builder asset → Google review | PASS through Settings; deterministic customer snapshot; activation unchecked; Publish disabled; no mutation; clean console/network audit |
| Authenticated Chromium, Saved Template → Google review | PASS through Settings; exact template review path; activation unchecked; Publish disabled; no mutation; clean console/network audit |
| Chromium trace rerun | PASS — 2/2 desktop tests in 22.3s; trace artifacts retained by the regression owner |
| Connected Chrome, production review | Existing production deployment still showed the pre-fix nested-button/targeting/activation UI, confirming this commit has not been deployed. No provider mutation was attempted. A later production reload received 502 responses from `/api/auth/me` and `/api/auth/csrf-token` and redirected to sign-in. |
| Client TypeScript / production build | Blocked by concurrently running Next development servers sharing and corrupting generated `.next/dev/types/routes.d.ts`; the generated directory and processes are foreign workspace state and were not removed or stopped. |

## Remaining ownership and delivery blockers

- `server/mastra/approvalHandlers.ts` is owned by the concurrent lead-generation task. Its Google rejection branch can still say that a campaign draft was saved without evidence that a draft exists. This task did not overwrite the owner’s changes.
- The paid-ads workspace/detail/navigation files are owned by concurrent tasks and were intentionally not changed.
- Deployment is intentionally withheld while the checkout contains concurrent unverified changes; deploying from this workspace could include work that this audit did not validate.
- No live campaign was activated, no ad spend was authorized, and no provider mutation was sent.
