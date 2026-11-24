# Campaign user-behavior QA

Started: 2026-09-23. Status: resumed in Chrome at approximately 16:03 IST; implementation and acceptance verification remain in progress.

Goal: exercise multi-message, user-like campaign conversations in Google Chrome, identify failures from actual behavior, fix them individually, and verify the fixes. Do not treat unit-test success as proof that the whole conversation works.

## Environment and boundaries

- Existing local code contains the prior three race/fallback/team-hire fixes and regression tests. Those remain uncommitted at this session's start.
- Other work is modifying proposal/support services; preserve unrelated changes.
- Local frontend at localhost:3000 initially remained at the loading shell; its Next dev process was live and CPU-active.
- The API listening on localhost:8080 uses `.local/start-live-support-qa.ts`: isolated Support AI snapshot, restricted HTTP mutation routes, model-only egress. It is not a general campaign test backend. Do not weaken or restart that shared setup.
- Live AskSales Chrome testing will use labeled synthetic QA campaign drafts and review-only requests. No outreach delivery, public publishing, scheduled delivery, ad activation/spend, or provider execution approvals without specific authorization.

## Acceptance matrix

| Case | User behavior | Required evidence | Status |
| --- | --- | --- | --- |
| J01 | Start with an incomplete campaign request, then answer clarification | Latest reply uses the supplied business, audience, region and goal | Failed live first turn; local routing fix tested, live retest pending |
| J02 | Correct audience/region and change intent mid-conversation | New intent supersedes obsolete context; no unwanted execution | Passed live ICP correction (campaign 210, revision 2) |
| J03 | Review/approve ICP and choose or change specialist | Appropriate agent choices, working chooser, correct agent ownership | ICP approval passed; manual @ picker and Agent Choose tab passed live at ~16:37; automatic post-ICP suggestions still need fresh-flow retest |
| J04 | Request lead workflow options and narrow platforms/results | Correct catalog and editable review inputs; searches remain unapproved | Passed post-release Chrome: LinkedIn-only cap 5, then Hyderabad/cap 3; same roles/size retained and Chennai ICP unchanged; no search |
| J05 | Request email and WhatsApp outreach from campaign leads | Accurate eligibility/recipient review, missing-data handling, execution approval | Empty-recipient gate passed; new pending-review side-question routing defect reproduced live and fixed locally; release/browser retest pending |
| J06 | Draft social content, revise tone and request schedule preview | Correct revisions and schedule context; no public/scheduled delivery | Draft #274 generated correctly; duplicate active review fixed locally; disconnected LinkedIn prerequisite was hidden by grounding, local fix tested |
| J07 | Draft an ad and revise budget/audience | Correct review widget and pending approval; no ad activation | No matching creative; no execution. Missing-prerequisite and budget follow-up explanations fail live; typed empty-query evidence added locally, follow-up gap remains |
| J08 | Ask for campaign status, performance, and graphical results | Campaign-scoped data/widgets; honest empty/unavailable states | Analytics tab correctly scoped to #210 with honest empty charts; natural-language summary degrades to generic lookup fallback |
| J09 | Switch campaigns, refresh, navigate tabs and reopen chooser | No cross-campaign replies/state; stable result tabs and draft behavior | Manual chooser/tab navigation passed; 210→205→210 cleared cross-campaign state but return showed blank workspace until refresh; updated-build retest pending |
| J10 | Long and multi-turn chat, pending reply, cancellation/correction | Full-height scroll, accessible composer, no duplicate action submissions | Pending |

## Findings and fixes

### J01 — contextual planning answer discarded

Live campaign: `https://asksales.ai/dashboard/conversations/210`, created through Chrome at approximately 14:39 IST. Header after ICP creation: **Oro Circle Bengaluru Corporate Offsite ICP**.

Prompt: “QA User Journey Sep 23 — I want a campaign for Oro Circle to attract more corporate offsite bookings. Help me plan it, but do not contact anyone, scrape leads, schedule posts, publish ads, or spend money. What do you need from me first?”

Observed: the supervisor returned the hard-coded “I'm not quite sure how to help with that request” capabilities list, ignoring the concrete business goal and request for planning inputs.

Root cause: `orchestrator.ts` treated a first-turn task with no hired specialist as unsupported and discarded the router's contextual response. Later no-specialist questions could also fall through to the current specialist or implicit ICP generation.

Local fix: preserve the model's response for questions without an assigned specialist; leave pending approvals and pipeline state unchanged. The first-turn no-agent fallback also uses the contextual response via the normal single-persistence path. Router instructions explicitly recognize planning/onboarding questions without inventing execution intent. No user-text regex matching was added.

Regression evidence: **98 tests passed across 4 suites** (`orchestratorRouter`, `semanticRouterRegression`, `orchestratorSemanticState`, `multiMessageAgentAcceptance`), including five new cases for first-turn contextual responses and later questions with a pending review. This is a local-code result, not a live deployment or browser retest.

### J02 — multi-field correction

Follow-up requested an ICP only for HR managers/founders in Bengaluru, 100–500 employees, 20–40 person overnight offsites. Revision 1 correctly retained those details; its regions also included the venue's Nandi Hills location.

Next prompt: “Actually, change the prospect location to Chennai only, not Bengaluru or Nandi Hills. Keep Oro Circle as the venue. Target HR and People Operations managers only, exclude founders, and change company size to 50–200 employees. Keep the 20–40 person overnight offsite offer. Update the ICP draft without approving it or starting anything else.”

Observed revision 2: Chennai only; HR/People Operations roles without founders; 50–200 employees; unchanged offsite offer. The profile remained a draft with a separate Approve ICP button. **Pass.**

### J03 — ICP approval and specialist handoff (ongoing)

Clicked Approve ICP on revision 2 only. The transcript showed “ICP approved · Selected” and next-agent choices for Marcus, Alex and Sarah. Outreach and automatic chooser opening remain absent in the deployed UI; the earlier committed local chooser fix is not reflected there. Clicked Choose Marcus to continue the review-only journey; no lead search was approved.

Marcus completed `list_available_workflows`, recommended LinkedIn Company Employee Extraction and Google Maps Business Search, and offered Prepare Search Settings / Show All Strategies. No search executed. The chat screenshot showed a full-height scroll region and reachable composer, not the earlier short-scroll defect.

### J04 — natural-language strategy choice cannot prepare a review

Prompt: “Use only LinkedIn Company Employee Extraction, not Google Maps. Prepare its search settings for Chennai companies with 50–200 employees and HR or People Operations managers. Cap the saved results at 5. Show the review card only; do not run the search.”

At 14:45 IST, Marcus replied that no review card was created because the required tool was unavailable. Its unsaved outline correctly preserved LinkedIn only, Chennai, 50–200 employees, HR/People Operations roles, five leads, and exclusions. No Lead Inputs tab or executable search review appeared. This is a functional failure, not a pass just because no external execution occurred.

Source trace: `LeadAgent.preProcess` exposes `generate_lead_inputs` only after `getLatestLeadStrategySelection` finds a durable selection. `recordConfirmedLeadStrategy` in `chatController.ts` is called by bound button actions (`LEAD_AGENT_START` / `LEAD_AGENT_USE_WORKFLOW`), not ordinary natural-language strategy selection. `executeGenerateLeadInputs` independently enforces the same durable gate. The fix must preserve that gate and create a validated, exact, current-run strategy selection from model-interpreted user intent; merely exposing the tool or bypassing the executor check is not sufficient. Keep execution approval separate.

Local implementation:

- `routerSchema.ts` adds a structured, optional strategy selection (`none`, `selected`, or `ambiguous`) with exact workflow IDs. Existing saved decisions without the field do not acquire consent.
- `unifiedRouter.ts` gives the AI the installed strategy IDs/titles/channels. It interprets the complete latest request rather than matching user prose with regular expressions.
- `leadStrategyIntent.ts` validates the AI's choice against the real catalog and requested channels. Empty, invented, ambiguous or excluded choices require clarification. Questions, cancellations, catalog browsing and shortlist edits cannot establish a strategy selection.
- `chatController.ts` saves the validated selection on the owned campaign run before specialist dispatch, only with the current ICP revision approved. It updates the saved strategy IDs, retires an obsolete lead-search approval, and clears that retired approval from the in-memory dispatch state. An unrelated pending review or a running search blocks the change.
- The existing specialist/executor durable-selection checks remain in place. Preparing settings never grants permission to execute a search.

Regression evidence: exact LinkedIn-only selection is persisted before dispatch; unapproved ICP, unrelated pending outreach review, and running-search cases do not create a selection or dispatch work. Router tests verify catalog grounding and clarification for invented IDs. These regression tests isolate persistence and model/provider calls. The separate live-model result is recorded below; the rendered review card still needs a Chrome retest.

### Live-model routing canary — 2026-09-23 continuation

Chrome access was retried and still returned `Transport closed`. Instead of treating mocked model responses as sufficient, ran `server/scripts/verify-campaign-journey-intents.ts` against the loopback QA snapshot `salesmarketing_live_qa_20260923`, using its existing provider configuration. Confirmed the copied ORO business belongs to local user 9 before choosing that configuration. The configured intent classifier was OpenRouter `typesafe/jev-1.13`; the actual unified router used its normal classifier/full-model/fallback path. This result does not assert which classifier labels were accepted on every turn.

**Seven of seven live-model cases passed.** All prompt history was synthetic. The first two cases form a successive selection/correction conversation; later cases branch from the strategy-recommendation context. The script never calls agent dispatch, saves a strategy, creates a campaign/review, or approves execution. Only billable model calls and their local usage/logging records are possible.

| Case | Actual structured decision |
| --- | --- |
| LinkedIn only, exclude Google Maps, Chennai, cap 5, review only | Lead Generation; exact `linkedin_company_search_employees` selection; LinkedIn only; limit 5 and Chennai preserved |
| Follow-up: cap 3, Hyderabad, same strategy, still no search | Settings revision; limit 3 and Hyderabad; no new strategy selection |
| Explain why two strategies were recommended; no settings/search | Question; no specialist dispatch; settings false; no strategy selection |
| Switch to Emily for email/WhatsApp review from this campaign only | Outreach; outreach operation `campaign`; scope `current_campaign`; settings false |
| Switch to Alex for a friendly concise LinkedIn text draft | Content Studio; generation operation; short text; no image/video |
| Switch to Sarah for a Meta ad review, INR 500 daily, no spend | Performance Marketing; paid platform Meta; response retains INR 500/day and review-only restriction |
| Ask pending review/delivery status without execution | Question; `campaign_actions` status; no specialist; current-campaign scope |

This verifies live AI interpretation, not recipient eligibility, specialist tool execution, durable review creation, schedule validation, graphs, or rendered widgets. J04's real-model selection gap is now checked; its browser/card gate and J05–J10 remain open. The script typechecks with the server and refuses to run without explicit loopback QA database selection, positive user ID and `--execute`.

### Additional regression finding — stale catalog coverage

The broader regression run found two failures in `leadWorkflowRetirement.test.ts`: it expected 28 active strategies while the installed catalog has 29. Inspection confirmed the additional Yelp Business Search was intentionally added in commit `195bc38b3`; it was not a retired workflow leaking into the catalog. The “every channel” test also omitted Yelp. Updated the expected count and added explicit Yelp assertions for both public endpoints and the chat catalog, while retaining all 16 retired-strategy exclusion/execution checks. No provider workflow was executed or removed.

### Current verification limits

- Server regression rerun: **336 tests passed across 24 suites**, including semantic routing/strategy selection, controller handoff, settings persistence, ICP and execution approvals, multi-message behavior, outreach read-only routing, action status, publishing review, cancellation, and active/retired strategy contracts. The first broader run had 334 passing tests and two stale catalog-count failures; both pass after the Yelp coverage correction above.
- Client regression rerun: **142 tests passed across 13 files**, covering delayed HTTP replies, selected business fallback, chooser submission, composer, navigation, tab reload, scroll layout contracts and stream state. See `CAMPAIGN_CONVERSATION_RACE_FIX_QA.md` for the three original fixes.
- Client and server `pnpm typecheck`: **PASS** on the current tree. Earlier proposal-file errors no longer reproduce; this task did not modify those files. Two typing errors in this task's new handoff/test code were corrected before the successful server check.
- Chrome intermittently reports debugger/CDP timeouts. An uncertain Send click was checked against the transcript before any repeat; the J04 prompt was already delivered, so it was not resubmitted.
- The latest browser-control calls now fail immediately with `Transport closed`, including the documentation-recovery call. This blocks the next Chrome interaction, not evidence that the application itself failed. No browser bypass, live deployment, or real outreach/publication/search was attempted to work around it.
- A subsequent goal continuation retried Chrome and received the same transport error. It nevertheless completed the seven live-model routing checks above; the goal is still incomplete, not blocked solely on the basis of this retry.
- An attempted J05 outreach prompt failed while locating/filling the composer. Its submission is unconfirmed; inspect the draft/transcript before retrying. Intended prompt: “Leave the lead search unstarted. Switch to Emily: for the leads already selected in this campaign, prepare an email and WhatsApp outreach review for the corporate offsite offer. Tell me how many have usable email addresses or phone numbers and what is missing. Do not borrow leads from other campaigns, create new leads, or send anything.”

Initial local loading delays and API restrictions are environment observations, not automatically product bugs.

The testing skill requires separate browser verification for user journeys. Unit/component results above are deliberately not recorded as full Chrome acceptance. The latest listener check also found neither local port 3000 nor 8080 listening; the earlier environment descriptions are historical, not a claim that those services remain available.

## Completion gate

Record prompts, campaign IDs, visible outputs, root cause, changed files, and retest evidence for each discovered defect. Keep unverified or unavailable provider paths explicitly open; do not mark this goal complete from a narrow passing test subset.

## Blocked audit — 2026-09-23

Historical blocker: browser access was subsequently restored and this goal resumed. The evidence below explains the earlier stop, not the current connection status.

The browser transport failure has now recurred across at least three consecutive goal turns. The earlier turns still made progress through fixes, regression coverage and seven real-model routing checks. In the latest turn, both `cua.getState()` and the browser-session reset failed immediately with `Transport closed`. Tool discovery found no alternative Chrome control or browser-test runner available in this session. The user's request to use Chrome remains in force; no in-app-browser substitution was made.

Re-read the current acceptance matrix and worktree before this decision. J01/J03/J04 still need post-fix browser evidence, and J05–J10 require actual multi-message UI interactions and rendered outcomes. The 478 regression tests and seven live-model decisions do not close those gates. No new product defect was established by the transport failure, and no speculative product edit, deployment or production execution was used to bypass it.

Required external change: restore the Codex browser-control connection to Google Chrome. After restoration, first inspect campaign 210's transcript and composer to resolve the uncertain J05 submission before sending anything again. Continue the remaining journeys and retest local fixes in an accessible authenticated QA application; deploying them to production is not implicitly authorized. The goal is blocked, not complete.

## Resumed Chrome journey — 2026-09-23, 16:03 IST onward

Reopened campaign 210 in Google Chrome. Its transcript ended at the 14:45 Marcus failure; the previously uncertain J05 prompt was absent and the composer empty, so it was safe to submit once. The live deployment still lacks the local chooser affordance. The chat remained full-height with the composer at the bottom while processing the new message.

### J05 — missing recipients, misleading handoff, and readiness misrouting

1. Requested Emily to prepare email and WhatsApp reviews using only this campaign's selected leads, explicitly prohibiting borrowing/importing leads or sending messages.
2. Emily reported 601 account leads but no leads linked to the conversation and offered selection/import actions. No send review appeared and no send was approved. This is correct missing-recipient gating, not proof of provider eligibility.
3. Coordinator handoff said “sequence and launch the outreach campaigns,” despite the review-only instruction. Source: random hard-coded handoff phrases in `orchestrator.ts`. Local change makes Outreach handoffs explicitly non-sending and removes the Lead Generation handoff's promise to pull prospects. Both random variants have regression coverage.
4. Follow-up: “Keep the recipient selection empty. Do not select or import any account leads. For this campaign only, can we currently send email or WhatsApp, and what exact prerequisite is missing? Answer only; do not prepare or send anything.”
5. Actual response: a generic durable execution/receipt ledger, including no pending reviews and unavailable delivery counts. It did not answer readiness or the missing-recipient prerequisite. This is a routing failure, not a delivery failure.
6. Local change distinguishes prospective readiness from historical execution/delivery in both the full router and intent classifier instructions. Readiness/contact eligibility/sender prerequisites route as `action=question`, `status=none`, owner Outreach, preserving current-campaign scope. No regex matching of user prose was introduced. Added the exact two-turn pattern to the real-model canary; its result will be recorded separately.

### J06 — constrained social-post review

Requested Alex to prepare one friendly, concise LinkedIn text-only post about Oro Circle corporate overnight offsites, no prices/discounts, ending exactly “Ask us about your next team offsite.” and no publication/scheduling.

Observed review **#132**, tool **Create Social Post**: LinkedIn only; casual tone; Short (1–2 lines); Text format; exact CTA preserved; image/video generation off; content instructions retain offer, audience, no-price/discount constraints. It correctly says the action has not run. Submitted a follow-up to change tone to professional while preserving all other constraints; no generation/publication approved at this point.

The follow-up produced review **#133** with Professional tone and all constraints preserved, but review **#132** remained active with its original Casual tone and an enabled Confirm and run button. Confirmed both states in the browser DOM. Source: `toolCallingLoop.ts` creates another widget when revised arguments differ; it had no branch to retire the AI-identified prior review.

Local fix: `WidgetStateModel.replacePendingReviewForUser` locks and validates the exact tenant/thread/tool-owned active or draft review, inserts its replacement and marks the original cancelled in one transaction. Insert failure rolls back; a previously claimed/running/terminal review cannot be replaced. The tool loop uses this path only for the semantic `revise_review` target and emits the old card's cancelled state; the replacement ID is recorded durably on the old card. Other reviews remain unchanged. Tests cover exact-card replacement, wrong owner/thread/tool, claimed/terminal states, failed insertion, and rejection of a stale browser approval after supersession.

Live recovery/cancellation check: asked to cancel only #132 and leave #133 and the campaign unchanged. The browser showed #132 Cancelled, #133 still awaiting review, and a precise cancellation receipt. **Targeted cancellation passed.** Then used #133's Confirm and run for internal text generation only. It completed and opened a LinkedIn result tab with draft **asset #274**. The generated caption preserves audience/offer and exact CTA, with no prices, discounts, images or video. The follow-up receipt also queried saved content and confirmed asset #274 as draft, but displayed an awkward claim-verification fallback; that presentation needs follow-up, not a claim that generation failed.

Next request: a scheduling review for asset #274 on 25 September 2026 at 10:00 AM Asia/Kolkata, preserving text and prohibiting job creation/publication/approval. No publication or scheduling review has been approved.

Current local verification for this resumed pass: **139 tests across 6 routing/outreach suites passed**, **71 tests across 4 widget/content suites passed**, and **9 PostgreSQL TEMP-table replacement tests passed**. The extended real-model canary passed **8/8**, including the exact readiness-not-receipts case. These are local changes, not a deployed/browser retest of the new fixes.

### Scheduling prerequisite and response-grounding defect

At 16:12, the scheduling request only queried asset #274. A corrective follow-up explicitly requesting a new scheduling approval card called `check_integration_status(linkedin)` at 16:14. Expanded the tool card in Chrome: `platform=linkedin`, `connected=false`, with instructions to connect Settings → Integrations. The user-facing reply discarded this actionable prerequisite and said only “lookup completed.” No scheduling job or publication was approved.

Root cause established in `responseGrounding.ts`: the typed evidence omitted integration connection fields, and its conservative fallback had no integration summary. Added an allowlisted platform plus strict boolean projection to the auditor evidence and deterministic fallback. Disconnected status now explains the connection prerequisite; connected status does not imply account eligibility or authorization. Arbitrary tool prose, nested fields and secrets are not copied. Added regression tests for false/true/malformed connection states and evidence projection. This does not fabricate a scheduling card or bypass missing credentials.

The exact scheduling-review prompt was also added to the live-model routing canary: **9/9 passed**, including `publish_new`, Content Studio ownership, and non-question action. This distinguishes correct local intent recognition from the deployed specialist/response path.

### J07 — paid review and budget correction

At 16:18 requested Sarah to prepare a Meta lead-ad review, Chennai HR/People Operations, INR 500/day, prohibiting media generation, publishing, activation and spend. Correct specialist handoff occurred. Expanded tool card: `query_content_assets`, scope `current_campaign`, thread 210, type `ad_copy`, channel `meta`, returned `assets=[]`. No suitable saved creative was available, so no execution was approved. However, the final reply only said no identified assets and no card; it omitted the actionable prerequisite and requested settings.

Follow-up changed budget to INR 300, preserved audience/location, and requested an unsaved plan plus an explanation of the creative prerequisite. The reply was the generic “could not verify” fallback, with no useful budget/audience answer. This remains an **open conversational acceptance defect**, not a successful budget revision. Added typed returned-record-count evidence so the auditor can preserve an explanation of an empty current lookup. This only supports the current lookup, not historical or account-wide absence; the no-new-tool follow-up still needs a verified contextual solution and browser retest.

### J08 — campaign-scoped analytics

At 16:19 requested spend, impressions, clicks, leads, delivery and charts for this campaign only, explicitly forbidding borrowed account data and invented zeros. `analytics_query` completed and opened **Campaign Analytics — Current conversation #210**. Both Spend by Campaign and CTR by Campaign showed **No data is available for this view**. This is correct empty/scoped widget behavior. The natural-language summary again degraded to “analytics_query: lookup completed”; useful contextual summaries remain open. No provider mutation occurred.

Latest verification: **117 tests passed across responseGrounding, toolCallingLoopProviderFallback, contentManagementAgent and widgetRoutes**, after adding the connection/empty-query coverage. An initial direct Jest invocation omitted the repository's ESM flag and ran no tests; rerunning through `pnpm test` passed. This count overlaps the earlier widget suite counts and must not be added as unique coverage. No production deployment or commit was performed.

Server `pnpm typecheck` passed after these final changes. Refreshing Chrome preserved the transcript, review #132 Cancelled, review #133 Completed, LinkedIn result tab, and selected Campaign Analytics tab scoped to #210. Cross-campaign navigation and the updated chooser still require acceptance testing. The testing skill's separate browser acceptance gate remains open: local regressions do not certify the deployed application.

## Analytics integrity continuation — 2026-09-23

Previous turn classified as progress: new Chrome evidence, local fixes, passing tests and updated case records. Re-read the current executor while tracing the generic analytics response. It showed three additional defects that the empty paid-campaign browser case could not expose:

1. Only `query_type=campaign` applied the conversation constraint. Lead, outreach and overview queries read account-wide rows despite a current-campaign request.
2. Database read errors were caught and returned as empty arrays/zero counts, creating false empty-success results.
3. Outreach counted every saved row as sent, then estimated delivery from sent status. Overview described every saved campaign as active.

Local correction in `analyticsExecutor.ts`: all query types retain conversation scope; leads match the owned conversation association or owned ICP; messages require an exact owned outreach campaign's `settings.threadId`, with inbound, queued and failed rows excluded from sent counts. A tool argument cannot widen an explicit semantic current-campaign restriction. Delivery requires delivered status/timestamp, never an estimate from sent. Query failures fail closed without emitting a misleading empty analytics tab. Overview labels saved campaigns rather than claiming activation. Explicit all-owned reports remain available.

Validation: **32 tests across four analytics suites passed**, including **four actual PostgreSQL TEMP-table tests**. Fixtures included same-user other-campaign records, other-user records, wrong-owner ICP/campaign associations, inbound/queued/failed messages and an empty conversation. All inserts used temporary tables and explicit IDs; no application data or sequences changed. The first fixture attempt used invalid UUIDs and failed before assertions; corrected UUID fixtures pass. Existing mixed-currency and measured-versus-missing chart tests also pass. Browser retest against the updated build remains required.

Release coordination: a separate user-authorized release task reported committing the earlier shared changes and merging release branches. This task has not deployed or changed Git history. The new analytics patch is being handed to that task after validation; pending model-response/whole-journey acceptance must not be inferred from release inclusion.

The release task subsequently confirmed the four-file analytics integrity patch was committed as `6e3ab736`; its protected rollout was still in progress at that report. Server typecheck passed. This is commit evidence, not a browser/deployment acceptance result.

### Generic analytics response — reproduced with the real model and corrected locally

Added `server/scripts/verify-campaign-response-grounding.ts`: explicit loopback QA database/user and `--execute` required; synthetic drafts/receipts only; no agent dispatch, tools, campaign writes or provider mutations. Like the intent canary, model calls are billable and locally logged.

Before the additional fix, **3/4** synthetic safe replies survived the real verifier: the INR 300 unsaved budget plan, empty-creative prerequisite and disconnected LinkedIn explanation passed. The campaign-scoped empty analytics explanation was replaced by the generic “analytics_query: lookup completed” fallback. Calls completed in approximately 2–7 seconds, so this reproduction was not a timeout.

Root cause: analytics receipts were classified as successful queries but all actual metrics, scope and empty-result evidence were omitted from the auditor input. Added `analyticsEvidence.ts` to project bounded, documented numeric metrics, validated campaign IDs/currencies, explicit scope and measured flags. It excludes arbitrary tool summaries, names, nested prose and provider claims. Missing measurements remain unavailable; unlike currencies are not summed; sent does not imply delivered. Both the semantic auditor and fail-closed deterministic fallback now receive useful typed evidence.

After this local change, **4/4 real-model cases preserved their safe useful replies**. **95 tests across five analytics/grounding suites passed**, and server typecheck plus `git diff --check` passed. These counts overlap prior analytics checks. The new response patch is separate from the packaged release snapshot and was not deployed by this task. It proves the grounding boundary for these synthetic cases; the complete live budget follow-up still requires specialist/browser retest, because its original generated draft was not captured.

## Chrome navigation and chooser continuation — approximately 16:32–16:37 IST

Revalidated the dirty tree and release task before testing. Its authoritative task status was still active/in-progress; no deployed SHA/health confirmation had arrived. The previous turn was progress (analytics integrity/grounding implementation with regression and real-model evidence); this continuation includes new browser evidence and a bounded verified wait on the active release task.

### J09 — navigation did not fully pass

Opened existing QA campaign 205 from campaign 210's sidebar. Chrome initially reported a command-dispatch timeout; inspecting the page before retry avoided blind repeated actions. Campaign 205 eventually rendered its own title with empty messages/tabs, not campaign 210's transcript. Returning to 210 eventually changed the URL but displayed “AI Assistant,” empty messages and no workspace tabs. Console showed two `AbortError: signal is aborted without reason` errors from the deployed conversation-page chunk. A refresh restored campaign 210's correct transcript and saved ICP/LinkedIn/analytics tabs. No message or execution was submitted during this check.

This is a **failed navigation/recovery acceptance case**, not evidence that the campaign was lost. The current local source already contains owned-load guards, transient-failure retry UI and tab timeout handling that require verification against the actual deployed build. Do not make a speculative extra loader edit or classify deployment/CDP timing as the confirmed root cause. Retest the same navigation after the release task confirms cutover.

### J03 — manual agent controls passed

On restored campaign 210, typed `@` into the composer. The live list showed AI Coordinator, ICP Specialist, Marcus, Alex, Emily and Sarah. Selecting Emily inserted exactly `@emily ` and did not send a message. Cleared that unsent test text. Then opened Add result view → Agent Choose. The Agents tab rendered all four specialists, including Emily, with working visible Start controls. No Start control was submitted. Closed only the transient Search tab; left Agents open for continuing QA.

Manual mention selection and manual Agent Choose opening are now proven in Chrome. Automatic post-ICP suggestions/opening and duplicate-hire prevention remain separate fresh-flow tests. These observations must not be mistaken for a confirmed post-release result while the release status is still in progress.

## Post-release acceptance — 2026-09-23, 16:44 IST onward

Release task confirmed deployed SHA `6e3ab7362bcdd0420935477a178889b2c50604f7`, API/workers/frontend restarted at 11:12:54 UTC and healthy. The later analytics-grounding changes are explicitly excluded. Reloaded campaign 210 in Chrome; the new **Choose agent** composer button is visibly present, confirming the updated frontend affordance. The composer was empty before the next prompt.

J04 retest submitted once at 16:44: “Switch back to Marcus. Use only LinkedIn Company Employee Extraction, not Google Maps. Prepare its search settings for Chennai companies with 50–200 employees and HR or People Operations managers. Cap saved results at 5. Show the editable review card only; do not run the search, contact leads, or change the approved ICP.” While processing, the screenshot showed a full-height chat and composer fixed at the bottom, not the original short-scroll collapse. Waiting for the actual review result before marking J04 passed. No provider search or outreach approved.

### J04 result — passed, including follow-up correction

Marcus completed `Generate Lead Inputs` and opened Lead Inputs with one LinkedIn Company Employee Extraction strategy, saved-result cap 5, Chennai, the four HR/People Operations roles, and provider company-size bucket `51-200`. This is the provider's available bucket, not proof of an exact lower bound of 50. Separate Approve & Run Search remained untouched.

At 16:45, asked to change only the pending search to Hyderabad and cap 3, retaining strategy/size/roles and leaving the approved ICP alone. The updated editable card shows Hyderabad, maxItems 3, and the same roles/size/strategy. Opening ICP Profile confirmed Chennai, original company-size 50–200 and original objective remained unchanged. Both turns completed without running a search.

### J05 new defect — read-only specialist side question blocked by another agent's review

At 16:46 sent: “Leave the search review unapproved and keep recipients empty. Emily, for this campaign only, can we currently send email or WhatsApp, and what exact prerequisite is missing? Answer only. Do not select or import account leads, prepare a send review, run the search, or send anything.”

Actual: Coordinator refused to switch until the unfinished search review was finished or cancelled. No readiness lookup/answer occurred. The router applied the mutating-handoff gate to semantic read-only questions.

Local correction: question routing may dispatch a specialist without transferring pending-review ownership. `runAndMergeSpecialistTurn` gives that side turn an isolated state copy and accepts only answer/receipt fields back; pending approval, owner, pipeline/index, settings, recipients and action buttons remain unchanged even if specialist hooks mutate their input or return default cleared fields. BaseAgent already restricts question tools to reads and now suppresses unrelated execution action buttons on normal question responses. Forced hires and mutating cross-agent requests remain gated. The search was deliberately kept unapproved for the eventual exact live retest.

Validation: **141 tests / 8 suites passed**, including all five specialist targets, mutating-handoff rejection and two consecutive actual Emily-agent turns with empty recipients. **10/10 live-model synthetic intent cases passed**, including the exact pending-search prompt classified as `question` → `outreach`. These model checks do not dispatch tools or prove a live deployed readiness answer. Server typecheck passed after raising the Node heap limit; the first attempt exhausted the default 2 GB heap, and intermediate fixture type errors were corrected before the passing run. `git diff --check` passed. This patch is not in deployed SHA `6e3ab736`.

### Chooser and navigation post-release observations

The composer **Choose agent** button immediately opens Agents with Marcus, Alex, Emily and Sarah and their Start controls; no Start was submitted. Campaign 210→205 navigation again showed empty content, then a full-page spinner with an AbortError logged from the conversation bundle. This time it eventually recovered without refresh and rendered 205's own history. Returning to 210 also restored the proper transcript and tabs without refresh (observed by the next check, about 24 seconds after click; not an exact load-time measurement). Thus data retention/recovery is observed, but latency/blank-state acceptance is still open. Request-level diagnosis is ongoing; no speculative navigation fix has been made.

### J09 bounded navigation correction — duplicate route request

Instrumented one additional sidebar navigation using Chrome's supported network diagnostics, collecting only URL paths, status, request IDs and timings, not headers or response payloads. This run succeeded: campaign metadata/tabs/messages/ICP/widget requests returned HTTP 200 within about 1.5 seconds of the first route request. It also showed **two consecutive Next route fetches for `/dashboard/conversations/205`**. Source inspection confirmed `handleThreadSelect` (called only by the URL effect and same-thread Retry) unconditionally called `router.push` for that already-selected URL while restoring its state.

Removed the redundant `router.push`; URL selection stays owned by the sidebar/router, and retries only reload data. Added a regression executing the actual page handler for 210→205→210, asserting no duplicate navigation and correct state reset/history restoration. **38 tests / 4 client suites passed**, client typecheck and diff check passed. Next.js guidance informed keeping navigation ownership separate from data loading. This is a confirmed redundant-navigation fix, **not proof that every earlier AbortError or intermittent full-page spinner has the same cause**. The bounded patch still needs release and Chrome verification. No authentication protections or error handling were weakened.
