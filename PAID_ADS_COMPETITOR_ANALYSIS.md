# Paid Ads competitor analysis: feature, changed files and deployment

Reviewed: 18 November 2026. Repository baseline: `f2ffc91d` (`ad campaign profile analysis`).

This report describes the current working copy, including uncommitted modifications and untracked files. It is based on source inspection and focused automated tests. Production deployment and live Meta access were not tested during this review.

## What the feature does

Open **Performance Marketing → Paid Ads → Recommendations → Competitor creative research → Matching advertiser profiles**. Click **Fetch competitor profiles**, then **Fetch ads** for a candidate advertiser.

The feature helps users study public competitor messaging, offers, calls to action and creative formats, and prepare original campaign ideas for their own business. It searches Meta's public Ad Library for active ads in India. It does not require a connected Meta advertising account for this live discovery flow. Users still need application authentication, access to the Performance Marketing module, the feature flag, and an approved default business profile.

The application can show advertiser names, observed ad copy, Library IDs, source links, detected format and delivery start dates when recognizable. It inspects each returned ad for public transparency reach and location/age/gender breakdowns when available. Missing values stay unavailable. The current extractors leave likes, comments and shares null.

The public sample does not provide competitor CTR, spend, leads, conversions, CPA or ROAS. Candidate ranking uses matching business terms and distinct observed ad counts, not performance. Displayed names do not verify Facebook Page identity. India is fixed for live discovery; reach details may describe EU or UK delivery and must be read with their location labels.

Users can copy an observed ad into the optional manual research form, review and save evidence, and request creative suggestions. The campaign creation page also supports reference-ad context through validated URL parameters and prepares a review-only brief for the Performance Marketing agent. That page support does not mean every public ad card currently offers a direct campaign handoff. The discovery flow itself does not publish ads.

## How it works

1. The API reads the user's approved default `company_settings` record.
2. `businessSearchTerms()` derives at most three distinct phrases from sub-industry, business category, industry and target market. Each phrase must be 3–100 characters and differ from the business name.
3. The selected fetcher loads `https://business.facebook.com/ads/library/` with `country=IN`, `ad_type=all`, `active_status=active` and the encoded keyword.
4. A shared TypeScript parser extracts a bounded visible sample, capped at 60 card chunks per search. This is not a complete archive crawl.
5. Discovery groups advertiser names, excludes the exact own-business name, and returns at most 20 candidates, ordered by matched terms and sample ad count.
6. Fetching a candidate's ads searches its displayed name and filters cards by the same name, ignoring case and surrounding whitespace.
7. The client checks ad details with at most two concurrent requests per open panel. Details verify the requested Library ID before accepting the observation.
8. Live observations remain transient until the user chooses to save research. Existing research and creative-brief services handle saved evidence separately.

### Scrapling and Playwright

| Component | Purpose in this implementation |
| --- | --- |
| Scrapling | Default public-page fetcher. Python `StealthyFetcher` renders the page and performs search/detail interactions through its browser automation dependencies. The pinned requirement is `scrapling[fetchers]==0.5.1`. |
| Python adapter | `meta_ad_library_scrapling.py` validates the fixed public host/path, reads visible text and transparency tabs, and returns JSON to Node. Diagnostic output goes to stderr. |
| Node bridge | `MetaAdLibraryFetcher.ts` selects the provider, locates the Python script/interpreter, invokes it without a shell, enforces a 90-second process timeout and validates the JSON result. |
| Playwright | Alternative Node implementation using `playwright-core`. It launches Chrome/Chromium, reads rendered cards, opens ad detail dialogs and reads transparency tabs. |
| Chromium | Browser engine required by both options. Installing only the JavaScript or Python package is insufficient without an available browser executable. |
| Shared parsers | `PublicMetaAdLibraryService.ts` parses card text and transparency text for both providers, keeping returned evidence consistent. |
| Optional OpenAI diagnostics | If `OPENAI_API_KEY` is configured, screenshots from some unrecognized-page failures can be classified for diagnosis. It does not supply competitor metrics or control the extractor. Public discovery can run without this key. |

`META_AD_LIBRARY_FETCHER=scrapling` selects Scrapling; `playwright` selects Node Playwright. Omission defaults to Scrapling. Invalid values fail configuration validation. A failed fetch does not automatically switch providers. Python browser traces while using Scrapling do not imply that the Node Playwright path ran.

Recognized no-results text produces `empty`; missing dependencies, blocked pages, timeouts and unknown layouts produce `provider_error`. Partial discovery retains candidates already collected. Detail pages without public reach produce `unavailable`. The adapter disables Cloudflare solving and does not implement login or CAPTCHA handling.

## Files changed for this feature

Statuses below are relative to the checked-out HEAD before this report was created: **M** means tracked modification; **New** means untracked. This is a feature-focused inventory, not the entire dirty working tree.

### UI and shared contract

| Status | File | Change / purpose |
| --- | --- | --- |
| M | `client/src/components/performance-marketing/CreativeResearchPanel.tsx` | Public advertiser discovery, fetching matching ads, detail progress, reach display and copying observations into manual research. |
| M | `client/src/__tests__/creativeResearch.test.tsx` | UI coverage for the updated research flow. |
| M | `client/src/app/dashboard/(main)/ads/create/page.tsx` | Validates reference-ad parameters, shows source context and includes original-creative instructions in the campaign-agent brief. |
| New | `client/src/__tests__/paidCampaignFromAd.test.tsx` | Coverage for reference-ad campaign brief context. |
| M | `shared/adCreativeIntelligence.ts` | Optional nullable public engagement fields on creative references. |

### API, browser extraction and configuration

| Status | File | Change / purpose |
| --- | --- | --- |
| M | `server/routes/creativeIntelligence.routes.ts` | Public discovery/name-based ad routes, detail endpoint, provider capabilities and response headers. |
| M | `server/services/ads/creative-intelligence/CompetitorProfileDiscovery.ts` | Moves live discovery from account/Page-ID API lookup to business-derived public India searches. |
| New | `server/services/ads/creative-intelligence/PublicMetaAdLibraryService.ts` | Both public browser flows, shared parsing, detail/reach extraction and screenshot diagnostics. |
| New | `server/services/ads/creative-intelligence/MetaAdLibraryFetcher.ts` | Provider selection and Node-to-Python execution bridge. |
| New | `server/scripts/meta_ad_library_scrapling.py` | Scrapling browser adapter for public search and details. |
| New | `server/scripts/requirements-scrapling.txt` | Pinned Python fetcher dependencies. |
| M | `server/services/ads/creative-intelligence/MetaAdsLibraryResearchService.ts` | Separate legacy Graph API research path: clearer provider/permission errors and country-specific field selection. |
| M | `server/env.ts` | Adds fetcher startup validation/logging; also contains unrelated database/environment changes. |
| M | `server/nodemon.json` | Watches Python and environment configuration changes; excludes the local Python virtual environment. |
| M | `server/.env.development` | Feature/provider defaults; contains other environment edits as well. |
| M | `server/.env.production` | Feature/provider defaults. Docker deployment must inject these values through `server/.env` or Compose environment. |

Environment values are intentionally not reproduced beyond the non-secret feature settings. `server/.env` is an ignored runtime configuration file, not a feature source file to commit.

### Container packaging, tests and existing documentation

| Status | File | Change / purpose |
| --- | --- | --- |
| M | `server/Dockerfile` | Debian runtime with Chromium, Python virtual environment and Scrapling dependencies; retains the Alpine builder. |
| M | `.dockerignore` | Includes `requirements-scrapling.txt` despite the general text-file exclusion and excludes the local virtual environment. |
| M | `.gitignore` | Excludes the virtual environment and allows the three feature documentation files. |
| M | `server/tests/creativeIntelligence.test.ts` | Public URL/parser, transparency, research contract and discovery helper coverage. |
| New | `server/tests/metaAdLibraryFetcher.test.ts` | Provider selection, public results, unavailable data and failure handling. |
| New | `server/tests/competitorFetcherRouting.test.ts` | Route wiring, capabilities and provider/cache headers. |
| New | `server/tests/meta_ad_library_scrapling_test.py` | Python adapter URL validation, extraction, screenshots, identity checks and transparency regions. |
| M | `server/tests/containerRuntimePolicy.test.ts` | Checks runtime packaging requirements. |
| M | `server/tests/aiVisibilityFoundation.test.ts` | Updates an existing browser-runtime assertion to accommodate Debian package installation. |
| New | `docs/paid-ads-competitor-profile-research.md` | Current flow and configuration followed by historical API context. |
| New | `docs/paid-ads-public-library-plan.md` | Public-search design and earlier recorded live inspection. |
| New | `docs/paid-ads-meta-competitor-flow-2026-10-12.md` | Historical account/Page-ID API workflow. |

Related paid-ad integration modifications are in `server/controllers/paidAdAccountsController.ts` and `server/services/ads/PaidAdAccountsService.ts`: account-discovery error handling and skipping unreadable older Page credentials. They support connected paid accounts but are not prerequisites for public discovery.

Earlier commits already introduced parts of this feature: `22bf49a8` added automated competitor discovery; `f2ffc91d` refined profile analysis and account integration. The latter also touched `server/controllers/adPlatformOAuthController.ts`, `server/models/platformAccess/functions.ts`, `server/services/ads/creative-intelligence/CreativeIntelligenceService.ts` and `server/services/ads/creative-intelligence/contracts.ts`; these are committed baseline files, not additional current modifications.

The remaining login/onboarding/setup, Gmail/outreach/email queue, local database helper, migration 201, generated coverage/results, editor settings and npm lockfile changes are outside this public competitor-analysis change. The only current `server/package.json` edit adds a local production-database helper; `playwright-core` already exists in the dependency manifest. Docker uses the existing pnpm workspace lockfile.

## Deploy and start on the existing production server

These commands are for the repository's existing Docker Compose production installation. They assume the application database/schema, Redis, reverse proxy, volumes and production credentials are already configured. This feature has no separate always-running scraping server: browser work starts inside API requests.

### 1. Deliver the reviewed source

Include the new untracked feature files in the release, especially both TypeScript services, the Python adapter and its requirements file. An ordinary Git pull cannot deliver uncommitted or untracked local files. Review and commit the intended changes before updating the server checkout to that release. Avoid staging the whole mixed working tree blindly.

On the server, start in the path used by the existing deployment script:

```bash
cd /var/www/salesmarketing
```

### 2. Configure the feature

Set or replace these entries in the existing `server/.env`; preserve the application's existing secrets and infrastructure settings:

```dotenv
AD_CREATIVE_INTELLIGENCE_ENABLED=true
META_AD_LIBRARY_FETCHER=scrapling
META_AD_LIBRARY_PYTHON=/opt/scrapling/bin/python
META_AD_LIBRARY_CHROME_PATH=/usr/bin/chromium
```

The Dockerfile supplies the Python and Chromium path defaults already. Setting them explicitly makes the intended runtime easy to inspect. Production Compose reads `server/.env`; environment-specific files are excluded from the Docker build context. Editing only `.env.production` will not enable the feature in the built container.

Production Compose also requires existing `REDIS_PASSWORD`, `DB_RUNTIME_USER`, `DB_RUNTIME_PASSWORD` and `HERMES_API_KEY` values for interpolation. The API requires its normal production secrets, database and Redis settings. Public discovery does not require a Meta access token; the separate legacy API research and publishing flows still require their own connection and permissions.

### 3. Rebuild and recreate API and client

Run from the repository root on the existing server. Sequential builds follow the repository's production deployment practice:

```bash
set -euo pipefail
docker compose --env-file server/.env -f docker-compose.production.yml build api
docker compose --env-file server/.env -f docker-compose.production.yml build client
docker compose --env-file server/.env -f docker-compose.production.yml up -d --no-deps --no-build api client
docker compose --env-file server/.env -f docker-compose.production.yml ps api client
curl --fail --retry 15 --retry-connrefused --retry-delay 2 http://127.0.0.1:8080/health
```

`--no-deps` assumes the existing production installation has already initialized the upload volume and its permissions. For a fresh installation, use the normal full application provisioning/deployment process first. Do not run this shortcut concurrently with another deployment. There is no new migration specifically for the public browser adapter; existing saved-research tables and approved business-profile schema must already exist. Review pending migrations as part of the normal release process.

The worker image does not need Scrapling for live discovery; these calls execute in the API. Existing workers remain necessary for the application's queued saved research/brief generation and other background work. Rebuild workers as part of a broader release if shipping their unrelated changes.

The existing root `deploy.sh` performs a broader production deployment, including Git push/pull, backups, all image builds, migrations and Nginx changes. It is not a feature-only start command.

### 4. Verify installed browser dependencies and logs

```bash
docker compose --env-file server/.env -f docker-compose.production.yml exec -T api /opt/scrapling/bin/python -c 'from scrapling.fetchers import StealthyFetcher; print("Scrapling import OK")'
docker compose --env-file server/.env -f docker-compose.production.yml exec -T api /usr/bin/chromium --version
docker compose --env-file server/.env -f docker-compose.production.yml logs --tail=100 api
```

These checks establish installed dependencies, not successful access to Meta. Log in to the app with Performance Marketing access, open the panel and inspect the authenticated capabilities response:

```text
GET /api/campaigns/creative-intelligence/capabilities
Expected fields: enabled: true, metaAdLibraryFetcher: "scrapling"
```

Fetch profiles and ads. In the browser Network panel, competitor responses should include `X-Meta-Ad-Library-Fetcher: scrapling` and `Cache-Control: no-store`. Confirm that an approved default business profile produces usable search terms, selected advertiser names match displayed cards, and unavailable reach remains unavailable. Finally test saving a manual observation and generating a brief if that workflow is part of the release.

### Switch to Playwright

Change `META_AD_LIBRARY_FETCHER=playwright` in `server/.env`, retain `/usr/bin/chromium`, then recreate the API so its injected environment changes:

```bash
docker compose --env-file server/.env -f docker-compose.production.yml up -d --no-deps --force-recreate api
```

A plain container restart does not reload Compose `env_file` values. Verify the capabilities response and provider header again. Playwright does not require the Python adapter, but it does require Chromium. Switching providers does not guarantee access when Meta denies requests.

### Optional native Linux installation

Docker is the deployment path already configured in this repository. For a native installation, use Node `>=24.18.1 <25`, pnpm `10.30.3`, Python 3.10+ and an installed Chrome/Chromium browser with its OS libraries. From the repository root:

```bash
corepack enable
corepack prepare pnpm@10.30.3 --activate
pnpm install --frozen-lockfile
python3 -m venv server/.venv-scrapling
server/.venv-scrapling/bin/python -m pip install -r server/scripts/requirements-scrapling.txt
pnpm --filter salesmarketing-server build
```

Configure the feature and existing application environment in your process manager, using absolute paths to `server/.venv-scrapling/bin/python` and the installed browser for the two path variables. Start the API from the repository root:

```bash
NODE_ENV=production node server/dist/index.js
```

Keep `server/scripts/meta_ad_library_scrapling.py` and its dependencies alongside the built server: copying only `dist/index.js` is insufficient. For native bundled execution, use process-manager environment injection; the bundled environment loader resolves files relative to `dist`, so do not assume it reads the source-directory `server/.env`. Production needs a process manager/restart policy, the client, existing worker processes and the normal reverse proxy.

## Review findings and practical limits

- **Historical documentation differs from current behavior.** The October flow document describes the earlier account-required UK/EU API path. Use this report and the current public-flow section for the live recommendation feature. The older API service remains separate.
- **Browser load grows with usage.** Each Scrapling request starts a Python process/browser; each Playwright request launches a browser. The UI limits detail requests to two per panel, but this code has no shared browser pool or feature-wide concurrency limit. Capacity-test expected concurrent users before a larger rollout.
- **Discovery is synchronous.** Up to three sequential searches can consume roughly three 90-second Scrapling process budgets. The repository's general Nginx API timeout is 300 seconds; check any upstream proxy/load-balancer timeout as well. Slow searches and blocked pages remain operational failure cases.
- **Page layout is an external dependency.** English visible labels and dialog names drive extraction. Unit tests validate contracts with mocks and fixtures, not the current live Meta layout or Chromium runtime on the server.
- **Exact name filtering can yield no cards after a successful search.** `getCompetitorProfileAds()` preserves the underlying search status even if its exact-name filter removes every card. Consumers should check the references array as well as status.
- **Screenshots use temporary local storage.** Failure screenshots are logged by path; these functions do not remove them or persist them to a central artifact store. Set an operational retention policy if failures accumulate.

## Validation performed

On 18 November 2026, all selected existing tests passed:

| Checks | Result |
| --- | --- |
| Server: `metaAdLibraryFetcher`, `competitorFetcherRouting`, `creativeIntelligence`, `containerRuntimePolicy` | 4 suites, 40 tests passed |
| Client: `creativeResearch`, `paidCampaignFromAd` | 2 files, 12 tests passed |
| Python: `meta_ad_library_scrapling_test.py` | 6 tests passed |

Reproduction commands, from the repository root:

```bash
(cd server && NODE_OPTIONS=--experimental-vm-modules ./node_modules/.bin/jest --runInBand tests/metaAdLibraryFetcher.test.ts tests/competitorFetcherRouting.test.ts tests/creativeIntelligence.test.ts tests/containerRuntimePolicy.test.ts)
(cd client && ./node_modules/.bin/vitest run src/__tests__/creativeResearch.test.tsx src/__tests__/paidCampaignFromAd.test.tsx)
(cd server && python3 -B -m unittest discover -s tests -p '*scrapling_test.py')
```

The local Node executable was v20.19.1, below the repository's production engine requirement. These passing focused tests do not substitute for a production Node 24 image build. No full build, full test suite, live scraping, server restart or deployment was performed in this review. Application source code was not changed by this documentation task.
