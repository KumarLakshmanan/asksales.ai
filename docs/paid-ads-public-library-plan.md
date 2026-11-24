# Paid Ads public Ad Library research plan

## Scope

Replace the **Competitor creative research → Matching advertiser profiles** live discovery with a read-only Playwright visit to Meta's public **Search ads** page. Search India (`country=IN`), **All ads** (`ad_type=all`), active ads, and a keyword derived from the approved default business profile. Group observed advertiser names as candidate profiles. Opening a candidate searches the same public page for its name and shows only cards with an exact advertiser-name match. Keep the saved creative-brief workflow separate.

## Steps and bounds

1. Read the approved default business category, sub-industry, industry, or target market. Use at most three distinct phrases of at most 100 characters. Do not request Meta credentials.
2. Build only fixed `https://business.facebook.com/ads/library/` Search ads URLs with `country=IN`, `ad_type=all`, `active_status=active`, `media_type=all`, and an encoded `q` value. Playwright loads the rendered page and extracts a bounded visible sample of Library IDs, advertiser names and ad copy. Do not call Graph `ads_archive` or private page endpoints.
3. If navigation, layout detection or extraction fails, capture a screenshot and classify the failure. Report blocked or changed pages as unavailable, never as no competitors. Do not work around sign-in, CAPTCHA or access denial.
4. Show advertiser candidates with their matched business phrases, sample counts and public search links. Label these as candidates because keyword matching does not establish direct competition or ad performance.

## Live inspection and limitation

On 27 October 2026, Playwright opened the supplied `www.facebook.com` India/All ads URL with Chrome, but Meta returned HTTP 403. The captured screenshot was entirely blank. AI visual inspection found no controls or results to analyze. The equivalent public `business.facebook.com/ads/library/` Search ads page returned HTTP 200 and visibly showed **India**, **All ads**, active keyword results, Library IDs, advertiser names and ad copy. The implementation uses this working public host. A live service search for `software` extracted 30 ad cards, including Adobe Lightroom and StreamAgain. A follow-up `Adobe Lightroom` search extracted 27 cards, all with that exact displayed advertiser name. The app must still fail closed if that host later denies access or changes its layout.
