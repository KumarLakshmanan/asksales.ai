# Paid Ads competitor profile research

> Updated 16 November 2026: the **Matching advertiser profiles** recommendation supports Scrapling and Playwright against the public Search ads page for active **All ads** in **India**. Scrapling is now selected by default. It does not require a connected Meta account. The historical API design below describes the earlier implementation and the legacy saved research service. See [the public page plan and inspection results](paid-ads-public-library-plan.md).

## Current public page flow

The server reads the approved default business profile and derives up to three search phrases from sub-industry, business category, industry and target market. The configured fetcher opens Meta's public `business.facebook.com/ads/library/` Search ads page with `active_status=active`, `ad_type=all`, `country=IN`, and the phrase in `q`. It reads at most 60 visible ad cards per search, groups the displayed advertiser names, and excludes the exact business name. **Fetch ads** searches by that advertiser name and shows only cards whose displayed names match exactly. Name matching is not proof of Facebook Page identity.

### Fetcher configuration

Set these server environment variables in `server/.env` (local overrides), `.env.development`, or `.env.production`, then restart the API:

```dotenv
AD_CREATIVE_INTELLIGENCE_ENABLED=true
# scrapling | playwright; defaults to scrapling if omitted
META_AD_LIBRARY_FETCHER=scrapling
# Optional Python executable; otherwise uses server/.venv-scrapling/bin/python, then python3
# META_AD_LIBRARY_PYTHON=/absolute/path/to/python
# Optional Chrome/Chromium executable; otherwise uses installed Google Chrome
# META_AD_LIBRARY_CHROME_PATH=/absolute/path/to/chromium
```

The selection applies to profile discovery, **Fetch ads**, and **ad details / transparency reach**. Set `META_AD_LIBRARY_FETCHER=playwright` to use the existing Node Playwright flow. Invalid provider values are configuration errors; provider failures never silently switch engines.

Provider selection happens before loading Node Playwright, which is imported only for `playwright` requests. The API logs the configured provider at startup, the provider for each public search/detail operation, and the Python executable whenever it starts Scrapling. `GET /api/campaigns/creative-intelligence/capabilities` reports `metaAdLibraryFetcher`; competitor responses include `X-Meta-Ad-Library-Fetcher` and `Cache-Control: no-store` for verification in the browser's Network panel. These endpoints still require the normal authenticated session.

Restart `npm run dev` once after installing this update to load the new watcher configuration. Development now watches `.env`, `.env.development`, `.env.production`, and the Python adapter, so subsequent edits restart the API and reload configuration. Production deployments require the normal process/container restart when environment values change. Seeing Chromium or Python/Patchright browser traces is expected with Scrapling's browser fetcher and does not indicate a fallback to the Node Playwright provider.

For a native installation, use Python 3.10+ and Google Chrome:

```sh
cd server
python3 -m venv .venv-scrapling
.venv-scrapling/bin/python -m pip install -r scripts/requirements-scrapling.txt
```

Scrapling 0.5.1 is pinned. Its documented [`StealthyFetcher.fetch(..., page_action=...)`](https://scrapling.readthedocs.io/en/latest/fetching/stealthy.html) renders JavaScript and runs the public page interactions. Scrapling itself uses Chromium automation through Python/Patchright. The Node API invokes a fixed Python script without a shell and validates its JSON response. Searches share the same TypeScript card parser across both providers. Details verify the requested Library ID and share the transparency parser. Calls have a 90-second process timeout and bounded output. Missing dependencies, HTTP denial, timeouts, login pages and unknown layouts return `provider_error`; recognized no-results text returns `empty`. No private ad performance is inferred.

The API Docker runtime uses Debian with Python, the pinned Scrapling fetcher dependencies and system Chromium configured through `META_AD_LIBRARY_CHROME_PATH`. Rebuild the API image for this change. The worker image is unchanged because these live recommendation requests run in the API. Native installations can use a custom Chromium executable instead of Google Chrome by setting the same variable.

If the page layout cannot be recognized, the server attempts to save a screenshot in a temporary `meta-ad-library-*` directory and reports an unavailable status. When `OPENAI_API_KEY` is configured, a vision model classifies the screenshot for operator diagnosis; the model's answer never supplies scraping selectors or bypasses access controls. The log records the screenshot path. The feature flag `AD_CREATIVE_INTELLIGENCE_ENABLED=true` is still required.

Selecting **Add observed ad to research** copies one public observation into the manual research form for user review before saving. The public search does not infer CTR, spend, conversions or winning creative. A 403 from Meta is shown as unavailable, not as zero competitors. The supplied `www.facebook.com` link returned a blank HTTP 403 during local validation; the equivalent public `business.facebook.com` page loaded with India, All ads and active results.

## Earlier API design (historical)

The sections below record the earlier UK/EU API workflow and are retained for migration context. They do not describe the current Matching advertiser profiles recommendation.

### What the user saw

Open **Paid Ads → Recommendations → Competitor creative research**. The page loads connected Meta ad accounts and, for a supported delivery country, automatically searches for advertisers using the approved default business profile. Each candidate shows its Facebook Page name, the saved business terms that matched, and the number of distinct ads in the discovery sample. Select **View ads** to retrieve that Page's currently active ads. Each ad links to its public Meta Ads Library record; **Open profile in Meta Ads Library** opens the Page-level public view.

Advertisers are *candidates*, not verified direct competitors. An ad matching an industry term can be from a reseller, marketplace, publisher, or unrelated business. The user should inspect the Page and ads before drawing a comparison.

## Data flow

1. `GET /api/campaigns/creative-intelligence/capabilities` reports whether creative intelligence is enabled and which delivery countries have commercial Meta Ads Library API coverage.
2. The browser loads the user's connected Meta ad accounts from `/api/campaigns/accounts` and selects the first available Meta account.
3. `GET /api/campaigns/creative-intelligence/competitor-profiles?accountId=…&country=…` reads the user's **approved default** `company_settings` row. It derives up to three search phrases from sub-industry, business category, industry, and target market. No competitor name or ad URL is requested.
4. The server resolves the selected account's Meta credential for that user, calls the official `ads_archive` endpoint for active ads in the selected country, and groups the bounded result by `page_id`. It excludes the user's Page ID and exact business name. The API response contains Page IDs, names, matching business terms, and sample counts; no access token is returned.
5. Clicking a candidate calls `GET /api/campaigns/creative-intelligence/competitor-profiles/:pageId/ads?accountId=…&country=…`. This calls `ads_archive` with `search_page_ids` for that Page and displays the returned ad text, platforms, delivery dates, and public Library links. The fetch is read only; it does not modify a provider account.

Both searches use the existing three-page, 150-ad upper bound and fixed Meta Graph host. Meta permissions, API errors, and incomplete samples are shown as status messages. These profile and ad requests are live reads; they are not stored as research runs. The existing **save ad research for creative suggestions** flow remains available for generating a brief from saved observations.

## Availability and meaning of performance

The official commercial Ad Library API path in this app covers UK/EU delivery countries. The selected Meta account must have working Ads Library access; ordinary ad reporting access alone may not suffice. For unsupported countries, the page links to Meta's public Ad Library and explains that automatic API profile discovery is unavailable. If no approved default business profile has a usable category or market, the user must fill that business information first.

Commercial competitor ads expose creative content, advertiser Page, placement, and delivery dates when Meta returns them. For EU-delivered ads, Meta may also return **estimated EU reach**, which the page shows when present. They do **not** expose campaign/ad-set structure or private outcomes such as CTR, conversion rate, leads, CPA, ROAS, or normal commercial spend. The UI therefore calls these **ads**, does not present them as internal campaigns, and marks those performance figures unavailable. Delivery duration and the count of ads in a bounded search sample are activity observations, not proof that an ad performed well.

## Setup and verification

Enable `AD_CREATIVE_INTELLIGENCE_ENABLED=true`, connect a Meta ad account with appropriate Ads Library API access, and approve a default business profile with industry, business category, sub-industry, or target market. Select a supported delivery country in the panel. Verify discovery with a real authorized Meta credential and confirm that clicking a returned Page displays only ads for that Page. Automated contract tests cover Page-ID filtering, grouping, and exclusion of the user's own business; live provider results depend on Meta access and current archive contents.

Meta's [Ad Library API documentation](https://www.facebook.com/ads/library/api/) defines `search_page_ids`, available fields, and commercial archive coverage.
