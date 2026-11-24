# Meta Ads connection and competitor recommendations

Updated 12 October 2026.

## User journey

1. Connect Meta Ads in **Integrations → Meta Ads**. OAuth records the authorized user token, available ad accounts and Pages, and the selected binding. The callback now runs Paid Ads account discovery after saving the connection. Changing the binding also refreshes discovery.
2. Open **Performance Marketing → Paid Ads → Recommendations → Matching advertiser profiles**. The dropdown reads `GET /api/campaigns/accounts`. If no Meta account is in that inventory but the OAuth connection is active, the page calls `POST /api/campaigns/accounts/discover` once and fills the dropdown from the verified result. **Find Meta accounts again** retries this step. A failed or empty result gives a visible Integrations link.
3. Choose a Meta account and an eligible delivery country. For UK/EU delivery, profile discovery reads the approved default business profile, searches up to three category or market terms in Meta Ads Library, groups the bounded public ad sample by advertiser Page ID, and excludes the user's own Page and exact business name. Matches are candidates; the user must verify that each is a competitor.
4. **View ads** retrieves active public ads for that Page ID. The server filters the response by the same Page ID. Each ad links to its public Meta Ads Library record. The panel shows observed copy, placements, delivery dates and estimated EU reach when supplied.
5. **Use this advertiser for creative suggestions** starts a Page-scoped saved research run. After it finishes, the user enters verified product facts and audience, then requests draft creative concepts. Concepts carry evidence IDs and an uncertainty statement. Handoff to the campaign agent is a separate user action; this flow never publishes an ad.

## What a recommendation means

The public archive shows what an advertiser ran, not the structure or outcome of its private campaign. Ordinary competitor ads do not provide CTR, conversions, leads, CPA, ROAS or commercial spend. Long delivery duration, repeated copy, many ads in a sample, or estimated EU reach are observations, **not evidence that a campaign performed well**. Recommendations therefore propose creative tests for the user's own connected account, where actual result metrics can be measured. The UI explicitly says that it cannot identify a winning competitor campaign.

Meta's [official Ad Library API documentation](https://www.facebook.com/ads/library/api/) describes the available fields and UK/EU commercial-ad coverage. India and other unsupported delivery countries retain a public Library link and a manual observation path; the app must not imply that an automated API search succeeded there. Ads Library access also requires Meta authorization beyond ordinary Ads reporting access.

## Data and authorization boundaries

| Step | Endpoint / store | Evidence and guard |
| --- | --- | --- |
| Connection | `/api/meta/oauth`, `api_credentials`, `meta_page_connections` | OAuth authorization and saved account/Page binding; access tokens stay server-side. |
| Inventory | `/api/campaigns/accounts`, `paid_ad_accounts` | User-scoped account IDs, names and readiness. Discovery pages through Meta's account API and updates this inventory. Disconnect deactivates Meta inventory rows. |
| Candidate profiles | `/api/campaigns/creative-intelligence/competitor-profiles` | User-scoped selected account; approved default business profile; supported country; bounded Ads Library sample. |
| Public Page ads | `/api/campaigns/creative-intelligence/competitor-profiles/:pageId/ads` | Numeric Page ID; user-scoped account; Page ID checked against each returned ad; own Page rejected. |
| Saved research | `/api/campaigns/creative-intelligence/research`, `ad_creative_research_runs` | Page ID or search terms, account ID, status, references, timestamps and an idempotent request ID. |
| Draft concepts | `/api/campaigns/creative-intelligence/briefs`, saved brief | Verified user facts plus saved evidence; concept selection and campaign handoff remain explicit. |

Meta discovery and archive reads use fixed Graph hosts and bounded pagination. API responses never include access tokens. Provider errors are surfaced as connection, permission, coverage, partial-sample or retry messages rather than fabricated results.

## Logs and troubleshooting

Structured application logs record Meta account discovery (`userId`, source type, failure count), advertiser discovery (`userId`, local account ID, country, status, profile count, duration), and Page-ad retrieval (Page ID, status, ad count, duration). The application's logger writes the combined log and, when enabled, the system log stream. These event records do not include token values, ad copy or full provider URLs. Saved research runs provide a persistent status and evidence record; live profile browsing is not a persisted research run until the user saves it.

For an empty account dropdown, check the OAuth link in Integrations, then **Find Meta accounts again**. Inspect the account-discovery event and `/api/campaigns/accounts` for the same user. If discovery returns no accounts, confirm the token's Ads permissions and access to `/me/adaccounts`; reconnect if expired. For a populated dropdown with no profiles, check country coverage, approved default business details, Ads Library authorization, and the profile-discovery status. A `partial` status means the bounded or provider sample is incomplete. Do not infer that no competitor ads exist.

## Verification and remaining external dependency

Focused client tests cover empty-inventory recovery, Page-scoped research handoff, unsupported-country fallback and saved suggestion flow. Focused server tests cover Meta account pagination, research input validation, ad normalization and public-evidence semantics. Live verification still requires a real user connection with Ads Library access and an approved business profile. The implementation has not measured or ranked private competitor campaign outcomes, because Meta does not expose those outcomes for ordinary commercial competitor ads.
