# Viewing and using SEO, AEO, and GEO in SalesMarketing

This guide explains how an administrator enables AI Visibility and how a user creates a project, runs an audit, and reviews the SEO, AEO, and GEO results.

AI Visibility is intentionally disabled when migration `166_create_ai_visibility.js` is first installed. It will not appear in the customer dashboard until the migration has run and a super-admin makes the module available.

## 1. Prerequisites

Before enabling the module, confirm the environment has:

- Node.js `24.18.1` or newer (the supported workspace runtime).
- PostgreSQL for projects, audit stages, observations, scores, and recommendations.
- Redis and the BullMQ worker for executing audits.
- Private object storage for raw crawl artifacts, uploaded commerce feeds, and PDF reports.
- A running API application and Next.js client.
- Sufficient wallet credits on the account that will run the audit.
- Active OpenAI and Gemini credentials for complete GEO observations.
- An administrator-configured Google OAuth client when Search Console data is required.

The application never creates mock results when a crawler or provider is unavailable. Missing services will appear as warnings or failed stages.

## 2. Install and start locally

Run commands from the repository at `/Users/lakshmananr/projects/salesmarketing`.

Install dependencies:

```bash
pnpm install
```

Start the required infrastructure:

```bash
docker compose up -d postgres redis minio minio-init
```

Review and apply pending database migrations:

```bash
cd server
pnpm migrate:status
pnpm migrate:up
```

The migration list should show `166_create_ai_visibility.js` as applied.

Start the API in terminal 1:

```bash
cd /Users/lakshmananr/projects/salesmarketing/server
pnpm dev
```

Start the BullMQ worker in terminal 2:

```bash
cd /Users/lakshmananr/projects/salesmarketing/server
pnpm exec tsx workers/worker-entry.ts
```

Start the Next.js application in terminal 3:

```bash
cd /Users/lakshmananr/projects/salesmarketing/client
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in.

For Docker or production deployments, both the `api` and `worker` services must be running. Starting only the web client and API allows the screens to load, but audits will remain queued without the worker.

## 3. Enable AI Visibility as an administrator

The following steps require a super-admin account.

1. Open **Admin → Settings → Platform Access**.
2. The direct path is `/admin/dashboard/settings/platform-access`.
3. Find **AI Visibility** under **Module readiness**.
4. Change its status from **Disabled** to **Available**.
5. Select **Save controls**.

If a particular user still cannot see the module:

1. Open **Admin → Users** and select the user.
2. Open the user's **Module Access** page.
3. Find **AI Visibility**.
4. Set it to inherit the available global setting or explicitly enable it.

A user-level setting can restrict access, but it cannot override a globally disabled or maintenance-state module.

## 4. Configure live GEO providers

For full GEO coverage, configure and activate both grounded providers from **Admin → Integrations → LLM**:

| Provider | Administrator path | Required value |
| --- | --- | --- |
| OpenAI | `/admin/dashboard/integrations/llm/openai/add` | OpenAI API key and model |
| Gemini | `/admin/dashboard/integrations/llm/gemini/add` | Gemini API key and model |

Use the form's validation action before activating each credential. Provider calls are logged in the existing usage ledger. If a credential is missing or a request fails, the audit continues with a visible provider warning; it does not invent an answer.

## 5. Open AI Visibility

After the module is available, sign in as a normal application user. A new **AI Visibility** section appears in the main dashboard sidebar.

The direct overview URL is:

```text
/dashboard/ai-visibility
```

The sidebar contains:

| Screen | Direct path | Purpose |
| --- | --- | --- |
| Overview | `/dashboard/ai-visibility` | Website selection, scores, recent alerts, and analysis history |
| SEO | `/dashboard/ai-visibility/seo` | Deterministic crawl and on-page issues |
| AEO | `/dashboard/ai-visibility/aeo` | Editable questions, verified page coverage, and grounded answer drafts |
| GEO | `/dashboard/ai-visibility/geo` | OpenAI Search and Gemini Search observations, mentions, ranks, and citations |
| Commerce | `/dashboard/ai-visibility/commerce` | Product-feed quality and commerce score |
| Competitors | `/dashboard/ai-visibility/competitors` | Verified share of voice, prompt wins, citation share, content gaps, and tracked domains |
| Fixes | `/dashboard/ai-visibility/fixes` | Prioritized, evidence-backed recommendations |
| Assets | `/dashboard/ai-visibility/assets` | Draft content assets created from recommendations |
| Reports | `/dashboard/ai-visibility/reports` | Branded private PDFs, email delivery, CSV exports, and expiring revocable report links |

Opening a direct URL while the module is unavailable redirects or returns a module-access error. Enable the global module instead of bypassing this protection.

### Optional Google Search Console setup

AI Visibility reuses the administrator's encrypted **Gmail OAuth** client ID and client secret for Google authorization. In the same Google Cloud OAuth client, add this exact authorized redirect URI for each environment:

```text
https://<api-public-host>/api/ai-visibility/gsc/oauth/callback
```

Enable the Google Search Console API for that Google Cloud project. AI Visibility requests only the read-only Search Console scope. The user authorizes their own Google account; the refresh token is encrypted in the existing per-user credential store.

## 6. Select a website

AI Visibility does not ask you to recreate your brand or website. It automatically creates a private website workspace from the approved default **Business Profile**.

1. Open **AI Visibility**.
2. The approved default Business Profile is selected automatically.
3. Its first analysis starts automatically when no earlier analysis exists.
4. AI Visibility uses the profile’s company or business name, public website, industry/category, country, target geography, and brand aliases.

If the selected profile does not have a public HTTP or HTTPS website, the page links directly to **Settings → Business Profiles**. Add the website there, then return to AI Visibility. Existing audits retain an immutable snapshot of the profile data used when they started.

The page has one website selector and one **Add website** button. To analyze another domain, select **Add website**, enter a public HTTP/HTTPS address, and select **Add and analyze**. The domain becomes a reusable website workspace and its first analysis starts automatically. The selector lists the Business Profile website and every additional domain. No additional Business Profile is required.

Open **Competitors** to review evidence-based suggestions or add a competitor manually. Suggestions come only from Business Profile reference accounts or schema-validated provider observations, and every source is labeled. A suggestion without a verified official domain asks you to enter one before tracking; the system never invents a competitor website. Only explicitly tracked domains are crawled.

After an analysis completes, **Competitive visibility** compares the brand with tracked competitors using the same verified provider observations and crawl snapshots. It shows mention rate, share of voice, top-three prompt wins, citation share, crawl coverage, schema coverage, and the most-cited domains. A prompt win is counted only when that competitor appears and the brand is not verified in the first three positions.

**Verified content gaps** are not generic AI suggestions. A gap appears only when the latest competitor crawl contains an indexable page type, such as a comparison or pricing page, and the brand crawl contains none. Select **Create brief** to produce a reviewable counter-content brief in **Assets**. The draft retains the competitor pages as evidence, uses the existing Business Profile and Brand Toolkit, and explicitly instructs the writer not to copy competitor content.

For ecommerce projects, open **Commerce** and choose one catalog source:

- Select **Sync Shopify catalog** when the account already has a verified Shopify connection under **Assets → CMS connections**. The server reads products in pages through Shopify's Admin GraphQL API and stores the normalized catalog privately.
- Or upload a real CSV, JSON, or XML product feed of up to 15 MB and 100,000 products.

Commerce remains `not_applicable` until one source is ingested. A Shopify sync uses only fields returned by Shopify. It does not invent reviews, return policies, images, prices, inventory, or shipping data, and it records a visible gap when a field is absent. The sync is read-only, does not publish or modify store data, and does not use wallet credits. A catalog with more than 10,000 products or a product with more than 100 variants is not silently presented as complete; the request fails at the product limit and the snapshot records variant truncation where applicable.

## 7. Run the first audit

1. Return to **Overview**.
2. In **Recent analyses**, select **Analyze again** when you want a fresh measurement. The first Business Profile analysis starts automatically.
3. Open the new item under **Recent analyses**.
4. Watch each audit stage and its attempt count, progress, warnings, or error.

The audit runs these durable stages:

```text
intake
→ brand crawl
→ competitor crawls
→ SEO analysis
→ keyword/AEO/GEO prompt generation
→ provider collection
→ answer extraction
→ competitor analysis
→ scoring
→ fix generation
→ report generation
→ alert detection
→ final snapshot
```

Completed paid stages are skipped if the worker restarts or BullMQ retries the job. A failed competitor or provider can produce `completed_with_warnings` while retaining all successful observations.

AI Visibility uses the same application wallet shown in the dashboard sidebar. It does not create a separate balance or reserve a hidden maximum. The real base cost is charged when the analysis starts, then verified completed crawl, uncached provider observation, successful uncached structured extraction, and report units are added once when the run settles. Failed extraction calls, cached observations, reused manual corrections, and report retries are not billed as successful new units. If the wallet cannot cover a required direct charge, the API returns HTTP 402 or records a visible billing failure; retry idempotency prevents duplicate charges.

## 8. Read the SEO screen

Open **AI Visibility → SEO** after an audit completes.

The screen displays severity totals and individual issues containing:

- Rule ID and rule group.
- Critical, high, medium, or low severity.
- Affected URL or site-wide scope.
- Stored evidence from the crawl.
- A deterministic recommendation.

The rules cover metadata, headings, thin and duplicate content, canonicals, noindex directives, redirects, broken and orphan links, image alternative text, schema coverage, and sitemap/robots consistency.

SEO findings come from stored snapshots of real crawled pages. A blocked, timed-out, non-HTML, or uncrawlable page is shown as such and is never replaced by synthetic content.

The same page includes an optional **Google Search Console** card:

1. Select **Connect Search Console** and authorize a Google account that can read the website property.
2. AI Visibility selects a property whose hostname matches the chosen website when possible. If no exact host match exists, choose one of the properties returned by Google.
3. Select **Sync 28 days**. This reads finalized query-and-page rows for the 28-day period ending two days ago.
4. Review clicks, impressions, CTR, impression-weighted position, and evidence-backed opportunities.

An opportunity appears only when a real Search Console row has at least 50 impressions, average position from 4 through 20, and CTR below the displayed 5% review threshold. This is a prioritization rule, not an additional SEO score. Search Console notes that its API returns top rows and does not guarantee every row, so the UI labels aggregates as applying to the loaded rows. Connecting, selecting a property, syncing, and disconnecting do not use wallet credits.

If Search Console is disconnected, has no matching property, or a sync fails, the card remains explicitly unavailable and displays the error. It never creates placeholder traffic, queries, or opportunity scores.

## 9. Read and customize the AEO screen

Open **AI Visibility → AEO**.

AEO measures whether verified crawled content answers customer questions clearly. It considers concise answer passages, question-led headings, target-page matches, substantive page content, and supported FAQ, Q&A, or HowTo schema.

The screen contains an **Answer coverage** workspace. To add a question:

1. Enter the question a visitor or answer engine may ask.
2. Select informational, comparison, transactional, or local intent.
3. Optionally enter the page that should answer it.
4. Select **Add**.
5. Keep the question active so it joins the next analysis and its AEO score.

For every question, the latest completed analysis shows:

- `answered`, `partial`, or `uncovered` status.
- The strongest matching indexable page and its measured match percentage.
- The verified page signals that produced the match.
- A concise source passage when one could be extracted from the crawled page.

When a verified source passage exists, select **Create answer block** or **Create FAQPage schema**. The draft is added to the existing Content Assets workflow with the Business Profile, Brand Toolkit, analysis, question, source page, and validation evidence attached. It begins in `draft` approval state.

The module never writes an answer from unsupported assumptions. If no verified crawl passage answers the question, both draft actions remain unavailable and the question is shown as a content gap. Question changes affect subsequent analysis snapshots; completed scores remain immutable.

## 10. Read the GEO screen

Open **AI Visibility → GEO**.

For each generated prompt, the screen groups actual provider/API observations and displays:

- Provider and model.
- Observation status.
- Whether the brand was mentioned.
- Extracted brand rank when available.
- Answer text.
- Citation count and stored citations.
- Same-day cache label when an eligible generic observation was reused.
- Explicit errors when the provider did not return a usable observation.
- The structured extraction provider/model when derived metrics are available.
- A **Derived metrics unavailable** label when strict extraction failed.

Select **View citation sources** to inspect the stored source titles and URLs. Raw provider answers and citations are always retained. OpenAI or Gemini strict structured output derives brand mention, rank, sentiment, competitors, and recommendation/exclusion reasons. If neither provider returns schema-valid data, those metrics remain unavailable rather than being guessed with keywords or regular expressions.

For a completed observation, select **Correct extracted fields** to amend the derived fields. Saving updates the displayed observation immediately and reuses the correction for later runs of the same normalized prompt and provider without another extraction charge.

These results describe the configured provider APIs at the capture time. They do not claim to reproduce the exact output of a provider's consumer website or mobile application.

Brand-specific prompts are never shared through the generic cache. Generic prompts can reuse only an observation with the same provider, model, locale, normalized prompt hash, and UTC date bucket. Reused observations copy only previously validated or manually corrected derived fields and do not create a second provider or extraction charge in audit reconciliation.

## 11. Turn findings into work

Open **Fixes** to review recommendations ranked by severity, impact, effort, evidence, confidence, and affected page.

Available actions include:

- Change a recommendation from `open` to `in_progress`, `resolved`, or `rejected`.
- Select **Create draft** when the recommendation supports a generated asset.
- Open **Assets** to find the linked existing Content Asset.
- Review and approve the asset through the existing Content workflow.
- After approval, connect WordPress or Shopify in **Assets** and create an unpublished CMS draft.

CMS publishing is deliberately review-first. Open **Assets → CMS connections** and choose **Connect**:

- WordPress requires the public site URL, a username, and an application password.
- Shopify requires the permanent `store-name.myshopify.com` domain, an Admin API access token, a Blog ID, and an article author name.

The server verifies the credentials before encrypting and saving them. A CMS action is shown only for an approved asset version and always creates an unpublished WordPress post or Shopify article. It never publishes live content. Each attempt stores an immutable reviewed payload, asset version, fingerprint, destination ID, attempt count, reconciliation state, and owner-scoped idempotency key. If a response is uncertain, retrying the same action checks the deterministic slug/handle before creating another draft. CMS draft creation does not use AI Visibility analysis credits.

After the audit completes, open **Reports**. Each completed report provides:

- **PDF** — an authenticated download containing scores, methodology, provider fidelity, unavailable pillars, findings, citations, recommendations, and a data-driven 30-day plan.
- **Email** — attaches the completed PDF and sends it through the user's existing connected Gmail or verified Resend sender. Each attempt has an owner-scoped delivery receipt and idempotency key. Sending a report does not deduct AI Visibility analysis credits.
- **CSV** — a spreadsheet-safe export of the audit summary, scores, SEO issues, provider observations, recommendations, and competitor evidence. Unavailable pillars remain explicitly unavailable; the export never substitutes a score.
- **Share for 7 days** — a secret, expiring PDF link for a reviewer who does not have an account. Copy the complete link when it appears because the raw token is shown only once and is never stored. The **Active report links** card shows expiry, access count, and a **Revoke** action.

Anyone with an active secret link can view that one PDF until the link expires or is revoked. Shared responses are not cached or indexed. Create a fresh link if the first link was not copied or should no longer be used.

New PDFs use the approved Brand Toolkit linked to the selected website. The report snapshots the toolkit name, tagline, and validated six-digit brand colors at generation time, so later toolkit edits do not silently change an existing file. Unapproved, inactive, missing, or malformed toolkit styling falls back to the standard AI Visibility presentation. Branding never removes methodology or provider-fidelity disclosures. Existing PDFs can be rebuilt with the current approved toolkit through the report retry operation without another report-generation credit.

## 12. Review visibility alerts

When a completed analysis detects a verified regression or actionable gap, **Overview** shows a compact **Recent visibility alerts** card. Alerts can report:

- Meaningful score declines.
- Lost brand mentions.
- Newly observed competitors.
- Schema regressions.
- Unresolved high-impact recommendations.

Select **Acknowledge** after reviewing an alert. Acknowledgment preserves the alert in history and does not delete its evidence.

The customer workspace intentionally does not expose weekly-monitoring or estimated-maximum-usage controls. Scheduled monitoring remains an administrator-managed rollout capability, uses the same wallet, and enforces one audit per project and weekly period when enabled through the API. The API and worker must remain available for scheduled monitoring to execute.

## 13. Troubleshooting

### AI Visibility is not in the sidebar

- Confirm migration `166_create_ai_visibility.js` is applied.
- Confirm the global module is **Available**, not **Disabled** or **Maintenance**.
- Confirm the user's Module Access setting is not disabled.
- Sign out and back in, or refresh the platform-access state.

### The page returns 403 or says the module is unavailable

The API enforces the same module state as the client. A super-admin must update Platform Access; changing the URL or client navigation will not grant access.

### The audit stays queued

- Confirm Redis is reachable.
- Confirm `workers/worker-entry.ts` or the production worker bundle is running.
- Confirm the worker registered `ai-visibility-audit` and `ai-visibility-monitoring`.

### Audit creation returns HTTP 402

The selected account does not have enough shared-wallet credits for the next direct audit charge. Add credits or reduce configured competitors before retrying.

### SEO contains crawl warnings or no pages

- Confirm the website is public and uses HTTP or HTTPS.
- Review robots directives and firewall/bot protection.
- Confirm the server can resolve and safely reach the domain.
- JavaScript-only sites may need the separately configured browser/Apify fallback in a later deployment increment; the current crawler uses the safe HTTP path.

### One or more GEO providers are missing

- Open Admin LLM Integrations and validate the provider credential.
- Confirm the credential is active and has a supported model.
- Review the stored provider error in GEO or the audit-stage warning.
- Confirm the provider account has quota and billing available.

### The PDF is unavailable

- Wait for the report stage to complete.
- Confirm both deployment images install Chromium and set `BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`.
- Confirm private object storage is configured and reachable.
- Review the report-generation stage error on the audit page.

### The report email fails

- Connect Gmail or configure a verified Resend sender in **Settings → Integrations**.
- Confirm the completed PDF still exists in private object storage.
- Review **Reports → Email history** for the durable provider error.
- Sending is never reported as successful when the provider rejects the message.

### A CMS draft action is unavailable or fails

- Approve the exact generated asset version in **Content** first.
- In **Assets → CMS connections**, verify the destination again with current credentials.
- WordPress application passwords need permission to create posts.
- Shopify tokens need `write_content` or `write_online_store_pages`, and the configured Blog ID must belong to that store.
- Review the visible attempt error. An uncertain response remains labeled and can be retried safely; it is never reported as a successful draft without a destination ID.

## 14. Current release boundary

The current module includes production audit workflows, SEO/AEO/GEO screens, commerce feed validation, read-only Shopify catalog ingestion, Google Search Console query/page opportunities, verified competitor suggestions and visibility intelligence, evidence-backed counter-content briefs, customer-facing visibility alerts, fixes, content-asset linkage, approval-gated WordPress/Shopify draft creation, Brand-Toolkit-styled authenticated PDFs, durable email delivery, CSV exports, and revocable report links. Cost estimates and weekly-monitoring controls are not shown in the customer workspace.

It does not yet include live CMS publishing, causal attribution, post-publish comparison, or shared agency workspaces. See `AI_VISIBILITY.md` for the rollout and deferred-release contract.
