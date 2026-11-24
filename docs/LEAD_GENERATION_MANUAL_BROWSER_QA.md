# Lead Generation Manual Browser QA

**Run date:** 2026-09-22\
**Environment:** local AskSales.AI frontend at `http://localhost:3000` in Chrome\
**Scope:** Coordinator/Marcus lead-generation routing and review-only workflows for Instagram, Facebook, Twitter/X, and Yelp. JustDial, Google Maps, and LinkedIn were intentionally excluded.\
**Safety boundary:** No search was approved or executed. No leads were scraped, contacted, or messaged as part of the lead-generation tests, and no content was published. Separate browser incident: an unrelated WhatsApp message and a follow-up `No` were confirmed delivered during navigation. I stopped all WhatsApp interaction and made no deletion, recall, or reply attempt.

## Executive result

The post-fix Chrome retest confirms the Facebook competitor workflow now maps to the selected schema, one Twitter Post Author Profiles selection creates one review input by default, and the Retry button stays in Marcus while preserving the selected strategy and original request. The 5-lead save cap is now explicit in the review UI alongside the provider's 15-result minimum. No search was approved or executed.

The L3 retry path now passes a review-only Chrome test. A clearly labeled synthetic failure card in approved-ICP conversation `223` was clicked; Marcus preserved `twitter_post_authors` and the exact targeting request and prepared one input. The temporary synthetic card was soft-deleted afterward; the actual retry exchange remains as QA evidence. Search execution was not tested.

The screenshot symptoms were also retested in Chrome. Conversation `222` rendered with an enabled composer and no stale `Thinking` indicator; after retrying its failed workflow selection, the action card displayed the exact ICP-approval gate message and kept Retry available. A fresh Coordinator-to-ICP handoff in QA conversation `226` rendered one Coordinator handoff (one durable row with a shared response ID), then completed an internal ICP draft and restored the composer. The ICP remains unapproved; no search settings or external actions were created in that thread.

## Retest after fixes

| Issue | Latest result | Evidence and boundary |
|---|---|---|
| L1 — Facebook workflow mapping | Pass in Chrome | Selecting `Facebook Competitor Page Followers` prepared one input with that exact workflow/category, the supplied HubSpot/Salesforce page URLs, and follower mode. No search was executed. |
| L2 — duplicate Twitter inputs | Pass in Chrome | `Twitter Post Author Profiles` prepared one input for one selected workflow. Unit tests also verify explicit multi-search requests remain supported and unsolicited variants are retried once, then rejected without persistence if still duplicated. |
| L3 — retry misroutes to Outreach | Pass in Chrome | In conversation `223`, a labeled synthetic failed-Retry control was clicked on an approved-ICP QA thread. The browser showed the retry request directed to Marcus, retaining `twitter_post_authors` and the exact original targeting text. Marcus prepared one Twitter Post Author Profiles input; the review card showed a 5-lead save cap and provider request minimum of 15. The temporary control was soft-deleted; the retry exchange remains. No search was approved or executed. |
| L4 — provider-backed generation failure | Recovery tested; outage not forced in Chrome | The Facebook competitor workflow later prepared successfully in Chrome. Focused tests verify provider fallback and a structured retryable error with no saved review inputs after exhaustion. A controlled provider outage was not induced in the browser. |

Focused verification: 7 Jest suites passed, 138 tests passed (`chatActionResolutionContracts`, `orchestratorRouter`, `leadInputGenerationPersistence`, `leadStrategyPresentation`, `leadRetryAction`, `leadRequestConstraints`, and `leadInputReviewedTotals`). Lead-parameter UI tests: 2 suites, 12 tests passed. Client TypeScript check passed. The server-wide typecheck still reports existing errors outside the files changed for these fixes.

Latest verification after screenshot follow-up: 9 server Jest suites passed (150 tests), including provider timeout fallback, retry routing, action-resolution contracts, and response recovery. Client Vitest: 3 files passed (49 tests), including stale-metadata retry-error rendering; client TypeScript check passed. A subsequent second pass corrected the remaining server TypeScript diagnostics; server and client typechecks now pass. The second pass also fixed rejection of a present-but-empty LinkedIn `locations` array. Chrome additionally verified the lead Retry path, saved-cap disclosure, the specific approval-gate error on the retry card, and a single visible Coordinator-to-ICP handoff. No lead search or scraping-provider execution occurred.

### Screenshot follow-up — duplicate handoff and stuck processing

The supplied screenshots showed a duplicated Coordinator handoff after a lead action failed and the composer stuck disabled with `Thinking` still visible. Read-only inspection of conversation `222` found one durable handoff row but the workflow metadata still marked its run `running` with an old `updatedAt`; the backend had since restarted. The Retry card also displayed only a generic failure even though the API had returned a specific ICP-approval gate. Thread `223` initially displayed one saved Twitter review input with a 5-lead cap and inactive approval; the later Retry QA prepared one fresh input. Neither search was approved or executed.

**Fixes:** handoff/transition stream and stored copies now share a response ID; durable recovery copies preserve stored response metadata; legacy ephemeral response IDs can reconcile by exact matching content; stale `running` records older than 150 seconds no longer rehydrate the spinner/composer lock; the send timeout clears both React and ref processing state; and failed action cards persist the sanitized API error instead of always replacing it with generic text. Provider fallback now stops after a timeout rather than serially waiting on more credentials.

**Status:** at the first post-restart observation, stale-run recovery was visually verified in Chrome: thread `222` showed the composer enabled and no `Thinking` indicator despite its old durable `running` status. A later catalog-only QA request completed, and the run metadata now reports `succeeded`. A fresh review-only ICP-draft request in conversation `226` exercised the Coordinator-to-ICP handoff; Chrome rendered the Coordinator handoff once, the database contained exactly one durable handoff row with a response ID, the ICP draft completed, and the composer became available again. The draft was not approved. The specific retry-error display is now verified in Chrome: after retrying the failed workflow selection in thread `222`, the card showed `Approve the current ICP revision before selecting lead platforms` and kept Retry available. The L3 Marcus Retry route itself was separately verified in Chrome in thread `223`.

### Result-cap detail

The Twitter actor schema declares `maxResults.minimum = 15`, so the review JSON contains `maxResults: 15` even though the request asked for a cap of 5. The reviewed input separately stores `requestedLeadTotal: 5`; execution passes that as the global save cap. The Search Parameters card now labels this `Saved lead cap: 5 leads` and states that the provider may use more results than the global cap allows it to save. Component tests cover this exact 15-versus-5 case. Because `Approve & Run Search` was not clicked, provider fetch volume and credit impact remain unverified.

## Flow verified

```mermaid
flowchart LR
  U[User QA message] --> C[Coordinator]
  C --> I[Generate ICP draft]
  I --> A[Internal ICP approval]
  A --> M[Marcus / Lead Generation]
  M --> W[Workflow catalog]
  W --> P[Prepare search settings]
  P --> R[Lead Inputs review card]
  R --> X[Approve & Run Search]
  X -. not clicked in QA .-> S[Provider search]
```

The final node was deliberately not reached.

## Platform and workflow coverage

| Platform | Catalog observed | Review-settings test | Result |
|---|---:|---|---|
| Instagram | 5 strategies | `Instagram Competitor Profiles` | Initial review card passed; not retested after these patches; no search executed |
| Facebook | 5 strategies | `Facebook Post Author Profiles`; `Facebook Competitor Page Followers` | Initial competitor mapping failed; post-fix Chrome retest prepared one correctly mapped input; no search executed |
| Twitter/X | 7 strategies | `Twitter Post Author Profiles` | Initial duplicate fixed; post-fix Chrome retest prepared one input. Provider JSON uses `maxResults: 15` (actor minimum); separate saved-lead cap is 5. No search executed |
| Yelp | 1 strategy | `Yelp Business Search` | Initial review card passed; not retested after these patches; no search executed |

### Catalogs observed

Instagram:

- Instagram Competitor Profiles
- Instagram Post Author Profiles
- Instagram Post Authors & Commenters
- Instagram Post Author Followers
- Instagram Post Author Likers

Facebook:

- Facebook Competitor Page Followers
- Facebook Post Author Profiles
- Facebook Post Author Followers
- Facebook Post Commenters
- Facebook Post Likers

Twitter/X:

- Twitter Competitor Followers
- Twitter Competitor Users
- Twitter Post Author Profiles
- Twitter Post Author Followers
- Twitter Post Likers
- Twitter Post Repliers
- Twitter Post Retweeters

Yelp:

- Yelp Business Search

The catalog buttons were rendered by Marcus and were actionable in the local chat. The remaining individual catalog buttons were not executed because the test was constrained to review-only preparation and switching strategies retires the current approval state; they are covered at catalog/routing level, not falsely marked as provider-execution tests.

## Detailed evidence

### 1. Coordinator → Marcus and ICP gate

Conversation `224`:

1. A Twitter/X catalog request caused the conversation to switch from Coordinator to Marcus.
2. Clicking `Twitter Post Author Profiles` before approval returned `Approve the current ICP revision before selecting lead platforms`.
3. A synthetic internal ICP was generated with a 75% completeness score and approved. The UI showed `ICP approved SELECTED`.
4. `Choose Marcus` returned the recommended strategy and `Prepare Search Settings` action.

Conversation `225` repeated the same pattern for Yelp. The generated ICP correctly identified Yelp as the lead-generation channel, with a 69% completeness score, and approval enabled Marcus.

**Assessment:** Pass. The approval gate is explicit and prevents search preparation before internal ICP approval.

### 2. Instagram review-settings preparation

Conversation `223` generated:

- Workflow: `Instagram Competitor Profiles`
- Review state: one search configured and ready for review
- UI: `Approve & Run Search` and `Edit Parameters`
- UI message: `No search has been executed.`

The workflow was not approved or run.

**Assessment:** Pass at the review boundary.

### 3. Facebook review-settings preparation and mapping defect

`Facebook Post Author Profiles` generated a reviewable settings card with a five-lead cap and no execution.

The targeted `Facebook Competitor Page Followers` test did not preserve the requested workflow. The expanded tool receipt showed:

- Input `selected_workflows`: `facebook_competitor_page_followers`
- Result `workflowIds`: `facebook_post_authors`, `facebook_post_authors`
- Result categories: `Facebook Post Author Profiles`, twice
- Result count: `2`
- Queries were author-profile searches for HubSpot and Salesforce rather than competitor-page follower settings

The follow-up attempt to select the competitor-page strategy later returned:

> I couldn't complete that request because the AI service could not process it.

**Assessment:** Fail. The selected workflow and generated provider schema do not match. The failure is more than a display problem because the wrong provider inputs were persisted in the review state.

### 4. Twitter/X duplicate input defect

Conversation `224` generated settings for `Twitter Post Author Profiles`. The expanded receipt showed:

- Input `selected_workflows`: `["twitter_post_authors"]`
- Result status: `succeeded`
- Result count: `2`
- Result `workflowIds`: `["twitter_post_authors", "twitter_post_authors"]`
- Input IDs: `203`, `204`
- Both Lead Inputs cards were labeled `Twitter Post Author Profiles`
- Both cards had a global cap of 500 leads and 3 parameters

The generated queries differed, but the workflow itself was duplicated. The UI correctly stopped at review and did not execute a search.

**Assessment:** Fail. One selected strategy should not silently create two identical workflow runs unless the user explicitly requested multiple search variants.

### 5. Yelp review-settings preparation

Conversation `225` generated exactly one reviewable Yelp input set:

- Workflow category: `Yelp Business Search`
- Provider workflow ID: `yelp_b2b`
- Actor: `datascrapers/yelp-scraper`
- Search term: `revenue operations software`
- Location: `United States`
- Country code: `US`
- Maximum items: `5`
- Result count: `1`
- UI: `1 search ready for review`, `Approve & Run Search`
- UI message: `No search has been executed.`

The agent description correctly warned that the actor had not been live-verified with this account and that execution requires separate approval. The approval button was not clicked.

**Assessment:** Pass for settings generation and safety gating; Yelp scraping-actor execution remains intentionally untested.

## Initial failures and reasoning

### L1 — wrong workflow mapping on Facebook

**Severity:** High.\
**Expected:** `Facebook Competitor Page Followers` should create a competitor-page-follower schema.\
**Actual:** The result persisted two `facebook_post_authors` workflows.\
**Reasoning:** The request selection was preserved in the input receipt but lost or overwritten while translating the selection into provider schemas. This can cause a user to approve a materially different search from the one they requested.\
**Fix direction:** Add a server-side invariant that every generated schema's `workflowId` and category must match the selected workflow. Reject the result and show a retryable error when they differ.

**Post-fix status:** Pass in the Chrome retest. The selected `Facebook Competitor Page Followers` strategy produced exactly one matching follower schema and preserved the requested page URLs. The executor now rejects a generated schema that does not match the explicit workflow selection before saving it.

### L2 — duplicate workflow generation on Twitter/X

**Severity:** High.\
**Expected:** One selected workflow produces one input set unless the user asks for multiple variants.\
**Actual:** One selection produced two identical workflow IDs and two review cards.\
**Reasoning:** The planner appears to expand one workflow into multiple recommended sub-workflows without deduplicating the selected primary workflow. The UI presents this as `2 searches configured`, which is misleading and could double provider credits if approved.\
**Fix direction:** Deduplicate by workflow ID before persistence, distinguish explicit variants from automatic recommendations, and add a count assertion to the review card.

**Post-fix status:** Pass for the default case in Chrome: one selected Twitter workflow produced one input card. The executor now retries an unsolicited multi-input response once and fails closed without persistence if the model still returns variants; explicit separate-search requests are allowed.

### L3 — retry path misroutes to Outreach

**Severity:** Medium.\
**Observed:** When the first Instagram settings attempt reported that `generate_lead_inputs` was unavailable, the retry action sent the conversation to Outreach and returned `No persisted lead IDs are available for outreach`.\
**Reasoning:** The retry action is not retaining the originating agent/tool context. A lead-generation retry must stay in Marcus and retry parameter generation, not enter a downstream outreach prerequisite check.\
**Fix direction:** Persist the failed tool name and originating agent on the retry action and route the retry through that exact handler.

**Post-fix status:** The retry instruction and forced Marcus route are implemented and unit-tested, including preserving the selected workflow/request and refusing to jump across another pending approval. In Chrome, clicking a temporary, clearly labeled failure card in approved-ICP conversation `223` posted the Marcus-only retry instruction, preserved the exact Twitter strategy and user request, and prepared one review input. The UI showed the 5-lead save cap and 15-result provider minimum. No search was approved or executed. The synthetic card was soft-deleted after the test; the actual retry exchange remains in the QA thread.

### L4 — provider-backed settings request can fail after catalog success

**Severity:** Medium.\
**Observed:** The Facebook competitor-page path reached catalog rendering, but the later selection ended with an AI-service processing error.\
**Reasoning:** Catalog discovery and selection are healthy enough to render the strategy, but the settings-generation path lacks a stable fallback/error contract.\
**Fix direction:** Return structured tool failure metadata, preserve the selected workflow, and offer a same-agent retry without retiring the ICP approval unnecessarily.

**Post-fix status:** The Facebook competitor path subsequently prepared successfully in Chrome. Provider fallback is covered by tests; exhausted provider failures now return a structured retryable error and do not persist a review input. A forced provider outage was not reproduced in Chrome.

## Not executed by design

- `Approve & Run Search`
- Any lead provider scrape or extraction
- Lead-generation email, WhatsApp, SMS, DM, or other outreach
- Social post or ad publishing
- Ad scheduling, budget changes, or campaign activation
- JustDial, Google Maps, and LinkedIn workflows

## Recommended acceptance gates before calling lead generation green

1. Keep the verified workflow-ID/schema invariant, one-input-by-default behavior, retry routing, and handoff reconciliation covered by automated tests.
2. Maintain a controlled provider-outage test for the retryable error path; the browser outage was not forced because provider fallback is covered in unit tests.
3. Add browser acceptance tests for one representative workflow per platform plus a negative mapping test for cross-workflow contamination.
4. Keep provider execution behind the existing `Approve & Run Search` gate. Actor fetch volume and credit impact remain unverified because no search was approved or run.
