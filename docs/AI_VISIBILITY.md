# AI Visibility module

AI Visibility adds production SEO, AEO, GEO, competitor, commerce-feed, recommendation, reporting, report-distribution, and monitoring workflows to the existing platform. It reuses the current user ownership, JWT authentication, Brand Toolkits, business profiles, PostgreSQL, BullMQ/Redis, WebSockets, storage, notifications, provider usage ledger, and wallet.

For administrator setup, local startup, first-audit instructions, screen explanations, and troubleshooting, see [Viewing and using SEO, AEO, and GEO in SalesMarketing](./AI_VISIBILITY_USER_GUIDE.md).

## Rollout

Migration `166_create_ai_visibility.js` creates the module in the global `disabled` state. After deploying the API and worker bundles:

1. Run the normal server migration command.
2. Add active OpenAI and Gemini credentials under Admin → Integrations → LLM.
3. Set model names and optional `inputCostPerMillion` / `outputCostPerMillion` values in credential configuration when provider-cost estimates are required.
4. Review the five `ai_visibility_*` credit-pricing rows in Admin billing settings.
5. Enable `ai_visibility` globally for internal accounts, then use per-account access controls for the pilot.
6. Confirm both the API process and worker process are deployed. The worker registers the audit consumers and hourly monitoring sweep.

Do not enable the module if Redis, the worker process, encrypted credential access, private object storage, or wallet migrations are unavailable.

## Production behavior

- Audit launch creates all stage records and charges the configured real base cost directly from the existing wallet in one database transaction. HTTP 402 is returned when the wallet cannot cover that charge.
- Completed or warning stages are skipped on worker retry. Incomplete stages resume after worker restarts.
- Cancellation is honored between stages. Completed crawl/provider/report units are charged directly once using an audit-scoped idempotency key. If no billable work was consumed, the base charge is returned.
- Crawls use the existing SSRF-safe HTTP fetcher. Blocked, timed-out, non-HTML, and failed pages are stored explicitly. No synthetic crawl result is generated.
- OpenAI Responses with web search and Gemini with Google Search grounding use configured live API credentials. Missing or failed providers produce stored warnings and failed observation records.
- Generic prompts may reuse a same-day observation only when provider, model, locale, prompt hash, and UTC date bucket match. Brand-specific prompts are never cached. Cached rows retain `cached_from_run_id`.
- Provider calls are written to the existing provider usage ledger and admin credential counters. Full prompts and answers are not copied into that global ledger.
- Scores store a version and input fingerprint. Unavailable or not-applicable pillars are excluded and weights are re-normalized.
- Commerce stays `not_applicable` until a real CSV, JSON, XML, or connected Shopify catalog is ingested. Shopify products are paginated through the Admin GraphQL API; only returned product, variant, inventory, image, price, currency, availability, and shipping signals are normalized. The private source artifact and validation snapshot are retained, and missing return/review data remains a visible gap.
- Generated fixes become existing `content_assets` in `draft` approval state. An approved exact asset version can be sent to a verified WordPress or Shopify connection as an unpublished CMS draft; live publishing is not supported.
- PDF reports require the worker's Chromium installation, writable private object storage, and `BROWSER_EXECUTABLE_PATH`.
- Completed audits can be exported as formula-safe CSV. Completed PDFs can be shared through 256-bit bearer links whose SHA-256 hashes—not raw tokens—are stored. Links expire, can be revoked, are served with no-store/no-index headers, and never expose the private storage key.
- New PDFs snapshot the selected project's approved Brand Toolkit plus validated organization/workspace white-label defaults. Workspace values take precedence, and branding cannot remove methodology or provider-fidelity disclosures.
- Completed PDFs can be emailed through the user's existing Gmail or verified Resend sender. Delivery receipts are owner-scoped and idempotent; provider or credential failures remain visible and no AI Visibility analysis credit is charged for the email action.
- WordPress and Shopify credentials are verified, encrypted through the existing credential framework, and never returned to the client. CMS draft attempts are owner-scoped, immutable, idempotent, reconcilable by deterministic slug/handle, and do not deduct AI Visibility analysis credits.
- Google Search Console uses the administrator's Google OAuth client with a per-user encrypted refresh token. Properties are project-scoped, query/page snapshots are immutable and owner-scoped, and deterministic opportunities are shown only from successfully synchronized API rows. GSC actions do not deduct wallet credits or create a placeholder SEO score.

## Main API

All owner-management endpoints are below `/api/ai-visibility` and require authentication plus `requireModuleAccess('ai_visibility')`. The public exceptions are `GET /shared-reports/:token`, where an unexpired, unrevoked 256-bit bearer token authorizes read-only access to one completed PDF, and the Google Search Console OAuth callback, which is authorized by a signed, expiring state bound to one user and project.

- Automatic Business Profile website onboarding, reusable arbitrary website searches and history, competitors, audits, status, and cancellation. The customer workspace shows the audit and grounded-provider credit ceiling before a manual run; weekly-monitoring controls remain administrator-managed.
- Overview, SEO findings, AEO questions, GEO provider observations, commerce snapshots, recommendations, assets, alerts, and reports.
- AEO question CRUD, CSV/JSON/XML commerce feed upload, and Shopify catalog synchronization through the existing encrypted connection.
- Extraction correction storage keyed by normalized prompt and provider.
- Authenticated PDF download at `/audits/:auditId/report`.
- Authenticated CSV export, report email delivery/history, report-share creation/list/revocation, and token-authorized shared PDF viewing.
- CMS connection readiness plus approval-gated WordPress and Shopify draft creation/history under project-owned asset endpoints.
- Google Search Console authorization, property selection, 28-day query/page synchronization, and deterministic SEO opportunities under project-owned endpoints.
- Agency organizations and client workspaces under `/workspaces` and `/organizations`, including existing-account membership, role changes, and validated white-label defaults.
- Shared exact-version asset approval through `/projects/:projectId/assets/:generatedAssetLinkId/approval` with immutable decision history.

Project, audit, and prompt-run routes resolve an active workspace membership before using the durable owner tenant. Project IDs alone never authorize access. Owners retain the original `user_id`; migration `198_add_ai_visibility_agency_workspaces.js` adds private owner workspaces without moving audits, reports, scores, or assets.

Workspace roles are intentionally narrow:

- Owners can manage members, external credentials, and wallet-billed analyses.
- Agency admins can edit the workspace and manage non-owner members, but cannot spend the owner's wallet or change credentials.
- Editors can edit analysis configuration and review assets, but cannot manage members, billing, or credentials.
- Client reviewers have read-only analysis access plus approve/reject access for an exact generated-asset version.

Shared/client websites remain in the existing single website selector. The UI does not add a second agency or client dropdown.
Owners and agency admins open **Reports → Sharing & branding** to update the workspace label, client/private mode, report identity, and members. This management form stays inside a dialog so the Overview, SEO, AEO, GEO, Competitors, Fixes, and Assets screens retain the same compact layout.

## Operational metrics

Monitor BullMQ duration and failure counts for `ai-visibility-audit` and `ai-visibility-monitoring`, crawl success rate, failed provider observations by provider/model, same-day cache hit rate, token/cost ledger entries, audit warning rate, PDF generation failures, and direct-wallet charge idempotency.

## Deferred releases

The foundation deliberately leaves external side effects and shared ownership out of the pilot:

- Live CMS publishing. Shopify content actions remain draft-only.
- Post-publish re-crawls and before/after attribution.
- Cross-organization user directories, invitation email delivery, and bulk client migration tooling.

Those releases should use the existing encrypted integration framework and retain the same ownership, idempotency, approval, and no-synthetic-data guarantees.
