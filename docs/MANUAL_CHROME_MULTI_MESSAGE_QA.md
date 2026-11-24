# Manual Chrome Multi-Message QA

Date: 2026-09-22\
Environment: local AskSales.AI (`localhost:3000` client, `localhost:8080` server)\
Browser: Google Chrome, Personal profile, session `🧪 Workflow QA`\
Safety scope: synthetic QA prompts only; no external send, publish, schedule, activation, pause, deletion, or ad spend was performed.

## Executive result

The public specialist pages, authenticated workspace shell, conversation composer, approval gates, lead list, email surface, calendar, paid-ads surface, and specialist navigation rendered in Chrome. A real two-follow-up conversation preserved context and enforced the ICP approval gate.

The manual run did not establish end-to-end provider delivery. Follow-up conversation checks also found incorrect lead-workflow routing and duplicate saved search cards. Those lead-generation defects and the AI Visibility load failure have since been remediated and regression-tested; external provider delivery remains unverified. Other remaining constraints are missing provider permissions/integrations, a retry path still gated by ICP approval, and unresolved agent-switching semantics. A fresh ad-creation navigation rendered successfully.

## Multi-message conversation test

Conversation: local conversation `221`.

### Message 1 — lead/ICP preparation

```text
QA TEST ONLY. Draft a read-only plan for exactly 3 synthetic technology leads in Bengaluru using LinkedIn and Google Maps. Do not send messages, publish content, spend budget, or call external providers.
```

Observed:

- The composer accepted the message and created a conversation.
- The coordinator crawled the product website and generated an ICP draft.
- The ICP Profile result view opened with an 81% completeness score.
- The saved profile showed LinkedIn and Google Maps as channels.
- The UI exposed an explicit `Approve ICP` control.
- The assistant stated that saving the draft had not started lead search or outreach.

Result: **Pass with a recoverable transport warning.** The browser logged several WebSocket reconnection warnings while the run was starting, but the server later registered the socket and the UI received the completed crawl/ICP events.

### Follow-up 1 — context continuity

```text
QA follow-up 1/2: Keep this review-only. Confirm which specialist prepared the ICP, which channels are selected, and whether any provider send, publish, or spend has occurred. Do not approve or execute anything.
```

Observed:

- The message stayed in the same conversation.
- The coordinator answered that the ICP Specialist prepared the profile.
- It preserved the LinkedIn and Google Maps channel selection.
- It explicitly reported no messages sent, no content published, and no budget spent.

Result: **Pass.**

### Follow-up 2 — requested cross-specialist handoff

```text
QA follow-up 2/2: Without approving the ICP or executing any provider action, prepare a review-only matrix for the same campaign: ask Content Studio for 2 synthetic Instagram post drafts, ask Outreach for one draft email and one draft WhatsApp message for synthetic leads, and ask Performance Marketing for an ad-campaign outline plus the analytics fields it would track. Do not send, publish, schedule, or spend.
```

Observed:

- The coordinator first required the current saved ICP to be reviewed and approved.
- It then stated that the ICP Specialist is not authorized to prepare content, communication drafts, or marketing plans, and cannot engage the other specialists until approval.
- No content, outreach, ad, schedule, or provider action was created.

Result: **Expected prerequisite gate, but cross-agent execution was not reached.** This is correct if ICP approval is a hard prerequisite. If the product requirement is to let the orchestrator prepare independent read-only drafts before ICP approval, this is a product-flow gap.

## Additional multi-message workflow probes in Chrome

These checks read existing QA campaign histories and saved result cards. No new provider action was run.

| Conversation / test | Expected | Observed | Result and reasoning |
|---|---|---|---|
| `222` — request complete Instagram, Facebook, Twitter/X, and Yelp lead-workflow catalogs | Catalog for each requested channel, with no search or scrape | Marcus returned all four channel sections: 5 Instagram strategies, 5 Facebook, 7 Twitter/X, and 1 Yelp. The history also contains an `Instagram Competitor Profiles failed` event: “The action failed before it was accepted,” with a Retry control. | **Partial.** Catalog coverage works; a workflow action failed before acceptance. Retry was not clicked. Yelp's catalog entry itself says the actor has not been live-verified with this account. |
| `223` — Instagram competitor profile settings (`@hubspot`, `@salesforce`, cap 5) | One review card for the selected workflow and exact usernames/cap | An initial turn said `generate_lead_inputs` was unavailable; a later explicit tool call reported one Instagram settings workflow generated. The exact persisted Instagram payload was not independently visible after later workflow cards replaced the result view. | **Partial / inconsistent.** The tool later reported success, but availability and persistence of the requested exact settings were not confirmed. |
| `223` — Facebook Competitor Page Followers for HubSpot and Salesforce URLs, cap 5 | One correctly typed follower search using the supplied URLs and cap | Original run returned two Post Author Profiles cards. Post-fix Chrome retest prepared one Facebook Competitor Page Followers input, preserving both supplied URLs and follower mode; regression tests also verify the cap. | **Fixed for review preparation.** Search execution was not approved. |
| `223` — subsequent Facebook settings request | Fresh selected-workflow settings | The original turn returned an AI-service processing error and kept the previous cards. A later post-fix Facebook competitor workflow prepared the correct settings in Chrome; focused tests also cover structured retryable failure without persisting invalid inputs. A forced outage was not reproduced. | **Recovered and guarded;** outage recovery was not end-to-end forced in Chrome. |
| `224` — latest user turn asks for the Yelp catalog only | Yelp catalog | Original result was the earlier Twitter/X catalog. A regression test now confirms an explicit latest-turn Yelp catalog request overrides prior Twitter context. | **Fixed in routing logic/tests.** No new credit-consuming chat prompt was sent for browser retest. |
| `224` — selected Twitter Post Author Profiles, prepare settings only | One review card for the selected strategy | Original run saved two cards. The executor now deduplicates selected workflow IDs; Chrome retest prepared one input. The review UI labels the global saved-lead cap and warns when `maxResults` is higher. | **Fixed for review preparation;** provider fetch volume and cost were not tested because search was not approved. |
| `225` — Yelp Business Search for “revenue operations software,” review only | One saved Yelp search card with a small cap | The tool reported one Yelp workflow. The JSON result showed `searchTerm: revenue operations software`, `location: United States`, `countryCode: US`, `maxItems: 5`, `scrapeDetails: true`, and empty `startUrls`/`searchQueries`; the Yelp proxy configuration was also present. The panel showed “1 search saved · no active approval.” | **Pass for review-only settings generation.** This does not verify the Yelp actor or actual search; the UI explicitly says the actor has not been live-verified, and execution was not approved. |

Across these history checks, the original saved cards showed the routing and duplicate defects described above. Those code paths now have focused regression coverage, and the Facebook/Twitter cases passed post-fix Chrome review-only retests recorded in [the lead-generation QA report](LEAD_GENERATION_MANUAL_BROWSER_QA.md). No provider search was executed.

## Agent and navigation checks

| Surface | Chrome observation | Result |
|---|---|---|
| Public agent directory | Listed Lead Generation, Content Studio, Outreach, and Performance Marketing | Pass |
| Lead Generation detail | Capabilities and execution contract rendered | Pass |
| Content Studio detail | Social, email/SMS, image/video, and ad-copy capabilities rendered | Pass |
| Outreach detail | Email, SMS, multi-channel, and compliance capabilities rendered | Pass |
| Performance Marketing detail | Meta/Google planning, optimization, testing, publishing, and reporting capabilities rendered | Pass |
| Lead Generation sidebar | Expanded to Leads and Enrichment | Pass |
| Content Creator sidebar | Expanded to Templates, Brand Toolkit, and Calendar | Pass |
| Performance Marketing sidebar | Expanded to Paid Ads and Social Insights | Pass |
| Outreach sidebar | Expanded to Email, Instagram, Facebook, SMS, and WhatsApp Outreach | Pass |
| `Open Coordinator` control | Clicking it selected the Coordinator's ICP Profile result context, but did not open an agent-picker | **Partial / needs clarification** |
| Composer `@` mention | Typing `@` and `@l` showed no agent-suggestion menu; the unsent draft was cleared | **Needs investigation** |
| Workspace result picker → Agent Choose | Opened `Explore Tabs` → `Agent Choose` and rendered Marcus, Alex, Emily, and Sarah with their specialties and non-executing start controls | Pass |
| Agent selection without execution | Selecting Marcus exposed `Book Marcus Johnson`; selecting Alex as a second choice exposed `Hire Team & Start Workflow`; neither action was clicked | Pass for selection; execution not tested |
| Content Studio workspace picker | The chat workspace exposes Image Gallery, Video Gallery, Email Templates, SMS Templates, Social Posts, Social Messages, Ad Copy, and Blog Posts | Pass for navigation inventory |
| Chat Social Posts view | Opened from the workspace picker and rendered Preview platform controls, view controls, `Generate`, and an empty-state `Create Your First Post`; no asset was generated | Pass for UI affordance; generation/publishing not tested |

### Agent-by-agent coverage

| Agent / role | Chrome evidence | Verdict |
|---|---|---|
| Coordinator / orchestrator | Accepted the initial multi-message request, ran website analysis and ICP drafting, retained channel context on follow-up, and enforced an approval gate before handing work to other specialists | **Partial pass.** Core conversation and gate work; cross-agent handoff was not reached |
| ICP Specialist | Draft profile result views and completeness scores (81% in conversation `221`, 69% in `223`) rendered with explicit approval controls | **Pass for draft/review; approval and downstream work not tested** |
| Marcus — Lead Generation | Returned the social/Yelp workflow catalog; Yelp review settings saved. Other cases exposed a pre-accept failure, stale/mismatched catalog response, duplicate cards, and strategy/input mismatch | **Fail / inconsistent; see case table above** |
| Alex — Content Studio | Agent chooser and content-toolkit result views rendered, including Social Posts and template libraries | **Surface only.** No chat-generated content was created because the ICP gate was still active and the live AI path consumes credits |
| Emily — Outreach | Email, WhatsApp, SMS, Instagram, and Facebook outreach pages rendered; email showed leads, WhatsApp/Facebook had no conversations, and SMS required integration | **Surface only / partially configured.** No message draft or provider delivery was executed |
| Sarah — Performance Marketing | Paid Ads overview and ad-creation form rendered; account discovery and reporting surfaces were present | **Surface only.** No ad plan/campaign was submitted, and publication/spend were not tested |
| Supervisor | Present in the server tool/agent registry and included in automated contract coverage; not offered as a selectable Chrome agent in the inspected Agent Choose panel | **Code/test coverage only; no direct browser invocation** |

This distinction matters: the picker/navigation confirms an agent is exposed, but does not prove its model/tool call succeeds. The chat-driven content, outreach, and performance agent paths remain unverified end-to-end under the safe review-only test boundary.

## Toolkit and use-case checks

| Use case / route | Observed state | Result |
|---|---|---|
| Leads | 541 stored leads; table includes email and phone columns; selecting a QA lead exposed `Start Outreach` and `Delete Selected`. The loaded rows showed LinkedIn-related data but no visible Google Maps or Yelp source label. | Pass for UI affordance; Google Maps/Yelp source coverage not evidenced; delivery not tested |
| Enrichment | Six enrichment runs listed, with running/completed filters and `New Enrichment` | Pass |
| Email Outreach | Lead inbox rendered with seven leads and `New Email Campaign` / `New Campaign` controls | Pass for UI affordance; no email was sent |
| WhatsApp Outreach | Page rendered with zero conversations plus `Sync conversations` and `New Campaign` | Partial: provider/conversation data not available |
| SMS Outreach | Page rendered a clear `Connect SMS` state with `Integrate Now` and `Manage Integrations` | Blocked until SMS provider integration |
| Instagram Outreach | Two conversations rendered with `Sync conversations` and `New Campaign` | Pass for UI surface; no DM was sent |
| Facebook Outreach | Page rendered with zero conversations plus sync/new-campaign controls | Partial: no conversation/provider data |
| Content Calendar | Monthly September 2026 calendar, platform/status filters, Weekly/Monthly views, and `Create Post` rendered | Pass for scheduling UI; no post was created/scheduled |
| Paid Ads overview | Create-campaign link, Meta/Google account discovery, provider sync, filters, metrics, currency selector, and recommendation links rendered | Pass for UI surface; no provider data, campaign, or spend |
| Social Insights | Facebook/Instagram accounts visible; selected Instagram account reported `Analytics permission required`; `Sync now` was disabled and `Reconnect` was shown | Partial/blocker: provider analytics permission required |
| Saved Templates | Image, video, email, SMS, social, DM, ad-creative, and blog libraries rendered; provider requirements were visible | Pass for library surface |
| Brand Toolkit | Existing brand cards, colors, default state, edit, and set-default controls rendered | Pass |
| AI Visibility | Original page showed a generic load failure. Chrome inspection found HTTP 500s on the portfolio endpoints; the development database lacked migration `249_ai_visibility_workbench.js`. After applying that migration, Retry loaded the website portfolio and removed the error banner. | **Fixed locally;** ensure the migration is applied in each target environment. |
| Ad creation route | A fresh Chrome navigation now renders the `Create a paid campaign` form with campaign name, Meta/Google platform, objective, budget guidance, audience/destination, and `Continue with Performance Marketing`; the earlier timeout was transient during dev compilation | **Pass for form/UI; provider creation and publishing not tested** |

## Side-effect audit

- No `Approve ICP`, `Start Outreach`, `New Email Campaign`, `New Campaign`, `Create Post`, `Create campaign`, `Sync provider data`, `Reconnect`, `Integrate Now`, publish, send, pause, activate, or spend action was executed.
- The local `Plan this work` action and two local chat messages were executed because they were the requested multi-message QA path. They created a local conversation and read-only ICP draft only.
- The AI Visibility Retry re-ran the portfolio requests, including its built-in `POST /api/ai-visibility/projects/resolve` profile resolver. That product route may create or refresh a profile-linked workspace project; the portfolio loaded one project after the schema fix. No audit/generation or external provider action was started.
- The workspace credit balance visibly decreased during the AI-backed test (from approximately 61,359 to approximately 60,999). Future manual runs should use a deterministic no-credit QA mode or an explicitly approved test budget.
- On a later read-only Chrome recheck of AI Visibility, the displayed balance moved from 60,925 to 60,556 while the page loaded its failed state. Treat this as evidence that some “read-only” AI-backed surfaces may still consume credits; do not use live credits for broad regression coverage.

## Supporting contract checks

- Client conversation/navigation tests: **4 suites passed, 29 tests passed**.
- Server orchestration, agent selection, workflow state, provider contracts, integration tools, and lead-source tests: **8 suites passed, 115 tests passed**.
- Both test commands emitted the repository's existing Node engine warning (`node v22.23.2`; package requests Node 24.18+), but the selected suites completed successfully.

## Orchestrator toolkit inventory

The server registry currently contains **53 tool metadata entries**, and the mapping check found no tool name that is missing from metadata or left unmapped. The agent mappings are: Coordinator 8, Supervisor 2, ICP Specialist 5, Marcus/Lead Generation 13, Alex/Content Studio 25, Emily/Outreach 19, and Sarah/Performance Marketing 14. The browser run exercised the read-only/result-panel affordances for these domains; approval-gated provider execution tools were intentionally not invoked.

## Conversation flow confirmed by code and Chrome

1. The latest user turn is classified by the unified router; routing is based on the latest turn and current database state.
2. If the exact current ICP revision is not approved, a requested specialist is held behind the ICP Specialist and the original destination is retained as a pipeline prerequisite.
3. A specialist may prepare a review card/result, but lead scraping, outreach delivery, social publication, paid-ad publication, and ad stopping remain approval-gated.
4. An approved widget resumes the durable pipeline step, records tool execution/result receipts, and can advance to the next specialist only after the preceding task is complete.
5. In Chrome, steps 1–3 were observed through the crawl/ICP result and approval gate. Steps 4–5 were not executed because doing so could contact providers, publish content, spend budget, or consume additional live credits.

## Findings and reasoning

1. **Conversation continuity works.** The second and third messages remained attached to the same campaign and the coordinator grounded its response in the saved ICP.
2. **Approval gating works.** The system prevented the requested cross-agent preparation from crossing the ICP boundary without approval. This protects provider actions, but it also means independent draft preparation cannot be verified until a user approves the ICP.
3. **The channel UI is broader than the configured providers.** Email and Instagram have visible data; WhatsApp/Facebook have empty conversation states; SMS explicitly requires integration; analytics lacks permission; paid ads has no fresh provider data. The ICP draft can select Google Maps, but the loaded Leads table did not show Google Maps or Yelp source rows during this run.
4. **The navigation exposes the requested workflow surfaces.** The user can reach lead resources, content scheduling, ads, analytics, email, WhatsApp, SMS, Instagram, and Facebook from the workspace.
5. **Agent switching is split across two behaviors.** Sidebar specialization works and exposes each toolkit, while the conversation-level Coordinator control only opens Coordinator context and the composer mention affordance does not show agent suggestions. The intended direct-switch interaction should be clarified or fixed.
   The supported non-destructive path is available through `Add result view` → `Agent Choose`; it renders all four specialists and supports single- and multi-agent selection before the separate start/hire action.
6. **Runtime follow-up.** The AI Visibility 500s were caused by unapplied local database migration `249_ai_visibility_workbench.js`; applying that single migration restored the portfolio in Chrome. The ad-create route recovered on a fresh navigation, though the earlier Turbopack compile/panic condition should still be investigated. WebSocket reconnect warnings remain a separate reliability concern.

## Recommended next checks

1. Ensure migration `249_ai_visibility_workbench.js` is applied in each deployed database, then smoke-test AI Visibility there.
2. Stabilize the Next.js/Turbopack dev server or use a production build, then rerun `/dashboard/ads/create` under load to confirm the recovered form is not a cold-compile flake.
3. Add a deterministic local-provider mode so lead/content/outreach/ads tests do not consume workspace credits.
4. Configure sandbox SMS, WhatsApp, Meta, Google Ads, and social-analytics providers, then verify each provider’s review-to-execute boundary separately.
5. Clarify the intended semantics of `Open Coordinator` and whether content/outreach/performance drafts should be allowed before ICP approval.

## Remediation update — 2026-09-22

| Finding | Remediation and verification | Status |
|---|---|---|
| Stale channel catalog response (Twitter returned for a latest Yelp request) | Explicitly named lead-catalog channels are now routed from the latest user turn. Server regression coverage verifies Yelp overrides prior Twitter context and excludes negated channels. | Fixed in code/tests |
| Facebook selection generated the wrong workflow and discarded competitor URLs | Selected workflow IDs remain authoritative, duplicate IDs are removed, and the Facebook competitor-pages workflow requires explicit Facebook page URLs and preserves follower mode. A requested lead cap is applied even if the actor schema omits an optional cap field. | Fixed in code/tests and post-fix Chrome review |
| Duplicate Twitter settings cards | Selected workflow IDs are deduplicated before input generation/persistence; unsolicited variants fail closed. One selected Twitter workflow produced one card in the post-fix browser run. | Fixed in code/tests and post-fix Chrome review |
| Provider minimum may exceed requested save cap | The Search Parameters card now says `Saved lead cap` and, when `maxResults` exceeds it, explains that provider usage may exceed the global saved-lead cap. Component tests cover a provider limit of 15 with a save cap of 5. No provider search or cost was tested. | Clarified in UI/tests; execution remains unverified |
| AI Visibility portfolio returned 500 for projects, website summaries, and profile resolution | Chrome Network showed 500s on the three routes. The local database was missing migration `249_ai_visibility_workbench.js`; exactly that migration was applied. Retry then loaded the `aimplify ai` website card in Chrome without an error banner. | Fixed locally; deploy environments must apply the migration |
| Instagram retry/action recovery | Retry routing, selected workflow preservation, and structured provider failure recovery have focused server coverage. The browser retry still encounters the existing unapproved-ICP prerequisite, so no search/retry was accepted in Chrome. | Code-tested; browser execution gated by approval |
| Chat agent switching (`Open Coordinator` and `@` mention) | The existing `Add result view` → `Agent Choose` path exposes the selectable specialists. `Open Coordinator` did not open a picker, and typing `@` showed no suggestions. The audit does not establish whether those controls should switch context, assign a specialist, or merely open the coordinator workspace. | Unresolved UX intent; no behavior change made without a defined interaction contract |
| Cross-agent drafts before ICP approval | The orchestrator holds specialist handoff behind the current ICP approval gate. That matches the observed safety boundary; no change was made to bypass approval for draft-only work. | Preserved intentionally; product policy decision if drafts should be allowed earlier |
| Missing SMS/WhatsApp/Meta/Google Ads/social-analytics permissions and live provider verification | These require sandbox account credentials/permissions. No messages, posts, ads, or provider searches were sent or executed. | External setup required; not a code-only fix |

Verification after remediation: latest-turn-routing/selected-workflow server suites 4 / 137 tests passed; lead/retry/orchestration suites 7 / 138 passed; AI Visibility server suites 3 / 104 passed; AI Visibility client suites 53 passed; lead-parameter UI suites 12 passed; client TypeScript check passed. No send, publish, schedule, provider search, or ad-spend action was performed.

## Second-pass verification — 2026-09-22

The server and client TypeScript checks now pass. The server's remaining compiler errors were corrected with narrow controller/test typing changes. A full client Vitest run initially completed with 179/180 files and 1,298/1,299 tests passing; its sole failure was a source-text assertion expecting a hard-coded product name after the UI had switched to the shared `BRAND_NAME` constant. That assertion was updated, and the affected test passed on rerun. A subsequent targeted client run passed 13 files / 139 tests.

The full server Jest run was interrupted after it stalled for several minutes, so **a clean repository-wide server suite is not established**. Before interruption it exposed one LinkedIn empty-`locations` validation defect and outdated Jest mocks for agent routing, WhatsApp credentials, outreach query helpers, and organic publishing. The validator and mocks were repaired. The relevant post-fix server run passed 22 suites / 326 tests, covering multi-message agent continuity, direct-switch request shape, campaign action status, lead routing/constraints/retries, outreach, WhatsApp, ads, analytics, publishing, and response recovery. A focused rerun also passed the affected agent-router and lifecycle tests. `git diff --check` passed.

At the end of that second pass, outreach counts were still recipient-scoped and `@` was unimplemented. Both implementation gaps are superseded by the follow-up below. Live email/WhatsApp sends, ad/social publication and scheduled dispatch, provider scraping, and analytics permissions were not verified. No live provider action was run in that second pass.

## Follow-up: specialist picker and exact delivery scope — 2026-09-22

- Added the `@` picker with shared server/client specialist handles. Actual Google Chrome on conversation `223` displayed all six choices; `@emi` + Enter inserted `@emily ` without sending. Clearing the draft disabled Send. `Open Coordinator` continues to open context, not impersonate a hire action.
- Direct agent switches now persist the resulting pipeline and report the actual agent or a clear conflict/failure; active draft cards are retained. Unresolved execution approvals are not bypassed.
- Outreach status now correlates owned conversation/review IDs to campaign/jobs/provider receipts. Messages from unrelated campaigns sharing a lead are not counted. Missing or ambiguous correlation is unavailable, not zero. Queued, sent and delivered have different evidence requirements.
- A read-only status prompt was attempted in Chrome, but local API/frontend processes terminated during verification before a completed response assertion. This attempt is not counted as a browser pass. Automated handler tests cover the real status shortcut and authenticated review-ID scope.

Current per-finding implementation and verification matrices are maintained in [ORCHESTRATOR_MULTI_MESSAGE_QA.md](ORCHESTRATOR_MULTI_MESSAGE_QA.md) and [CHAT_CAMPAIGN_USE_CASE_ACCEPTANCE_QA.md](CHAT_CAMPAIGN_USE_CASE_ACCEPTANCE_QA.md). External provider-success signoff remains outstanding.

## Chrome retry and multi-message acceptance — 2026-09-22, 12:23 IST onward

Actual Google Chrome extension control recovered. Local frontend uses Webpack at `localhost:3000`; the API uses the local QA entrypoint with cron startup disabled and embedded media workers disabled. No provider execution button is approved in this run. Existing unrelated development work is preserved.

### CHROME-RETRY-01: status reply after an earlier workflow

- Campaign: `223` (existing lead QA campaign).
- Prompt: `What review actions are currently pending in this conversation?`
- Expected: exact durable approval/review status, followed by an immediately usable composer.
- Actual before fix: response persisted and rendered, but the composer remained disabled and a thinking indicator remained. Reload recovered it.
- Cause: `workflowRunSeenRef` retained the preceding turn's workflow ownership. The deterministic status shortcut creates no new workflow events, so its assistant response could not clear processing.
- Fix: an accepted `useChat` send invokes `beginChatTurn` to clear prior-turn workflow ownership before sending. Empty/blocked/duplicate sends do not reset it. Existing run events still take ownership when a new workflow actually starts.
- Chrome retest on campaign `226`: the same prompt returned exact active review `#70`, tool `generate_social_media_post`, owner `content_studio`; composer became usable without reload and accepted the next revision prompt.
- Approval warning on `223` is truthful, not a failed query: a read-only database check found `requiresApproval=true` and a stale owner but no `pendingApproval`. The result correctly reports unavailable rather than inventing an executable approval. No metadata repair or execution was performed.

### CHROME-RETRY-02: ICP, specialist picker and first content review

- Campaign: `226`, fictional `Codex QA Demo Co. Revenue Analytics Outreach`.
- Approved its existing internal ICP draft only. UI displayed `ICP approved`, explained that lead platforms require separate confirmation, and offered next-agent choices. No search or outreach was launched.
- Typing `@` displayed Coordinator, ICP, Marcus, Alex, Emily and Sarah.
- Prompt: `@alex Prepare one text-only LinkedIn post for Codex QA Demo Co. about revenue forecasting for CTOs. Use no image, no video, and no carousel. Show the generation review card only; do not publish or schedule it.`
- Result: Coordinator-to-Alex handoff, Alex assignment, `Create Social Post awaiting confirmation`, durable review `#70`, LinkedIn selected, text format, both image/video generation switches off. `Confirm and run` remained unclicked. **Pass for routing and review rendering, not asset generation/publication.**

### CHROME-RETRY-03: revise an unexecuted card, not a saved asset

- Follow-up: `Make that same LinkedIn post shorter, with an exact CTA of "Book a demo". Keep it text-only with images and video disabled. Update the review only.`
- Actual before fix: `edit_saved_content` received `asset_id=70` (the review ID), guessed `expected_version=1`, and returned `Content asset not found`. It then queried assets and encountered Gemini HTTP 503/high demand. No saved asset changed.
- Cause: pending generation reviews and generated assets were not distinguished strongly enough in the Content agent's tool selection. This is particularly important when numeric IDs happen to overlap.
- Fix: explicit continuation of an owned active/draft generation review is limited to that review's generation tool; saved-asset edit, publication, schedule mutation and handoff tools are withheld. The prompt labels the review as unexecuted and provides its prior settings. Completed/cancelled/running reviews and explicit saved-asset edits are not reinterpreted as unexecuted cards.
- Regression checks: content agent/management/constraint suites, **3 suites / 26 tests passed**; client send/thread-recovery suites, **2 files / 25 tests passed**. Live corrected-revision result is recorded below when available.
- Separate provider limitation: Gemini reported temporary high demand after approximately 110 seconds. The UI eventually showed an explicit failure, not success. Do not count this failed revision as a browser pass.
- Chrome retest passed at 12:32: the explicit retry for review `#70` produced new unexecuted review `#71` through `generate_social_media_post`, with LinkedIn, short (1–2 lines), exact CTA `Book a demo`, text format and both media switches off. No asset-edit tool was called on the corrected turn. The original review remains visible; this test did not cancel it or execute either card.

### CHROME-RETRY-04: Outreach handoff and read-only readiness

- Prompt: `@emily Which saved leads are selected for this campaign, and are they eligible for email or WhatsApp outreach? Check existing data only. Do not send messages or create a campaign.`
- First result: explicit invalid AI-routing response, no specialist handoff. Saved reviews remained visible. **Failed attempt; not an all-green routing result.**
- Focused retry: `@emily Show the selected lead IDs for this campaign and explain email versus WhatsApp readiness. Read-only check.`
- Retry result: Emily called `query_leads` and `check_integration_status` for both channels. UI reported no campaign leads and connected Email/WhatsApp integrations. No message was sent and no outreach job was created. **Pass for retry, tool visibility and readiness lookup; not proof of delivery or recipient consent/eligibility.**
- The initial invalid routing response remains a reliability finding. It recovered on the next prompt; no provider/model configuration was changed.

TypeScript: client passed. Server initially exhausted Node's default 2 GB heap; rerunning the repository's `pnpm typecheck` script with its configured 4 GB heap passed. `git diff --check` passed.

### CHROME-RETRY-05: empty campaign outreach preparation

- Follow-up: `@emily Prepare email and WhatsApp outreach reviews for the selected leads in this campaign only. Do not select other leads, send anything, or start an outreach job.`
- Result: Emily reported 559 account leads but none linked to this conversation and offered explicit selection/import options. It did not silently select the account leads. **Pass for missing-recipient guard; sending remains untested.**

### CHROME-RETRY-06: analytics scope, unavailable data and completion state

- Prompt: `@sarah Show existing performance analytics for this campaign: impressions, clicks, CTR, spend and conversions, with charts if data exists. Use saved data only and explain missing data. Do not sync providers, create or publish ads, or spend money.`
- Result before fixes: Sarah prepared analytics review `#72`. Running this read-only query opened Campaign Analytics and rendered Spend/CTR visualizations, but showed three **account-wide** campaigns unrelated to conversation `226`. The summary correctly said no provider measurements were recorded, while the charts misleadingly plotted zeros. The tool chip remained `running` although the persisted widget was `succeeded`, attempt 1.
- Scope fix: explicit `this/current/active campaign` paid-campaign queries now filter by the tenant and the stored `settings.context.threadId` association. A conversation ID is never treated as a paid-ad campaign ID. Account-wide queries remain available and are labelled as such. This fix is specifically for paid-campaign analytics; it does not establish scoped lead/outreach/overview analytics coverage.
- Visualization fix: campaigns without measurements are excluded from plotted data; empty views state that data is unavailable. Cross-campaign CTR is labelled `CTR by Campaign`, not a time trend. Currency is displayed for spend values; measured zero bars have zero width.
- State fix: terminal succeeded/cancelled widget receipts cannot be overwritten by delayed running acknowledgements. Failed receipts cannot regress to an in-flight state for the same/older attempt; a newer attempt can run, and terminal-result reconciliation remains allowed. This race is reproduced in a component integration test.
- Tests: analytics server **3 suites / 13 tests passed**; structured analytics UI **2 tests passed**; widget context **23 tests passed**. The successful read-only query is not provider analytics sync or live measurement verification.

### CHROME-RETRY-07: ad copy review from Performance

- Prompt: `@sarah Prepare exactly three text-only Meta ad copy variations for Codex QA Demo Co. revenue forecasting, for CTOs. No images or videos. Show a generation review only; do not publish ads or activate a campaign.`
- Result: Performance handoff, `Generate Ad awaiting confirmation`, review `#73`, Meta selected, Text Only format, variation count `3`, both media-generation switches off. UI explicitly said no ad creative had been generated. **Pass for review settings, not generation or paid publication.**

Latest server typecheck rerun during concurrent workspace development encountered unrelated errors in `tests/knowledgeQuoteFormatting.test.ts` and `tests/supportNaturalReplyDelivery.test.ts` (missing `AgentResult.escalated`). Those files were not changed by this QA work. Do not interpret the earlier successful typecheck as a clean check of later concurrent edits.

Analytics Chrome retest at 12:44: review `#74` completed, showed `local status: succeeded`, and the original tool chip changed to `Query Analytics completed` without reloading. Campaign Analytics displayed `Current conversation #226`, no unrelated campaigns, and `No data is available for this view` for both Spend and CTR. This validates the scope and completion-state fixes on an empty QA campaign; positive provider-metric charts still need a populated scoped fixture.

Combined focused verification: server **6 suites / 39 tests passed**, client **4 files / 50 tests passed**, client TypeScript passed. No provider search, media generation, outreach send, social publication, scheduling dispatch, ad activation, or budget spend was approved. Read-only analytics reviews `72` and `74` were executed; generation reviews `70`, `71` and `73` remained active/unexecuted.

### CHROME-RETRY-08: Yelp to Google Maps multi-message catalog

- `@marcus Show only Yelp lead-generation workflows and their limitations. Catalog lookup only; do not prepare settings or run a search.` returned only Yelp Business Search, including the explicit not-live-verified/cost/approval caveats. **Pass.**
- Follow-up `@marcus Now show only Google Maps workflows, not Yelp or social media. Catalog only; do not prepare or execute a search.` incorrectly included both Google Maps and Yelp. **Failed before fix.**
- Cause: deterministic latest-turn channel extraction understood `do not`/`exclude` but omitted bare `not` and `no`, overriding the routing model with an incorrect channel list.
- Fix: recognize bare negative channel clauses while preserving `not only` as affirmative. Added the exact browser regression plus `no Yelp` and `excluding Yelp` variants. No scraping or search-settings preparation was performed.
- Semantic router suite: **39 tests passed**.

### CHROME-RETRY-09: calendar timezone and scheduling prerequisite

- Asked Alex what was scheduled for this campaign on September 23, 2026, Asia/Kolkata. The visible completed `query_scheduled_posts` call used `scope=current_campaign`, `from=2026-09-23T00:00:00+05:30`, `to=2026-09-23T23:59:59+05:30`, returned no posts, and identified its source as saved schedule rather than live provider state. **Pass for lookup and timezone.**
- Follow-up requested a scheduling review for the latest generated LinkedIn asset in this campaign at 09:00 Asia/Kolkata, explicitly forbidding actual scheduling/publication. Alex correctly explained that review-only content had not been generated/saved and could not yet be scheduled. **Pass for missing-asset guard; no publish/schedule review was created.**
- However, its `query_content_assets` lookup returned 18 account assets instead of restricting the current campaign. No unrelated asset was selected or mutated, but the lookup scope was wrong.
- Fix: campaign content listings default to current-conversation scope. Explicit `all_owned` browsing remains supported; exact asset-ID queries remain tenant-owned for intentional library reuse, with an explicit current-campaign option. Invalid current-campaign identity fails closed. Added SQL predicate/contract tests: **3 suites / 25 tests passed**.

### Final Chrome retests and verification

- **CHROME-RETRY-08 passed after the fix (12:52 IST):** the identical Google Maps-only follow-up returned one Google Maps Business Search row/button, without Yelp or social workflows. No search review or provider search was started.
- **CHROME-RETRY-09 passed after the fix (12:52 IST):** `@alex List saved social posts from this campaign only, for the scheduling review. Read-only lookup.` called `query_content_assets` with `scope=current_campaign`. Expanded tool output showed `threadId=226`, `assets=[]`, and `Retrieved 0 content assets.` No unrelated account assets were returned.
- Final combined server run: **10 suites / 103 tests passed** (semantic routing; content asset query schema/executor/data-query tools; content agent/lifecycle/constraints; analytics conversation scope/currency/insights).
- Focused client run: **4 files / 50 tests passed**; the final widget-state refinement also passed its **23-test** rerun. These overlapping reruns are not additive unique totals.
- Latest server `pnpm typecheck` passed after concurrent support-test changes settled, superseding the transient unrelated errors recorded above. Those support files were not edited by this QA work.
- Final client `pnpm exec tsc --noEmit` **failed** in the concurrently added `src/__tests__/followUpActivity.test.tsx:51`: a `string` is not assignable to the channel union (`email | sms | facebook | instagram | whatsapp | undefined`). This unrelated file was not edited by this QA work. Earlier client typechecks passed, but the current shared workspace is not client-typecheck clean.
- `git diff --check` passed. Fixes from this Chrome retry are local working-tree changes, not a new commit. Concurrent unrelated edits were preserved.

**Acceptance boundary:** this is verified multi-turn chat/review/read-only behavior, not a claim that all 53 tools or every provider works end to end. The initial invalid routing response and temporary Gemini 503 remain observed reliability limitations. Actual lead extraction, content generation, email/WhatsApp delivery, scheduled dispatch, social/ad publication, and populated provider-metric charts still require dedicated fixtures and authorized execution. Model-backed chat itself consumed workspace AI credits; no provider search, send, publication, ad activation or ad-budget spend was approved. The Chrome campaign tab and QA application servers remain available for follow-up.

## Live chat scroll-area fix — 2026-09-22, 13:00–13:05 IST

User report: while chatting, messages occupy only a short scrollable strip at the top; refreshing temporarily restores the layout.

### Reproduction and cause

Inspected the existing Chrome campaign `226` before reloading. The Radix scroll-area root had `overflow: hidden` and a nonzero `scrollTop` of approximately **159 px**. Its visible top was **143.67 px**, while the nested message viewport began at **−15 px** despite both being **709 px** tall. The outer root was scrolling/clipping the viewport itself, not simply scrolling the messages. `overflow: hidden` still permits programmatic/focus-induced scrolling; an auto-sized percentage-height viewport also depended on live content layout. This explains why resetting the page temporarily corrected the position.

### Fix

- In `ChatInterface.tsx`, the outer message scroll-area uses `overflow-clip`, so it cannot become a second scroll container.
- The Radix viewport is absolutely pinned with `inset-0` to the available flex slot, independent of streamed text/widget height. Padding remains inside that viewport.
- Added `min-h-0` to the intermediate chat column. The composer remains outside the scroll region.
- Updated the overflow contract tests to preserve these boundaries. Shared ScrollArea behavior in other application screens was not changed.

### Chrome verification

Reloaded once to load the changed development bundle, then performed all following checks **without another refresh**:

1. Sent `What review actions are currently pending in this conversation? Read-only status check; do not execute anything.` Checked layout during processing and after the assistant reply.
2. Sent `@alex List saved social posts from this campaign only. Read-only lookup; do not generate, schedule, or publish anything.` Observed the completed `query_content_assets` tool and reply.
3. Restored the result panel after it minimized during the turn. Message width changed from **1664 px** to **915 px** without losing viewport height.
4. Expanded the latest completed tool card; the full details and final reply remained visible. A screenshot confirmed messages fill the vertical area above the composer.
5. Scrolled upward through history. The viewport moved **1232 px** away from its bottom while the outer root remained at zero.

Across these checks, root `scrollTop` remained **0**, root and viewport top both stayed **143.67 px**, and both heights stayed **709 px**. At the live edge the bottom gap was **0–0.34 px**, allowing for fractional pixel rounding. **Pass for live-message, tool expansion, split-pane and manual-scroll layout.**

Automated verification: **3 test files / 41 tests passed** (`conversationOverflowContract`, `conversationDraftRecovery`, `chatInputArea`); client `pnpm typecheck` passed; `git diff --check` passed. This latest typecheck supersedes the transient concurrent-test failure recorded in the preceding run. No live provider action was approved.

Separate observation, not fixed or signed off by this layout change: the first status prompt was answered by Marcus and incorrectly called completed review `74` active/draft. The earlier durable status shortcut worked for its exact prompt, but this expanded wording did not establish reliable review-status routing. Keep that as an additional status-grounding regression case; it does not invalidate the measured scroll-layout pass.

### Model-based interpretation follow-up — 2026-09-22

The status-routing failure above passed a subsequent semantic-router Chrome retest: a paraphrased question with `@marcus` now uses the durable ledger and reports review 74 succeeded. [The semantic-intent report](SEMANTIC_INTENT_ROUTING_QA.md) includes that exact prompt, Tamil Google Maps-only negation, safe outreach routing, review revision checks, the discovered length regression and final verification boundaries.

### Missing agent suggestions and chooser — 2026-09-23

User report: after ICP approval, the coordinator says to choose an agent but offers no choices; the chooser does not open.

**Cause:** `APPROVE_ICP` filtered its three hard-coded hire buttons against the selected pipeline, but omitted Outreach from those buttons. An Outreach-only pipeline therefore yielded an empty list. The handler also emitted no chooser-open event. Explicit chooser navigation changed the active tab without restoring a minimized result pane or selecting the mobile results pane. The chooser ignored its `recommendedAgents` prop when ordering specialists.

**Changes:** include all four specialists in the canonical selection builder; retain a valid selected team; fall back to the four available specialists only when no valid team is selected. Persist an explicit Choose agent action and recommendations alongside the approval reply. Emit a thread-scoped chooser event, with an HTTP acknowledgement fallback for the requesting client. Opening the chooser restores the result pane and selects the mobile results pane. Add a permanent composer Choose agent control. Old empty-choice messages with structured `workflowStage=agent_selection` get a UI-only recovery button without interpreting their prose. Recommendation IDs now order the chooser even without scores. Existing revision/ownership, recipient and execution approval gates remain unchanged.

| Case | Result |
|---|---|
| Production campaign 209 inspection | Confirmed approval text had no choices. Manual Add result view → Agent Choose did open all four specialists; a universal tab-rendering failure was not reproduced. No agent was hired during this inspection. |
| Local Chrome: open from minimized pane | Permanent Choose agent restored the result pane and rendered Marcus, Alex, Emily and Sarah. Pass. |
| Local Chrome: reopen an existing chooser | Only one Choose Agent tab remained; Emily was visible. Pass. |
| Local Chrome: preserve draft | Typed a QA-only draft, minimized and reopened the chooser; draft remained and no message was submitted. Cleared the test draft afterward. Pass. |
| Automated real approval handler | Outreach-only pipeline persisted HIRE_OUTREACH, returned agent_selection and emitted the thread-scoped chooser event without executing outreach. Failed revision and completed replay did not open it. Pass. |
| Automated legacy UI recovery | An empty-choice agent_selection message renders a working OPEN_TAB button; an Outreach-only choice renders Hire Emily. Pass. |

Verification: **4 server suites / 39 tests passed; 5 client files / 57 tests passed; server and client typechecks passed; git diff --check passed.** Tests cover chooser visibility for new/existing tabs, draft-safe opening during processing, approval replay/revision boundaries, and normal action resolution. The testing skill guided browser interaction checks; its separate helper was unavailable, so Google Chrome was driven directly.

Deployment boundary: changes are local/uncommitted and not deployed to asksales.ai in this task. The local account did not contain campaign 209, so the corrected fresh-approval endpoint was exercised in isolated handler tests, not by reapproving the user's live campaign. Live Chrome verified the updated local chooser UI. No outbound send, lead search, publication or spend was performed.
