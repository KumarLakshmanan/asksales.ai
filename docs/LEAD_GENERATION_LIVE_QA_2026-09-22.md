# Six-platform live lead-generation QA — 22 September 2026

Target used: software/IT businesses in Bengaluru (Bangalore), India. Maximum three saved leads per platform. The user authorized live generation. No outreach was sent.

These tests execute the production `WorkflowExecutorService` with the configured Apify credential, durable provider receipts, actual datasets, relevance filtering, deduplication and database persistence. They do **not** constitute a fresh end-to-end chat/approval/browser test. The local frontend and API were stopped; Chrome returned `ERR_CONNECTION_REFUSED` for localhost:3000. Existing unrelated workspace edits were preserved.

## Results

| Platform | Unique saved | Quality assessment | QA conversation |
| --- | ---: | --- | ---: |
| Facebook | 2 | Both match; keyword searches also returned unrelated pages, which were rejected | 229 |
| Twitter/X | 2 usable, plus 2 rejected audit records | Two matching business profiles; unsafe expansion and keyword-only acceptance fixed | 231 |
| Instagram | 3 | Two match; third needs location verification | 232 |
| Google Maps | 3 | All three have Bengaluru locations and software-company categories | 227 |
| JustDial | 3 | Verified category URL works; city-plus-keyword lookup failed | 230 |
| LinkedIn | 3 | Two match; third is primarily a training company | 228 |

Saved business records are prospects, not verified buyers or consent to contact. Public email/phone fields were not deliverability-tested. No missing contact details were fabricated. Review notes were added to the two uncertain records.

Final quality count: **14 matching platform-specific lead records**, **2 additional records needing review**, and **2 rejected Twitter records retained for audit**. The same business may appear on more than one platform (Zinavo appears on Facebook and Twitter); 14 is not a claim of 14 distinct companies.

## Saved leads and evidence

| Platform | Lead ID | Business / source profile | Assessment |
| --- | ---: | --- | --- |
| Facebook | 1239 | [Zinavo](https://www.facebook.com/zinavopvtltd) | Bangalore address; web development; website, business email and phone returned |
| Facebook | 1248 | [Ai Media Wave](https://www.facebook.com/aimediawave) | Whitefield, Bangalore; web/app development; website, email and phone returned |
| Twitter/X | 1249 | [Cool Software Solution](https://twitter.com/coolsoftjalgaon) | Bengaluru location; software/computer business; website returned |
| Twitter/X | 1252 | [Zinavo Technologies account](https://twitter.com/Zinavowebdesign) | Display name is `dhaya`; bio identifies Zinavo Technologies in Bangalore; zinavo.com returned |
| Instagram | 1238 | [Brightcode Software Services](https://instagram.com/brightcodebangalore) | Software services and Bangalore in profile bio; no structured contact returned |
| Instagram | 1243 | [Vistas AD Media Communications](https://instagram.com/vistasadmedia) | Bangalore web development in profile bio; website returned |
| Instagram | 1244 | [Charm digital](https://instagram.com/charm_digital_) | Web/app development is relevant, but Bangalore appears only in post hashtags; **location unconfirmed** |
| Google Maps | 1240 | [TechCiti Software Consulting](http://www.techcitisoftware.in/) | Bengaluru address, software-company category, website and phone |
| Google Maps | 1241 | [Lore Software Solutions](https://www.loresoftwaresolutions.com/) | Bengaluru address, software-company category, website and phone |
| Google Maps | 1242 | [Amiti Software Technologies](http://www.amiti.in/) | Bengaluru address, software-company category and website; no phone returned |
| JustDial | 1245 | [Uperweb Marketing Agency](https://www.justdial.com/Bangalore/Uperweb-Marketing-Agency-Near-Bda-Complex-Kothanur/080PXX80-XX80-250331100049-H6V8_BZDET) | Bangalore software-development listing; website, email and phone returned |
| JustDial | 1246 | [Laabam One Business Solutions](https://www.justdial.com/Bangalore/Laabam-One-Business-Solutions-Private-Limited-Andapura/080PXX80-XX80-240626191606-A3F4_BZDET) | Bangalore software-development listing; email and phone returned |
| JustDial | 1247 | [A3 Fusiontech](https://www.justdial.com/Bangalore/A3-Fusiontech-Private-Limited-Near-Hal-Airport-Road-Marathahalli/080PXX80-XX80-260425004152-Z7Y7_BZDET) | Bangalore software-development listing; phone returned |
| LinkedIn | 1235 | [Indizeal Software Solutions](https://www.linkedin.com/company/indizeal-software-solutions-pvt-ltd/) | Bengaluru IT services; [official website](https://indizeal.in/) also corroborates software services and location |
| LinkedIn | 1236 | [Yugasys Software](https://www.linkedin.com/company/yugasyssoftware/) | Bengaluru IT services; public LinkedIn company page corroborates targeting |
| LinkedIn | 1237 | [Colossal Software Technologies](https://www.linkedin.com/company/colossal-software-technologies/) | Bengaluru, but industry is Professional Training and Coaching; **target-fit review needed** |

## Twitter defect and remediation

The `twitter_post_authors` downstream `apidojo/twitter-user-scraper` input supplied a handle but omitted both `maxItems` and extraction-mode flags. The provider [documents follower/following extraction as enabled by default](https://apify.com/apidojo/twitter-user-scraper/input-schema). Consequently run `luH1iCOkbyPXLShIU` began expanding BloombergTV's followers instead of fetching only the author.

The run was stopped and confirmed **ABORTED**. Its final provider-reported usage was **$3.3852**, and its dataset contained **8,514 items**. **Zero of those follower records were persisted as leads.** This charge occurred during this QA, before the fix; it is not a cost estimate for normal bounded runs.

Changes:

- Explicit `maxItems: 1` and `getFollowers/getFollowing/getAbout/getRetweeters/includeUnavailableUsers: false` on author-profile enrichment.
- The same fix on handle-based follower/replier/retweeter profile-enrichment nodes. Those other strategies received contract tests, not live end-to-end tests.
- A runtime guard rejects Twitter user-scraper calls without a positive fetch limit and explicit follower/following/retweeter settings before provider access. Legacy/custom unsafe definitions now fail closed rather than silently using expansive defaults.
- Corrected live run `8MCQcY2llHinCidqH` was independently checked: exact one-handle input, all expansion flags false, `maxItems: 1`, **SUCCEEDED**, provider usage **$0.004**.

The subsequent post search was low quality for this target (mostly recruitment posts). Eleven bounded profile results were rejected by relevance filtering, and the remaining iterations were deliberately stopped to switch to business-profile search. This is not evidence that post search reliably produces business leads.

The business-profile search returned Cool Software Solution plus two false matches: `sriyananda_kuch` (an individual with an entertainment bio) and `BandaloreGames` (a German/Japanese game studio). The latter two were initially saved because this workflow explicitly bypassed post-provider relevance checks. Both were marked `lead_status=rejected` with explanatory notes (IDs 1250 and 1251), not deleted or counted as matching leads. The bypass was removed; geographically constrained Twitter profile searches now require profile location evidence. Regression tests cover both real false-match patterns.

A narrow replacement search for Zinavo returned a Bangalore business profile but exposed a false negative: `technology` did not match `Technologies`. Added that plural alias and replayed the **same** dataset from run `pnE05SAgf0AvykpoG`; it saved lead 1252 without another provider scrape. The corrected Twitter test therefore has two usable business profiles.

## JustDial limitation and recovery

The city/category run `jiC6SbsbLvmFh9ZZc` returned no readable listing data. The executor correctly reported failure rather than claiming an empty successful search.

A second run used the [verified Bangalore software-development category page](https://www.justdial.com/Bangalore/Computer-Software-Development-Companies/nct-10801033), without adding a separate keyword search. Run `ACvRVuWg2KzkD7pP9` returned and saved three leads. This proves the URL-based workflow works, **not** that the failing city/category mode has been repaired.

## Persistence and test-runner notes

- Initial Facebook/Instagram attempts saved leads but failed to save their posts because the QA runner omitted the required campaign/ICP foreign key. This was a **runner setup issue**, not an application regression. QA campaign records were created without fabricating approval; replaying the existing provider datasets then saved posts successfully without starting replacement provider runs.
- Initial Google Maps preparation exposed two runner mistakes: missing schema initialization and replaying redacted log inputs. The runner now initializes schemas and reloads the exact saved lead-input snapshot. Google Maps then returned and saved three matching businesses.
- Facebook's second search encountered Zinavo again. Count unique lead IDs across executions: **two**, not the sum of per-run receipt counts.
- Runner: `server/scripts/qa-lead-platform-live.ts`. It requires explicit `--execute`, is scoped to this QA/user 1, and uses stable execution IDs. `--replay` reconciles a completed QA run from its provider datasets. It does not route through the LLM approval UI.
- Targeted Jest verification: **6 suites, 93 tests passed** (Twitter contracts, reviewed actor-input binding, relevance quality, workflow contracts, lead-input persistence, exact save receipts).
- Scoped ESLint passed with zero errors (existing/explicit-any warnings), using parsing without the full TypeScript project. The initial type-aware lint exhausted its 2 GB heap. A full server TypeScript check was stopped after over six minutes under local resource contention; no full-project typecheck pass is claimed.
- `git diff --check` passed.

Full application readiness is not signed off: UI flow was unavailable, two lead-quality exceptions remain, JustDial keyword mode still fails, and alternate workflow variants were not all live-tested.
