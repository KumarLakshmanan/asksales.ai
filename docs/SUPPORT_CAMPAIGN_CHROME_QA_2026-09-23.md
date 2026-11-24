# Support AI and campaign conversations — Chrome QA

## Production release — 2026-09-23

The user explicitly authorized committing and deploying after the comparison below. Its statements that fixes were local-only describe the earlier test window, not this release.

- Application commit: `8ac9192f629f7b4c8ba0866550ad9fc0d29a2144`, pushed to `origin/v7`; 96 related files. Local QA launchers, copied data, environment files and credentials are excluded.
- Pre-release checks: **33 server suites / 581 tests** and **18 frontend suites / 194 tests** passed; server/client TypeScript checks, server API/worker builds and staged whitespace checks passed. These are selected regression suites, not the entire repository test suite.
- Production source synchronized by fast-forward from `21292f84de718c0ea19592cbca80433ee42ee445`. The SSH Git-bundle fallback was used because the server could not authenticate to GitHub. Previously merged upload/template fixes were included and their regression tests passed.
- Verified PostgreSQL backup: `/var/backups/asksales/predeploy-20260923T064245Z.dump`. The deployment retains the pre-release runtime images under `asksales-rollback-<service>:latest`.
- **Release completed successfully** through the canonical Docker/SSH procedure at approximately 12:27 IST. All five images built, frontend production compilation/TypeScript/264-page generation passed, migration **291** applied (batch 109), and Nginx configuration validation/reload passed.
- API, client and Hermes health endpoints returned **200**; public website and `/api/health` returned **200**. All five runtime containers were running with zero restarts. Production source was clean at the application commit above.
- The standard CRM identity reconciliation reported 602 candidates, 600 reconciled and 2 skipped; ambiguous identities were left for owner review. The standard cleanup removed only dangling Docker images/rebuildable artifacts (63.69 KB reported), retaining rollback image tags; no application data was deleted.

### Post-deployment Chrome smoke test

Signed-in Oro Circle account, production pages explicitly reloaded to load the deployed frontend. These are new real-model tests, not reuse of the earlier local results. **Infrastructure deployment passes; conversation functionality is not fully signed off.**

| Case | Result and evidence |
| --- | --- |
| Two-turn Support advice / Email format | Pass for facts/context/formatting. S1 below with `Deployment QA Sep 23` prefix returns the ORO identity, 2 PM check-in, 11 AM check-out and four sources. Follow-up in Email mode: “Please turn those two timings into a short customer email with a bold heading and two numbered items. Preserve only the verified facts. Draft only; do not send.” The result retains both times and identity with a rendered bold heading, numbered items and four sources; no email was sent. |
| Support viewport/source expansion/composer focus | Pass. The new `Support messages` viewport remained at top **125.10 px**, height **644.81 px**, with both clipped ancestors at scrollTop **0** after expanding four sources and focusing the composer. No DOM/CSS workaround was injected. |
| Ordinary-word redaction / source-free badge | Pass in this sample. “planning” and “still only” remain intact. Source-free failure replies correctly show **No source evidence**, not High grounding. |
| Corporate preview start | Partial/fail for intended progression. Same P1 prompt below, with `Deployment QA Sep 23 preview` prefix, returned a generic service menu plus a room-rate excerpt, not the expected company-name intake. Logs show accepted corporate/information intent (confidence 0.92); the precise downstream routing cause was not established. |
| Spa switch | Fail, including one exact retry of P2 below. UI returned “I’m having trouble completing that request right now.” Logs show Jev/full-model accepted spa/information, explicit=true, topicSwitch=true (confidence 0.91). Both turns then failed the outbound guardrail: **“Complete published information and its terms cannot fit the configured response limit.”** Preview conversation `-1000000079`. This observed failure is downstream answer-length/qualification handling, not a classifier outage. P3/P4 correction checks were not continued through a failed prerequisite. Do not remove published qualifications or bypass the guardrail to make this pass. |
| Campaign ICP label | Pass. Reloaded campaign 208 displays **Completeness: 69%**, **ICP completeness**, and the clarification that it is not predicted campaign performance. |
| Outreach read-only explanation | Fail, same C4 question below with deployment prefix. Emily still reports it could not verify action claims and notes an existing saved review. No useful explanation or new executed action. Exact semantic audit cause remains unresolved; prior review #131 was left untouched. |

Bounded post-release server logs also show Gmail webhook ownership-ambiguity errors (HTTP 409). This is a separate operational finding; no account ownership was changed and no causal relationship to this release was established. The remaining approval-status/content/external execution limitations in the comparison below remain open. No live outreach, booking, publication or spend was authorized by these smoke tests.

## Latest paired Chrome comparison — 2026-09-23, approximately 11:52–12:02 IST

**Verdict: localhost performed better functionally in this paired sample, but neither environment is fully signed off.** Basic Support knowledge/formatting and lead catalogs passed on both. Local handled service switching/correction, Outreach explanation and scoped analytics better. Production still reproduced the Support scroll and over-redaction issues. Content generation and external execution remain unverified; there is also a shared approval-status completeness gap.

### Method and scope

- Google Chrome Personal; both sites visibly authenticated as **Oro Circle**. No Codex in-app browser used. The named Chrome skill was not available; used the testing skill with direct Chrome controls because `runTest` was unavailable.
- **30 new messages total:** identical five-turn Support advice sequence, four-turn customer preview, and six-turn campaign sequence in each environment. No scripted mock responses used for these browser checks. No chat retry was needed in this comparison pass.
- Localhost used the restored production snapshot, current uncommitted fixes, local QA DB, and isolated model-only egress. Production remained its deployed version. Local Support advice/preview sessions were **83 / 84**. Campaign **208**, “ORO Circle Boutique Hotel Partnerships Bengaluru,” existed in both from the snapshot and was used without approving or editing its ICP.
- The local QA launcher was opted into campaign chat plus campaign-208 result-tab display persistence. Approvals/action endpoints, other writes, cron, delivery workers and external integration traffic remain blocked. Support AI model calls and ordinary campaign chat messages still consume upstream model credits.
- After comparison, restarted the isolated API without the campaign-chat opt-in. Its default Support-only mutation guard is restored; saved campaign results remain readable. This temporary test guard is not an application failure if a later local campaign POST returns its explicit QA-disabled message.
- Normal test side effects: saved internal messages in both environments, a local persisted Analytics result tab, and production's unexecuted **Query Analytics review #131**. That review was not confirmed, cancelled or deleted. No customer outreach, publication, booking, provider sync or ad spend was intentionally requested or authorized. No deployment or production configuration change.
- This is a functional comparison, **not a speed/load benchmark**. No comparable request-duration capture was collected in this pass. Same account and copied knowledge improve fairness, but model routing/fallback, development versus production builds, window sizes, data recency, and generated review state differ.

### Support advice: matched five-turn sequence

| ID / channel | Exact prompt | Localhost | AskSales.ai |
| --- | --- | --- | --- |
| S1 / Web | Paired Chrome QA Sep 23: Using only approved knowledge, what are the published check-in and check-out times for ORO The Estate? Name the property and preserve qualifications. Do not guess. | Pass: ORO The Estate, 2 PM / 11 AM, four sources. | Pass: published timings and ORO identity footer, four sources. |
| S2 / WhatsApp | Please turn those two timings into a numbered list with a bold heading. Keep the same facts and qualifications. Draft only; do not send. | Pass: bold heading, two numbered items, four sources. | Pass: same facts and requested structure, four sources. |
| S3 / Instagram | Different question: what is the published moon-shuttle departure schedule for the year 2035? If no approved source exists, say that clearly. Do not invent a timetable. | Pass: safe refusal, zero sources, No source evidence. | Pass: safe refusal, zero sources, Review suggested. |
| S4 / Email | Return to the check-in and check-out times from earlier. Draft a short customer email with a bold heading and two numbered items. Preserve only verified facts; if none were verified, say so. Draft only; do not send. | Pass: rendered bold heading, numbered 2 PM / 11 AM, five sources. | **Pass this time:** same rendered structure/facts, five sources. Earlier production false refusal did not recur; do not report it as a new failure. |
| S5 / Facebook | What are the published day-out hours, is GST included in the package prices, and are spa services included? Keep all published qualifications. If a fact is not in approved knowledge, identify that gap without guessing. | Pass: 10 AM–6 PM unless day-use room; GST extra/per person; spa separately charged with privilege discount; terms preserved. Four sources; verbose package excerpt. | Pass: same required facts and qualifications, four sources. Also verbose, with less context for the extra package prices. |

**Support scroll: local passes, production fails.** After S5, expanded the last source tray and focused the composer. Local native viewport: top **125.17 px**, height **706.96 px**, clipped parent scrollTop **0**. Production scroll viewport: top **−116.53 px**, height **596.83 px**; overflow-hidden parent at top **125.10 px** had scrollTop **265.625 px**. This is displaced/clipped content, not merely different screen sizes. No DOM/CSS workaround was injected.

### Customer preview: matched four-turn sequence

| ID | Exact prompt | Localhost | AskSales.ai |
| --- | --- | --- | --- |
| P1 | Paired Chrome QA Sep 23 preview: I am planning a corporate offsite for 20 people. This is still only a preview. Please help me explore the options; do not make a booking or send any customer messages. | Pass for initial progression: asks company name; ordinary words intact; No source evidence badge. | Partial: asks company name but replaces “planning” and “still only” with NAME tokens; incorrectly shows High grounding with zero sources. |
| P2 | Actually, forget the corporate event. Please help me explore a spa appointment instead. This is still only a preview; do not book anything. | Pass: asks preferred date/time, leaving corporate intake. | Fail: long spa/facilities answer followed by “What is the company name?” Wrong journey remains active; over-redaction repeats. |
| P3 | September 30, 2026 at 3 PM. Do not create a real booking; this is a test preview. | Pass: collects date/time and asks the next contact question. | Fail: asks attendee count, still corporate intake. |
| P4 | Correction: make the preferred time 4 PM on September 30, 2026, not 3 PM. I do not want to give contact details or confirm a booking yet. | Pass: acknowledges update, explicitly says it does not confirm a booking, allows pause without asking name. Provenance: Playbook 21 v14 / collect-service-request. | Fail: asks for preferred dates again. Provenance: Playbook 21 v14 / collect-corporate. No time-correction acknowledgement; zero-source High grounding badge remains. |

Read-only local preview inspection independently confirmed **September 30, 2026 at 4 PM**, spa topic, booking-request/consent unset, confirmed=false and simulated delivery. This establishes actual saved state, not just agreeable response wording. Production state assessment is based on visible provenance; no production database modification or direct payload inspection was performed.

### Campaign 208: six-turn agent/tool/widget sequence

| ID | Exact prompt | Localhost | AskSales.ai |
| --- | --- | --- | --- |
| C1 Coordinator | Paired Chrome QA Sep 23. Read-only status check: what is waiting for my approval in this campaign, and what has actually run? Do not approve or execute anything, edit the ICP, contact leads, schedule, or publish. | Partial: persisted execution-review status and receipt caveats returned; no invented delivery. Omits the saved ICP awaiting approval despite its visible widget. | Same partial result and omission. |
| C2 Lead | Switch to a read-only lead-generation question: list the available Yelp and Google Maps search workflows. Do not prepare or execute a search, approve the ICP, or contact leads. | Pass: Marcus, Yelp/Google Maps catalog tables and matching suggestion buttons. No search run. | Pass: same catalog and buttons. |
| C3 Lead follow-up | Switch platforms: show only the LinkedIn lead-workflow catalog now. Do not run or prepare any search. | Pass: Marcus, nine LinkedIn strategies/buttons; no stale Yelp response. | Pass: same platform switch. |
| C4 Outreach | Read-only question for Outreach: can email and WhatsApp outreach use saved campaign leads, and how are queued, sent, failed and awaiting-approval recipients shown? Explain only; do not create a campaign, draft, message, schedule, or approval. | Pass for explanation: Emily states contact/consent requirements and differentiates approval, queue, provider receipt and failure. No execution tool receipt. | Fail for answer usefulness: Emily returns “I could not verify the action claims in the drafted response,” no useful explanation. It safely avoids claiming any delivery. Both display generic Send Email / Send Instagram DM suggestion chips; chips are not executed actions and do not prove WhatsApp delivery support. |
| C5 Performance | Read-only request for Performance Marketing: show existing campaign performance analytics and its chart widget. If this QA campaign has no data, say so. Do not create, schedule, publish, sync providers, or spend anything. | Pass for tool/widget: Sarah → Query Analytics completed. Expanded receipt confirms query_type=campaign, scope=current_campaign, data=[], summary “No campaigns found for the selected filters.” Campaign Analytics tab shows Current conversation #208 and empty Spend/CTR chart states. Chat text is generic “lookup completed,” less informative than the widget. | Gated, not executed: Sarah creates Query Analytics review #131 with This conversation scope and Confirm and run. No chart result. Kept unapproved; this is not a successful analytics execution. |
| C6 Content | Switch to Content Studio: draft two short Instagram captions about ORO hospitality partnerships for my review. Copy only; do not create images, schedule, publish, contact anyone, or approve the ICP. | Blocked by saved ICP approval; no captions generated. Gate holds without a provider error. | Blocked by same ICP approval; extra explanation identifies revision 1 / Bengaluru / LinkedIn and Google Maps. No captions generated. |

**Campaign UI:** minimize/restore result panel passed on both. Real scroll viewport remained at top approximately **143.6 px**, height **709 px local / 651.4 px live**, with clipped ancestors at scrollTop 0. The large negative content-list position is normal scrolling and must not be confused with the negative Support *viewport* above. Reload preserved campaign messages and result views; local Analytics tab and empty-state charts survived reload. Production retains the unexecuted review and ICP view. Local ICP widget labels 69% as **completeness**, explicitly not predicted performance; production still says **Fit Score / targeting accuracy**, a misleading interpretation of the same completeness value.

### Findings still requiring work or explicit execution scope

1. Production: fix Support viewport ancestor scrolling, ordinary-word over-redaction, zero-source High grounding, and corporate→spa state/correction behavior. Local fixes were not deployed.
2. Production Outreach: investigate the false action-claim verification block on a read-only explanatory question. Current evidence does not attribute it to Jev specifically.
3. Both: approval-status response should enumerate pending ICP approval separately from execution review cards. C6 independently confirms the prerequisite omitted in C1.
4. Decide whether read-only campaign analytics should require confirmation in production; until approved, its chart execution is unverified. Local completed the scoped read-only lookup with an honest empty state; populated charts were not exercised.
5. Content draft generation, ICP creation/editing, live scraping, recipient selection/delivery, scheduling, publishing, real bookings, attachments and human handoff were **not** certified by this pass. Do not count catalog explanations, review cards or empty charts as end-to-end external execution success.

No application fix was implemented in this comparison turn; changes were to the local QA launcher/helper and this report only. Earlier automated test totals below belong to the remediation pass, not 466 newly rerun tests here. Local logs contained recovered no-visible-output provider fallbacks; browser answers ultimately completed. The final browser log sample had one local Support WebSocket reconnection warning around the deliberate QA API restart; the other three tabs had no captured warnings/errors. Application-level failures can still arrive as ordinary assistant replies, so a clean console is not a pass. No conclusion about pure Jev quality or comparative speed follows from this small routed-model sample.

## Local remediation and regression verification — 2026-09-23

This section supersedes the **local** failures recorded in the restored-snapshot run only where a retest is explicitly marked passed. Historical production observations remain unchanged. No deployment or production modification occurred. Tests used the isolated restored database, Oro Circle account, real configured models, and Google Chrome; no booking, customer delivery, publication or campaign execution was authorized.

### Changes and reasoning

- **Knowledge recovery:** low-risk, tool-free owner-advisory answers can recover from verified published excerpts regardless of the coarse intent label. Recovery still enforces authorized evidence and factual verification; it does not bypass verification or authorize tools. This fixes the false Email refusal when a formatting request was classified as a support request.
- **Compound answers:** preserve paragraph boundaries between exact evidence blocks so the output guardrail can split long answers without deleting qualifications. Explicit channel presentation is reverified. This fixes the day-out/GST/spa answer's former generic error.
- **Extractive completeness:** eligible property-identity headings can accompany substantive facts; a heading alone remains insufficient. The selection prompt excludes unrelated following-section headings. This is general evidence selection, not a hard-coded property answer.
- **Formatting:** repeated published-quote presentation is idempotent. Bold headings are no longer parsed as `*` bullets, preventing malformed Email headings after recovery and final channel formatting both run.
- **Semantic journeys:** an explicit, confident exploratory spa topic switch can replace an active corporate journey without setting booking intent or carrying forward callback consent. Initial service-menu information selection still follows its published information branch.
- **Corrections:** a confident, explicit correction with a canonical extracted `service.dateTime` replaces the collected value even without a field-label phrase or a spa-specific service label. Correcting a service time before identity collection acknowledges the change and allows a pause instead of repeating the name question. It does not confirm a booking.
- **Scroll containment:** owner and member Support chat use `overflow-clip` on non-scrolling ancestors and `focus({ preventScroll: true })` on the composer. The native message viewport remains the scroll owner. The React review skill guided containment/focus changes; the testing skill guided the multi-turn checks.
- **Diagnostics:** accepted NLU logs include bounded semantic decision enums, not raw customer messages or extracted contact fields. This distinguished Jev uncertainty/full-model fallback from downstream playbook mistakes.

### Real Chrome cases

Local advice session **79**, preview session **80**, plus fresh `Regression fixes final QA Sep 23` advice. A1–A6 and P1–P4 use the exact prompts below with the `Regression fixes QA Sep 23` label. These are actual UI/model calls, not mocks. Channels are previews, not deliveries.

| Case | Latest observation | Result / reasoning |
| --- | --- | --- |
| A1 property + timings | Fresh final retest includes the published identity heading “ORO Resort – Property & Sales Information”, 2 PM / 11 AM, four sources, no unrelated room heading. | Pass for published identity/facts; uses the source's ORO Resort label, not a rewritten canonical property name. |
| A2 named property | ORO The Estate, 2 PM / 11 AM, four sources. | Pass; retains published qualifications. |
| A3 WhatsApp format | Bold heading and two numbered timing items, four sources. | Pass; facts retained. |
| A4 unsupported moon schedule | Refusal, zero sources, No source evidence. | Pass; no invented timetable. |
| A5 return to timings / Email | Initial recovery exposed malformed bold markup; after idempotence fix Chrome shows a bold Check-In / Check-Out Timings heading, numbered 2 PM / 11 AM, four sources. | Pass after both fixes. An extra Facebook preview of the same draft also returned the facts; not counted as Email verification. |
| A6 compound policies / Facebook | Published 10 AM–6 PM with day-use qualification; per-person GST extra; spa separately chargeable with privilege discount; remaining terms preserved, four sources. | Pass for factual recovery/no generic error. Still verbose, including additional package details. |
| P1 corporate | Asks company name; ordinary words are not redacted. | Pass for initial progression only. |
| P2 exploratory spa switch | Asks preferred date/time instead of company name. Real NLU records information/spa/explicit/topicSwitch. | Pass; no booking authorization inferred. |
| P3 date/time | Accepts September 30, 2026 at 3 PM and asks the next contact question. | Pass; no stale corporate attendee/date question. |
| P4 correction | First correction persisted 4 PM, but repeated name request despite refusal. A subsequent 5 PM correction revealed service=`general`, while the canonical time slot was still correct. After both fixes and transient timeouts, final retry says the preferred date/time is updated, explicitly does not confirm a booking, and allows the user to pause. | **Pass on final retry:** read-only saved preview contains September 30, 2026 at 4 PM, spa topic, missing booking intent/consent and confirmed=false. No name question. Earlier failed attempts remain recorded. |

Read-only inspection of the encrypted local preview (only selected non-contact fields printed) confirmed spa topic, final collected September 30, 2026 at 4 PM, missing booking-request/consent fields, unconfirmed status and simulated delivery. The final corrected collect node is `collect-service-request`, the published service-collection destination. No decrypted payload or credentials are included here.

**Scroll:** after six advice turns and expanding the four-source tray, viewport top **125.17 px**, height **706.96 px**, inner scrollTop **2186 px**; both clipped ancestors had scrollTop **0**. The earlier failure had a negative viewport top and a scrolled hidden parent. This interaction now passes in Chrome. Member chat receives the same containment fix but was not separately signed in/browser-tested.

After the final preview response, refreshed and reopened session 80: all **16 message items** (including the two failed provider attempts and successful retry) survived. The corrected acknowledgement remained visible, viewport top **125.17 px**, height **706.96 px**, parent scrollTop **0**. The test result is left open in Chrome.

**Transient provider failure:** two final P4 attempts stopped before playbook execution when Jev's request expired and the full-model NLU request also timed out. Both returned a safe source-free error; read-only state remained at the preceding 5 PM preference, with no consent/confirmation. A later fresh advice request and final P4 retry completed successfully. Public model-catalog reachability returned HTTP 200, but that alone does not establish completion-endpoint availability. These genuine failed attempts are retained, not counted as application passes or hidden by successful unit tests. No configuration/balance change was made to force recovery; upstream availability remains an operational dependency.

### Automated regression coverage

- **Server: 22 suites / 436 tests passed.** Ten support/knowledge/runtime suites: 299 tests; twelve classifier/provider suites: 137 tests.
- **Frontend: 4 suites / 30 tests passed.** Viewport behavior, channel formatting/focus containment, session isolation and retry.
- Server/client type checks passed; focused implementation lint passed. Test-fixture lint reports existing-style `any` warnings, no errors. Server typecheck/lint required a 4 GB Node heap after the default 2 GB process ran out of memory. `git diff --check` passed.
- New `client/e2e/support-chat-scroll.spec.ts` supplies a six-turn mocked browser geometry regression for source expansion and composer focus. **Authored and type-checked, not executed in the Playwright CLI this run.** Actual browser interactions were performed through the available Chrome control tools.

| Test files | Failure class protected |
| --- | --- |
| `server/tests/supportJourneyCorrectionRuntime.test.ts` | Corporate → exploratory spa, no implicit consent, initial-menu behavior, consecutive engine turns with saved state, corrected time with spa or general service labels, acknowledgement instead of name pressure. Model decisions and preview delivery are fixtures. |
| `server/tests/intentClassifierRuntime.test.ts` | Multi-turn information → continue → correction across Web, WhatsApp, Email; correct semantic contract without interpreting booking refusal as global opt-out. Model outputs mocked. |
| `server/tests/supportAdvisoryGroundingStage.test.ts` | Verified advisory recovery across coarse intent labels, including support_request, and multi-block qualification preservation. |
| `server/tests/knowledgeExtractiveAnswer.test.ts` | Property heading + substantive evidence, heading-only rejection, whole-block compound answers and formatting recovery. |
| `server/tests/supportLiveChatRegression.test.ts` | Repeated presentation preserves valid bold/list Email formatting. Despite its name, this is fixture-based, not a live model test. |
| `client/src/__tests__/supportChatChannelFormats.test.tsx` | Overflow clipping, preventScroll focus and channel-specific rendering contracts. |

Commands are the selected `pnpm test` suites above, `NODE_OPTIONS=--max-old-space-size=4096 pnpm exec tsc --noEmit` in server, `pnpm exec tsc --noEmit` in client, and focused ESLint. These checks do not certify every agent or external tool. Scheduling, publication, real deliveries and campaign mutations were intentionally blocked by the local isolation guard; prior campaign coverage remains recorded separately below.

## Live-data local restore and retest preparation — 2026-09-23

The user subsequently authorized copying production data over the saved SSH connection to remove the dataset mismatch in the comparison below. **No deployment, production database mutation, service restart, or production configuration change was performed.**

### Restore completed

- A PostgreSQL custom-format dump was streamed over SSH and restored into a separate local database, `salesmarketing_live_qa_20260923`, using PostgreSQL 17 tools. The original local `salesmarketing` database remains intact and was also backed up.
- Private snapshot directory: `/Users/lakshmananr/.codex/asksales-live-20260923.D5RaZY` (outside the repository, restricted permissions). `manifest.json` records archive SHA-256 checksums. Do not commit or share the database dumps or decryption material.
- Copied the production uploads volume (3,644 files), exports volume, and legacy uploads. Knowledge documents, versions, chunks and embeddings are included in the database dump. Database and file snapshots were captured separately, not as one cross-storage atomic snapshot.
- Read-only production/local checks matched: **289 public tables/views, 23 knowledge documents, 17 current published documents, 135 chunks**. The restored database contains 41 knowledge-document versions.
- Applied local migration `291_intent_classifier_settings.js` to support the current checkout: 274 copied migration records became 275 locally. Classifier defaults are OpenRouter / `typesafe/jev-1.13`; this is a configuration difference from the production snapshot and must be considered when interpreting results.
- Safe local verification confirmed that the copied active OpenRouter and Gemini embedding credentials decrypt. This verifies encryption compatibility, not provider availability or account balance. Copied text settings are Google / `gemini-2.5-flash`; existing fallback behavior may therefore affect runtime results.
- The first verification helper query used incorrect column names (`text_provider`, `text_model`). Corrected the helper to use the actual `ai_provider`, `ai_model` schema; rerun passed. This was a QA-helper error, not an application failure.

### Local runtime isolation

The running local API uses `.local/start-live-support-qa.ts`, binds to `127.0.0.1:8080`, and serves the existing localhost:3000 frontend. Default application environment files were not repointed. Restart this isolated API from `server` with `pnpm exec tsx ../.local/start-live-support-qa.ts` while its dedicated Redis instance is available at `127.0.0.1:6385`.

- Production Redis queues were **not** copied. The dedicated local Redis has no persistence or delivery workers.
- Cron and embedded workers are disabled; outbound integration traffic is blocked except the explicitly allowed AI-provider endpoints. SMTP delivery is blocked. AI calls can still consume real upstream provider credits.
- The local request guard allows authentication and Support AI chat POSTs; other application writes are rejected. Normal authentication and CSRF checks remain active. This setup is for Support advice and customer-journey previews, not campaign execution tests.
- Fresh local-only authentication signing material invalidated prior sessions, avoiding accidental account-ID reuse from the previous database. No production authentication signing key is used to log in locally.

### Matching-account retest completed in Chrome

The initial sign-in was a different workspace. The user subsequently signed into **Oro Circle** locally; Chrome showed the matching account before testing. No password or authentication token is included in this report. Used the testing skill's multi-turn verification approach through direct Chrome controls because its dedicated runner is unavailable.

Repeated A1–A6 and P1–P4 below against the restored data in two new local sessions. Only the initial QA label changed from `Comparison QA Sep 23` to `Restored snapshot QA Sep 23`; A2 explicitly names ORO The Estate. Channel selections format previews; they do not send messages to those channels.

| Case | Restored local result | Local POST duration | Earlier live duration |
| --- | --- | ---: | ---: |
| A1 Web timings | **Partial:** correct 2 PM / 11 AM with four sources, but omits requested property name and appends an unrelated “Premium Club Rooms” heading. Opened source tray and verified copied property evidence. | 16.003 s | Not captured |
| A2 property follow-up | **Pass:** names ORO The Estate, correct timings, four sources. | 10.259 s | Not captured |
| A3 WhatsApp formatting | **Pass:** bold heading, two numbered items, timings preserved, four sources. | 9.608 s | Not captured |
| A4 unsupported moon-shuttle schedule | **Pass:** safe refusal, zero sources, No source evidence badge. | 8.809 s | Not captured |
| A5 Email return to earlier timings | **Fail:** false refusal despite verified earlier facts. Visible provenance says Knowledge **sufficient**, Verification **blocked / unsupported_internal_factual_claim**. Same failure class as live; missing local data no longer explains it. | 13.496 s | 13.798 s |
| A6 day-out / GST / spa | **Fail:** generic “trouble completing” response despite Knowledge **sufficient**. No verification/tool details displayed that establish the cause. Live previously answered correctly. | 18.487 s | 22.720 s |
| P1 corporate preview | **Basic progression pass:** asks company name. Ordinary words “planning” and “still only” remain intact; source-free badge now honest. This does not demonstrate a complete journey. | 9.653 s | 10.083 s |
| P2 switch to spa | **Fail:** returns a large spa/facilities excerpt, then asks “What is the company name?” Visible provenance: **Playbook 21 v14, collect-corporate:knowledge-interruption**. The explicit switch is handled as a knowledge interruption instead of replacing the corporate journey. | 17.397 s | 17.369 s |
| P3 September 30 at 3 PM | **Fail:** asks how many people, continuing the wrong journey; no acknowledgement of spa/date/time. | 19.318 s | 21.713 s |
| P4 correct to 4 PM | **Fail:** asks for preferred dates despite the supplied date and time correction. Provenance still **Playbook 21 v14 / collect-corporate**. | 15.666 s | 17.671 s |

All ten local POST requests returned HTTP 200, including functional failures. Timings were measured from Chrome request start to loading-finished events; no request headers, cookies or bodies were exported. The first A5 click left the prompt in the composer; after verifying no message was submitted, clicked again. The capture contains exactly ten chat POSTs, so there was no duplicate A5 submission.

**Scroll regression reproduced locally:** after opening evidence/provenance details in the six-turn advice session, the native message viewport had height **632.29 px**, but top **−52.17 px**; its overflow-hidden parent had scrollTop **177.33 px**. Thus the previous native-viewport fix does not fully prevent ancestor scrolling. After refresh and reopening the saved advice session, all **12 message items** were present, viewport top **125.17 px**, parent scrollTop **0**. This matches the reported “during chat, refresh helps” failure pattern; persistence is not the problem. Earlier local-layout passes do not supersede this reproduced failure.

**Comparison conclusion:** restoring production data resolves the previous universal local knowledge refusals and immediate preview database errors. Local privacy redaction and source-free labels are improved, but **neither version is working end to end**. Production performed better on the compound policy answer and initial property naming in this sample; both fail Email continuity and spa journey switching/correction. Local is slightly faster in five of six paired timed cases, but errors and different answer paths make that insufficient evidence of better overall performance. This is not a controlled model benchmark: current local code, the added classifier defaults, runtime environment, and test time differ. No new live messages were submitted during this restored-data pass.

Remaining focused fixes: (1) false Email verification block; (2) generic compound-policy failure; (3) explicit topic switch and corrected-slot handling in the playbook flow; (4) overflow-hidden ancestor scrolling when evidence details receive focus; (5) extractive answer completeness/irrelevant-heading cleanup. This pass records and narrows failures; it does **not** claim to have fixed them. No deployment, actual booking, customer delivery, publication, or campaign execution occurred.

## Latest comparison: localhost vs AskSales.ai Support AI, 2026-09-23

User requested an actual comparison of `/dashboard/support-ai/chat` in both environments. Tested both in Google Chrome Personal, using a fresh Support advice session followed by a fresh **Test customer journey** session. No application code, credentials, configuration, publication state, or deployment was changed for this comparison. No actual booking, customer messaging, email delivery or ad action was authorized or requested. The chat tests themselves create saved internal messages and consume normal provider credits where generation occurs.

### Verdict and fairness limits

**AskSales.ai currently delivers more useful answers in its configured workspace; localhost has the better chat layout and more truthful source-free badges. Neither is cleanly working end to end.** This does not establish that production's underlying code or model is superior: the authenticated workspaces, published knowledge, runtime configuration and development/production builds differ.

- Localhost: Lakshmanan R workspace, current local checkout. Six advice turns returned safe insufficient-information refusals; all four journey-preview turns returned a generic error. A read-only local database check found the two user-1 governed test documents (including Harbour Test Lodge) have **no current published version**. Do not count lack of eligible knowledge as proof of inferior answer generation. Preview logs independently show `ChannelGateway` failing with a `DrizzleQueryError`; the sanitized logs do not establish the exact SQL cause. No migration or data publication was performed.
- AskSales.ai: Oro Circle workspace. Four of five answer/formatting requests produced useful source-backed responses; the deliberately unsupported question was safely refused. Email reuse of earlier verified facts failed. The corporate opening progressed, but a requested switch to spa errored and later resumed **collect-corporate**, verified in the visible provenance panel. Production also still corrupts ordinary words through name redaction and displays High grounding on a generic source-free journey error.
- This is a small functional sample, not a load test, controlled model benchmark, or all-agent sign-off. No aggregate pass percentage merges local knowledge-availability blocks with genuine application failures.

### Exact six-turn Support advice sequence

The first prompt begins `Comparison QA Sep 23:`; saved history title begins **Comparison QA Sep 23: Using only approved knowledge, what ar** in both environments. Only A2 substitutes the property name present in that environment's history/knowledge. Other prompts are identical.

| ID / channel | Prompt | Localhost | AskSales.ai |
| --- | --- | --- | --- |
| A1 / Web | Comparison QA Sep 23: Using only approved knowledge, what are the published check-in and check-out times for the property you support? Name the property and cite your sources. Do not guess if these facts are missing. | Safe refusal; 0 sources / No source evidence. | 2 PM / 11 AM, identifies ORO The Estate, 4 sources. Source tray opened and checked. |
| A2 / Web | For [Harbour Test Lodge / ORO The Estate], what are the published check-in and check-out times? Use only approved knowledge and preserve qualifications. | Safe refusal; local fixture has no current published version. | Correct 2 PM / 11 AM, 4 sources. |
| A3 / WhatsApp | Please turn those two timings into a numbered list with a bold heading. Keep the same facts; if you could not verify them, say so instead of inventing them. | Safe refusal; cannot demonstrate fact-preserving formatting without verified facts. | Bold heading and two numbered timings; 4 sources; prior Web replies retain their formatting. |
| A4 / Instagram | Different question: what is the published moon-shuttle departure schedule for the year 2035? If no approved source exists, say that clearly. Do not invent a timetable. | Correct safe refusal; No source evidence badge. | Correct safe refusal; Review suggested badge. No invented schedule. |
| A5 / Email | Return to the check-in and check-out times from earlier. Draft a short customer email with a bold heading and two numbered items. Preserve only verified facts; if none were verified, say so. Draft only; do not send. | Safe refusal, consistent with no verified earlier facts. | **Failed:** refuses despite A1–A3 verified facts. Visible provenance: Knowledge **sufficient**, Verification **blocked / unsupported_internal_factual_claim**. This narrows the failure to answer verification, not simply absent knowledge. |
| A6 / Facebook | What are the published day-out hours, is GST included in the package prices, and are spa services included? Keep all published qualifications. If a fact is not in approved knowledge, identify that gap without guessing. | Safe refusal; Knowledge insufficient, tool `answer_from_knowledge_base (failed)`, verification blocked. | Correct published excerpt: 10 AM–6 PM unless day-use room; GST extra, per person; spa charged separately with privilege discount. Includes other published qualifications. Four sources. |

### Customer-journey preview sequence

Both pages visibly state **Preview only. No customer messages or booking changes are sent.** No real contact details or booking confirmation were supplied. Saved preview title begins **Comparison QA Sep 23 preview:**.

| ID | Identical prompt | Localhost | AskSales.ai |
| --- | --- | --- | --- |
| P1 | Comparison QA Sep 23 preview: I am planning a corporate offsite for 20 people. This is still only a preview. Please help me explore the options; do not make a booking or send any customer messages. | **Error:** trouble generating response. Ordinary words preserved; No source evidence badge. | Asks company name, but wrongly replaces **planning** and **still only** with NAME placeholders. Source-free High grounding badge. Partial progression, not a clean pass. |
| P2 | Actually, forget the corporate event. Please help me explore a spa appointment instead. This is still only a preview; do not book anything. | **Error:** same generic generation message. Words preserved. | **Error:** trouble completing request. Wrong NAME replacement persists; **0 knowledge sources High grounding** on the error. |
| P3 | September 30, 2026 at 3 PM. Do not create a real booking; this is a test preview. | **Error:** same generic message. | Asks how many people, but provenance shows **Playbook 21 v14 / collect-corporate**, despite P2 switching to spa. Wrong journey remains active. |
| P4 | Correction: make the preferred time 4 PM on September 30, 2026, not 3 PM. I do not want to give contact details or confirm a booking yet. | **Error:** same generic message. | **Failed correction:** asks “Could you share your preferred date or dates?” despite the explicit date in P3 and P4; does not acknowledge the corrected 4 PM time. High grounding with 0 sources persists. |

### Chat UI and persistence

- **Localhost passes the observed scroll-layout check:** after six replies, native `Support messages` viewport remains at top 125 px with 632 px usable height; outer clipped ancestors have scrollTop 0. Latest messages and composer remain visible. After reload/reopen, viewport still at top 125 px, height 632 px.
- **Production fails:** after several replies, a nominal 527 px inner viewport moves to top **−263 px** because its overflow-hidden parent has scrollTop **412.5 px**. After reload/reopen it moves to **−402 px**, parent scrollTop **550.6 px**; screenshot shows a blank message area while all message text remains in the DOM. This is clipping, not lost messages. Refresh alone did not repair this session.
- Browser windows had their existing sizes (local 1920×924; live 1800×866). The issue is the negative viewport position and scrolled hidden ancestor, not merely the difference in window size. No viewport override was applied.
- Both save all six advice prompts and replies. Refresh initially shows the new-chat screen; reopening the named history entry restores messages and channel state. Conversation selection is not restored automatically by reload on either site.
- Source/provenance panels operate on both sites. Local source-free error/refusal badges do not claim High grounding; production preview errors still do.

### Measured speed, not a winner by itself

Timing is Chrome network `requestWillBeSent → loadingFinished` for the actual POST `/api/support/ai/chat`, not manually observed wall-clock polling. Request headers, cookies and bodies were not exported. Earlier A1–A4 samples were not accurately timed and are excluded. All captured chat requests returned HTTP 200, including application-level errors; HTTP success alone is not a functional pass.

| Case | Localhost | AskSales.ai | Interpretation |
| --- | ---: | ---: | --- |
| A5 Email follow-up | 6.676 s | 13.798 s | Both refused; production refusal is inappropriate given earlier verified facts. |
| A6 compound policy | 10.801 s | 22.720 s | Local refusal vs useful production answer; not equivalent work. |
| P1 corporate preview | 0.085 s | 10.083 s | Local immediate error vs partial production progression. |
| P2 spa switch | 0.091 s | 17.369 s | Both errors. |
| P3 date/time | 0.079 s | 21.713 s | Local error vs production wrong-journey continuation. |
| P4 correction | 0.074 s | 17.671 s | Local error vs production asking again for an already supplied date. |

### Priority findings from this comparison

1. **Local preview runtime:** investigate the confirmed database-query failure before judging agent/model quality. Re-test after a separately authorized fix; do not mask it as provider trouble.
2. **Local knowledge parity:** use an approved, published test knowledge set before claiming the local answer-quality changes beat production. Do not silently publish withdrawn fixtures or copy production data.
3. **Production UI:** the previously fixed-local viewport, privacy false positives and source-free badge issues are still reproducible live. No deployment was authorized or performed.
4. **Production intent and verification:** spa topic switch did not take effect; an Email follow-up was blocked despite sufficient knowledge. Both need focused regression tests and a controlled parity retest.

This comparison submitted **20 messages total: 10 per environment**. It made no application code changes. It updates this report and leaves four internal QA sessions (advice + preview in each environment). Nothing was deployed, sent to customers, booked, published, or purchased.

Date: 2026-09-23. Initial target: current local checkout, frontend http://localhost:3000 and API http://localhost:8080. Initial browser: Google Chrome, asksales.ai profile. After the user signed in, the authenticated target was **https://asksales.ai**, Google Chrome Personal profile, Oro Circle workspace, `🧪 Live Support & Campaign QA` session. The user was told about this environment difference before live tests.

## Local remediation follow-up — no deployment

### Authenticated local conversation retest — September 23, 09:19 onward

The local sign-in blocker described later in this report is now resolved. Tested in **Google Chrome Personal**, `http://localhost:3000/dashboard/conversations/226`, **Codex QA Demo Co. Revenue Analytics Outreach**. This is not the production Oro Circle campaign 208. The exact legacy “AI service could not process it” sentence is absent from the current local application source; historical messages and undeployed production code are not rewritten by these changes.

| Case | Actual result and reasoning |
| --- | --- |
| 09:19 Emily: `@emily Read-only QA: explain whether email and WhatsApp outreach can use saved campaign leads, and distinguish queued, sent, failed and awaiting-approval recipients. Explain only; do not create, send, schedule or approve anything.` | Answer returned at 09:20, with saved-lead usage and status explanations; no new outreach review or send. Live logs showed an intent-model attempt falling back successfully to configured OpenRouter Claude Sonnet 4.6; specialist generation succeeded. This verifies answer generation/fallback, not actual delivery transitions. |
| 09:20 Sarah: `@sarah Read-only QA: show this campaign’s saved performance analytics and chart widget, using only its saved conversation association. If there are no associated results, say so. Do not sync providers, change reviews, create ads, publish, schedule or spend.` | **Failed:** generated analytics approval review **77**, not results. Cause: the tool loop treated every widget-backed tool as review creation, even the read-only analytics tool. Fixed narrowly: an unambiguous semantic `question` may execute `analytics_query` directly. Other widget-backed actions remain gated. Review 77 was not approved, deleted or modified. |
| 09:21 Alex: `@alex Read-only QA follow-up: list saved social posts linked to this conversation only. If none exist, say so. Do not generate content, create a review, schedule, publish or modify anything.` | **Passed lookup:** `query_content_assets` completed; no saved posts linked to conversation 226. Distinguished old unexecuted reviews from saved assets. No new review/schedule/publication. |
| 09:25 Sarah retest | **Failed routing:** returned review-status ledger instead of analytics. Tightened both the main router and Jev classification questions: performance metrics/charts are not execution/approval status; negated safety constraints do not change the requested information. No regex intent matching added. |
| 09:27 and 09:29 identical Sarah retests | Routed to Sarah, but **failed evidence check**: model claimed a fresh lookup without calling a tool; the grounding guard correctly replaced that claim. Clarified the read-only tool contract and added one bounded evidence-correction attempt before any tool has run. It does not force execution for explanation-only questions, replay writes, or disable grounding. |
| 09:31 identical Sarah retest after correction | **Passed:** `Query Analytics completed`; Sarah reports current conversation 226 has no saved performance data. **Campaign Analytics** result tab opens with `Current conversation #226`, **Spend by Campaign** and **CTR by Campaign** empty-data regions. Response, completed tool receipt and selected result tab survive Chrome reload. No new review card; old review 77 remains unchanged. No provider sync, publishing, scheduling or spend. |

Exact repeated Sarah retest prompt:

> @sarah Read-only QA retest: show this campaign’s saved performance analytics and chart widget, scoped only to this conversation. If there are no associated results, say so. Do not sync providers, change or create reviews, create ads, publish, schedule or spend.

Current targeted regression run: **11 suites / 143 tests passed**. Includes provider completion/fallback/error safety, OpenRouter affordable-budget handling, semantic router/Jev runtime, analytics conversation scope/insights and the tool loop. New cases cover direct read-only analytics, semantic scope overriding proposed account-wide scope, ambiguous/preparation requests retaining review behavior, ad generation remaining gated, and the single correction attempt with or without a subsequent read. These mocked tests do not prove live classifier accuracy; Chrome results above are tracked separately. No deployment, remote restart, provider-setting change, actual outreach, publication, scheduling or spend occurred. Normal model calls consume existing application/provider credits.

Server TypeScript passes; focused lint has zero errors (33 pre-existing test-mock `any` warnings); `git diff --check` passes. Removed an unused import from the touched test. This pass does not retest authenticated Support AI customer journeys, populated charts or actual outbound delivery. The upstream account balance issue recorded for production still requires an administrator if that provider has no affordable capacity; code cannot supply credits. None of the seven submitted local QA turns returned the quoted legacy generic provider error. Intermediate routing/evidence failures are retained above, not counted as passes.

The user clarified that “do not import” means **do not deploy the application to the server**. All remediation below is local. Production behavior and the historical live failures below have not been retested after deployment, because no deployment is authorized.

### Implemented and verified locally

| Issue | Change and reasoning | Verification |
| --- | --- | --- |
| Support chat blank/clipped viewport | Owner and member support share one native `ChatMessageViewport`; direct viewport scrolling replaces `scrollIntoView`, which moved clipped ancestors. Preserve manual history position; follow new sends, asynchronously loaded history, and content growth. Ignore layout-generated scroll events until resize pinning completes. | 12 viewport/evidence regression cases; Chrome synthetic component fixture at localhost passed append, 420px-wide pane, manual history scroll and reopen. Viewport height remained ~811px, top ~57px; parent/document scroll stayed 0; bottom offset within 1px after following. Real browser testing exposed a resize-anchoring issue that was then fixed and retested. |
| Misleading grounding badge | Source-free replies no longer claim High grounding. Invalid confidence does not yield a success badge; member chat also requires source evidence. | Source-free confidence 0/0.9/1/NaN and invalid confidence with evidence covered. |
| Misleading ICP score terminology | Overview and ICP panels label the score completeness, not fit/targeting accuracy or predicted performance. | Frontend typecheck and focused lint; no scoring algorithm changed. |
| Saved ICP gate followed by unnecessary model failure | A complete saved but unapproved revision produces one deterministic review message with exact-revision approval buttons. Preserve the specialist/pipeline request; do not regenerate the ICP merely to ask for approval. | 44 router/continuation/approval tests passed, including forced target, semantic single/multiple specialists, explicit handoff, stale revision, and read-only bypass. No publication/outreach authorization granted. |
| Privacy redaction corrupts intent text | Exclude the observed ordinary words `planning` and `still` from conversational-prefix name matches. Keep actual explicit personal names protected; do not turn false placeholders into downstream contact-name fields. | Exact P1/P2 sentences preserved, explicit names redacted, contact collection remains missing rather than fabricating a name. Included in 207 server support/workflow/semantic regression tests below. |
| Provider failures / generic repeated retry advice | OpenRouter retries once only for a 402 with a positive affordable cap matching the actual bounded request, with 10% headroom. Other provider failures use existing bounded configured-provider fallback. Empty/whitespace or reasoning-only completions and empty streams are failures. Safe categories/status replace raw upstream errors in the touched provider/agent paths. ICP and specialists show actionable billing/rate-limit guidance, and ICP failure is explicitly marked failed, not completed. | Five focused provider/call-site suites: 47 tests passed; integration rerun including privacy and Jev Decisions transport: 7 suites / 87 passed. Credit-related 429 retains its category after sanitization. No live provider call, credit purchase, credential or admin-setting change. |
| S4 formatted earlier facts / S7 compound terms falsely refused | Keep up to eight privacy-processed history turns and resolve the matching prior user topic, not just the intervening pricing question. Normalize narrow factual equivalents while retaining number/negation checks. Remove numbered-list/HTML presentation before claim verification. During provider failure, select only complete published quotes covering every factual clause; reject duplicate/conflicting matches and ignore content from failed provider responses. Revalidate access/publication and formatted facts before returning. Business names must be grounded in the source text/title, never a hardcoded business-name exception. | S4/S7 regression cases passed, including intervening topic, GST/spa exclusion contradictions, unsupported subquestion, duplicate/contradictory evidence, source withdrawal, and two different business-name provenance cases. Final focused knowledge run: 5 suites / 105 passed. Original production refusal stage remains unproven without per-request traces; no claim that every refusal had one cause. |

Frontend combined validation: **15 suites / 140 tests passed**. Client TypeScript passed. Focused lint: zero errors, two existing `OverviewTab` effect warnings unrelated to the wording change. `git diff --check` passed at this checkpoint.

Additional main-agent server validation: **13 suites / 207 tests passed** across support orchestration, journey v2, advisory/customer preview, natural replies, saved regression cases, workflow/tab contracts, semantic routing, classifier runtime, opt-out and channel sentiment. Together with the 44 router/approval tests, these cover 251 distinct selected server tests. Server TypeScript passed at this checkpoint. These are fixture/mocked regressions, not live provider calls.

The temporary Chrome fixture used synthetic messages and the real shared viewport/source components, not authenticated dashboard API calls. Its route and generated route type were removed after verification; no test-only public route is retained. The localhost sign-in tab remains at the login form. Owner/member authenticated E2E and campaign-agent success are therefore **not signed off**. No password or authentication bypass was used.

### Final combined validation

- **Server: 33 suites / 497 tests passed**, zero failures, after all fixes and integration refinements.
- **Frontend: 15 suites / 140 tests passed**, zero failures. Total selected regression coverage: **48 suites / 637 tests** (do not add earlier overlapping runs to this total).
- Client and server TypeScript checks passed. Focused lint passed with no errors; remaining warnings are existing `OverviewTab` effect warnings and test mock `any` warnings. A pre-existing redundant regex escape in the touched privacy file was removed without changing its match semantics.
- The first combined server run exposed two regressions: duplicate-source selection and Indian-number formatting. Both were corrected without weakening the existing tests, then the combined suite was rerun. Final review additionally removed a business-specific stop-word shortcut and added provenance regressions before the last full run.
- Local API restarted using `.local/start-campaign-qa.ts`, with cron disabled and `START_EMBEDDED_MEDIA_WORKERS=false`; `http://localhost:8080/health` returned `healthy`. Frontend remains on port 3000. No remote server restart or deployment occurred.
- Temporary synthetic browser fixture removed. Local login tab retained for the user. No authentication bypass, actual outreach, publishing, scheduling, booking, billing changes or production writes in this remediation pass.

Final server suites: `supportOrchestrationCore`, `supportJourneyV2`, `supportChatAdvisoryRuntime`, `supportInternalChatPlaybook`, `supportNaturalReplyDelivery`, `supportLiveChatRegression`, `supportCustomerFlowRegressions`, `conversationWorkflowContract`, `conversationTabContract`, `semanticRouterRegression`, `intentClassifierRuntime`, `jevOptOut`, `jevChannelSentiment`, `orchestratorRouter`, `icpContinuation`, `conversationApprovalContract`, `openRouterOutputBudget`, `llmProviderErrors`, `llmProviderFactoryFallback`, `baseAgentProviderError`, `icpAgentProviderError`, `jevDecisionsTransport`, `knowledgeExtractiveAnswer`, `knowledgeAnswerRecovery`, `knowledgeClaimContradictions`, `knowledgeNaturalAnswer`, `knowledgeProviderOutage`, `knowledgeQuoteFormatting`, `knowledgeWithdrawalRuntime`, `supportMemberRetrievalScopeStage`, `knowledgeEvidenceArchitecture`, `jevKnowledgeReranker`, `supportFaqRecoveryStage`. Run with `pnpm test --runInBand tests/<name>.test.ts` from `server/` using the bundled Node runtime.

**External blocker:** true provider balance/key-budget exhaustion cannot be fixed by these code changes. The historical production failure does not prove the current account is empty; an administrator must check balance/request affordability. Actual successful ICP edit, Outreach answer, Performance analytics/chart and preview-time correction still require local authenticated/provider E2E verification. The code is not deployed, and no all-agent production sign-off is claimed.

## Historical live result: QA completed with failures — no clean sign-off

Submitted **22 real website messages**: nine support-advice turns, four customer-preview turns, and nine campaign turns. All returned a response; several responses were errors or false refusals. No real customer delivery, booking, ad publication, scheduling, or ad spend was requested. Created two internal support QA sessions and campaign **208**, `ORO Circle Boutique Hotel Partnerships Bengaluru`, with an unapproved ICP draft. Normal model calls consumed application/provider credits; no aggregate cost attribution is claimed.

**Important:** these are deployed-production behavior checks, not proof that the uncommitted local Jev implementation works in Chrome. Local authentication remains unverified. The 248 local automated tests below belong to the preceding preparation pass and are not production E2E tests.

### Confirmed failures and priority

1. **Support chat scroll clipping:** after multiple replies, the whole message area became visually blank even though all messages remained in the DOM. Ordinary scrolling did not restore it. Reloading and reopening this same long session also reproduced the problem. See measurements below.
2. **Provider failures block multiple campaign agents:** ICP edits and their retry failed, action-status routing failed, and Emily/Outreach and Sarah/Performance Marketing returned AI-service errors. Read-only SSH inspection of the API logs confirmed `LLMProviderResponseError`, repeated OpenRouter HTTP 402 credit-related errors, one credit-related HTTP 429, and empty visible output warnings for `openai/gpt-5.6-luna`. Some 402 errors mentioned token-budget affordability. Do not equate the workspace's displayed credits with the upstream provider's available balance/request budget.
3. **Support false refusals:** a formatted Email draft using already verified check-in/out facts and a Facebook question combining published day-out hours/GST/spa terms were refused. Simpler follow-ups in those same channels succeeded. This establishes user-visible failures, not whether retrieval, generation, verification, or provider fallback caused each one.
4. **Customer-preview inconsistency:** the corporate-offsite opening and a later time correction returned generic trouble responses. Switching to spa and providing date/time progressed to the next collection question.
5. **Over-redaction:** the preview rendered `I am [NAME_…] a corporate offsite` in place of `I am planning a corporate offsite`, and `This is [NAME_…] a preview` in place of `This is still only a preview`. The saved history title also contains `[NAME_1]`. Ordinary intent-bearing words are being treated as personal names.
6. **Misleading evidence badge:** generic preview error replies displayed `0 knowledge sources High grounding`. This should not be presented as successful high-grounding verification.

No production settings, credentials, code, database schema, or deployments were changed during diagnosis. Local remediation is distinguished above; no production rollout is claimed.

### Support advice — exact nine-turn sequence

Session title: `Chrome QA Sep 23: What are ORO The Estate's published check-`, available from Support AI → Chat history. All prompts were typed into the actual Chrome composer. Channel choices are internal rendering previews, not outbound deliveries.

| ID / channel | Prompt | Observed result / reasoning |
| --- | --- | --- |
| S1 Web | Chrome QA Sep 23: What are ORO The Estate's published check-in and check-out times? Answer in two short lines using approved knowledge only. | **Pass:** 2 PM / 11 AM, four sources. Expanded source tray contains these exact published timings. |
| S2 Web | Please turn those two timings into a numbered list with a bold heading. Keep the same facts. | **Pass:** bold “Published details” and a real two-item list; same facts and four sources. |
| S3 WhatsApp | Different question: list every published ORO day-out package price and its GST qualification. Do not omit the alternatives. | **Pass:** Rs. 4,299 / 3,499 / 5,499, each + GST; per-person qualification and terms preserved. Prior Web answers kept their original formatting. |
| S4 Email | Draft a short customer email using the check-in and check-out times from earlier, with a bold heading and two numbered items. Draft only; do not send an email. | **Fail:** “I do not have enough approved information to verify that,” zero sources. S1/S2 already established the requested facts. |
| S5 Email | What are the published ORO check-in and check-out times? Reply in two lines. | **Pass / recovery:** correct timings and four sources. HTML line break rendered; raw `<br />` occurs in the accessibility label, not the displayed answer text. Does not resolve S4. |
| S6 Instagram | Is early check-in guaranteed at ORO? Give only the published policy; do not promise availability. | **Pass:** up to 1–2 hours may be provided subject to availability; no guarantee invented. |
| S7 Facebook | What are ORO day-out hours, is GST included, and are spa services included? Keep the published qualifications. | **Fail:** generic insufficient-approved-information refusal, zero sources, despite S3's source-backed terms covering all three facts. |
| S8 Facebook | What are the published day-out start and end times at ORO? | **Pass / recovery:** 10 AM–6 PM unless a day-use room is booked; four sources. Does not resolve S7. |
| S9 Web | What is ORO's published moon-shuttle departure schedule for the year 2035? Do not invent any timetable if no approved source exists. | **Pass for safe refusal:** no fabricated timetable, zero sources, Review suggested. This is intentionally unsupported, unlike S4/S7. |

Seven of nine answer-content checks passed; two failed. This count excludes the independent scroll failure. All nine turns and their replies survived reload/reopen. Source expansion worked, and saved per-message channel formatting survived switching the composer channel.

### Customer journey preview — exact four-turn sequence

Mode selected explicitly: **Test customer journey**. UI notice: “Preview only. No customer messages or booking changes are sent.” Saved title starts `Chrome QA Sep 23 preview: I am [NAME_1] a corporate offsite`.

| ID | Prompt | Observed result / reasoning |
| --- | --- | --- |
| P1 | Chrome QA Sep 23 preview: I am planning a corporate offsite for 20 people. Please help me explore the options. | **Fail:** generic trouble response; ordinary word “planning” redacted as a name; error carries misleading High grounding badge. |
| P2 | Actually, forget the corporate event. Please help me explore a spa appointment instead. This is still only a preview. | **Partial pass:** asks which date/time suits the user, consistent with spa intake rather than the old corporate question. “still only” is incorrectly redacted. |
| P3 | September 30, 2026 at 3 PM. Do not create a real booking; this is a test preview. | **Pass for progression only:** asks for full name next. No booking claim. Exact field persistence was not independently audited. |
| P4 | Correction: make the preferred time 4 PM on September 30, 2026, not 3 PM. I do not want to give contact details or confirm a booking yet. | **Fail:** generic trouble response, so correction handling is not verified. Misleading High grounding error badge repeats. |

Human handoff, attachment workflows and final booking writes were not tested. No contact details were supplied.

### Campaign 208 — exact nine-turn sequence

| ID | Prompt | Observed result / reasoning |
| --- | --- | --- |
| C1 | Chrome QA Sep 23 — draft-only test. Create an ICP draft for ORO Circle targeting independent boutique hotels in Bengaluru for hospitality partnerships, using LinkedIn and Google Maps. Do not scrape leads, contact anyone, send, schedule, publish, or spend ad budget. Keep all work for review. | **Pass for draft:** Coordinator shows Crawl Website completed (3 pages), Generate ICP Profile completed, revision 1 and 69% completeness. ICP Profile widget correctly shows Bengaluru, independent hotels, LinkedIn/Google Maps and Approve ICP. Nothing was approved. |
| C2 | Before any approval, change only the target city from Bengaluru to Kochi. Keep independent boutique hotels, LinkedIn and Google Maps, and draft-only review. Do not run searches or outreach. | **Fail:** ICP AI-service error; saved profile remains Bengaluru. |
| C3 | Please retry the failed draft edit: replace Bengaluru with Kochi in the ICP targeting fields. Preserve the two selected channels. No approval or execution is authorized. | **Fail:** same error, no correction. A failed request did not overwrite the prior draft. |
| C4 | Read-only status check: what is waiting for my approval in this campaign, and what has actually run? Do not approve or execute anything. | **Fail:** routing unavailable; response says saved strategy/reviews unchanged and points to campaign 208. No false successful action claim. |
| C5 | Switch to a read-only lead-generation question: list the available Yelp and Google Maps search workflows. Do not prepare or execute a search, approve the ICP, or contact leads. | **Pass:** Marcus returns Yelp Business Search and Google Maps Business Search, with approval and Yelp live-verification caveats. Catalog response is not proof that a provider search ran. |
| C6 | Switch platforms: show only the LinkedIn lead-workflow catalog now. Do not run or prepare any search. | **Pass:** Marcus returns LinkedIn-only catalog with nine strategies; no stale Yelp/Google Maps response. |
| C7 | Switch to Content Studio: draft two short Instagram captions about ORO hospitality partnerships for my review. Copy only; do not create images, schedule, publish, contact anyone, or approve the ICP. | **Blocked:** current saved ICP approval required, followed by ICP AI-service error. Content Studio generation was not reached; do not mark it passed. |
| C8 | Read-only question for Outreach: can email and WhatsApp outreach use saved campaign leads, and how are queued, sent, failed and awaiting-approval recipients shown? Explain only; do not create a campaign, draft, message, schedule, or approval. | **Fail after routing:** Emily is selected but returns AI-service processing error. Outreach explanation/tools not verified. |
| C9 | Read-only request for Performance Marketing: show existing campaign performance analytics and its chart widget. If this QA campaign has no data, say so. Do not create, schedule, publish, sync providers, or spend anything. | **Fail after routing:** Sarah is selected but returns AI-service processing error. No analytics/chart widget produced; not verified. |

Campaign history and ICP Profile survived reload. The result panel could be minimized and restored. Its label still calls the 69% completeness value “ICP Fit Score” / “targeting accuracy,” while the chat correctly says completeness, not predicted performance; this wording remains potentially misleading.

### Scroll reproduction and measurements

Chrome desktop viewport approximately 1800 × 866 CSS pixels. Measurements were read-only DOM geometry; no CSS/DOM workaround was injected.

- **Campaign:** message viewport remained approximately **651 px high**, top approximately 144 px, outer scroll offset 0. During live turns its inner content grew from 2442 px to approximately 5044 px; scroll offset stayed at the bottom within subpixel rounding. Screenshot showed normal full-height chat and composer. Reload and result-panel minimize/restore worked. Original campaign-only collapsed-height symptom was **not reproduced in this run**, not proven impossible.
- **Support:** after S9, screenshot showed a blank chat panel. Inner viewport had **527 px height** but **y = −398 px**; its padded `overflow-hidden` parent had **scrollTop = 546.875 px**. Last assistant message ended above the parent's clipping boundary. Inner viewport separately had scrollTop 1922.5 px and content height 2449 px. A normal wheel scroll over the blank pane did not change this state.
- **Support after reload/reopen:** all 18 messages were in the accessibility tree, but screenshot remained blank; parent scrollTop approximately **550.625 px**, viewport **y = −401.5 px**. This session therefore did not recover merely by refreshing.
- Local source inspection identifies a plausible cause: owner support uses `messagesEndRef.scrollIntoView({ behavior: "smooth" })` (page.tsx line 161) with padding on a nested ScrollArea root (line 540). The hidden outer root can be programmatically scrolled along with the intended viewport. Campaign ChatInterface already uses different pinned-viewport containment. Runtime geometry supports this diagnosis; a tested fix is still needed. Member support also uses scrollIntoView but was not browser-tested here.

### Provider diagnostics and limits

Read-only `docker logs` inspection of production `sm-api`, bounded to this test window, summarized error classes/codes without exposing keys or raw provider bodies. The final 20-minute/5000-line sample contained 23 credit-related HTTP 402 fallback warnings (12 mentioning token budget), one credit-related HTTP 429, and two other response errors for OpenRouter `openai/gpt-5.6-luna`. Counts are log entries, not unique requests, and may include concurrent workspace traffic. The two original ICP failures and routing failure also had corresponding named server error events.

Check upstream balance/key budget and requested token affordability before repeating expensive cases. The report does not assert the account is completely empty, or that every false refusal has the same cause. Browser console error/warning collections were empty across all three QA tabs; application failures still appeared as ordinary assistant replies.

Next remediation order: (1) restore a usable upstream generation path, without weakening approval or verification; (2) fix support scroll containment and verify long live/reloaded sessions; (3) trace false refusals, preview failures and over-redaction with the saved QA turns; (4) correct failure grounding labels; (5) rerun Content/Outreach/Performance and sandbox-only execution coverage. Scheduling, publishing, actual deliveries, analytics charts and all-agent end-to-end completion remain unverified.

## Initial local attempt: blocked at authentication

The public home page and sign-in form rendered in Chrome. The selected Chrome profile has no authenticated local workspace session. The user was asked to sign in directly; no password, session token, or authentication bypass was used. The Chrome tab and local development servers were left available for continuation.

No support or campaign chat message was submitted in the initial local attempt. The live continuation above supersedes that initial browser blocker only for the deployed website. Passing local automated checks below is not browser end-to-end sign-off.

## Setup observations

| Case | Expected | Actual | Assessment |
| --- | --- | --- | --- |
| Open localhost in Chrome | App reachable | Initially `ERR_CONNECTION_REFUSED`; frontend and API were stopped | Environment issue; started local QA API and Next.js webpack development server; Chrome then loaded the app |
| Open dashboard sign-in | Existing session or sign-in | Empty email/password form | Blocked pending user sign-in to the intended test workspace |
| Non-executing test environment | No background campaign jobs scheduled by this run | Used existing `.local/start-campaign-qa.ts`, which disables cron startup | Final API run also sets `START_EMBEDDED_MEDIA_WORKERS=false`; no separate queue worker launched |

The first short-lived API startup used an incorrect media-worker environment variable and initialized media workers. It was stopped and restarted with the correct variable before any UI chat was submitted. No media-job processing appeared in the captured startup output; this is not an exhaustive historical queue audit. The existing outreach sender singleton initialized normally. No send, publish, booking, subscription, or campaign execution was intentionally requested.

## Automated checks completed in this run

- Frontend: **13 suites, 119 tests passed** (Vitest; 5.11 seconds).
- Server: **12 suites, 129 tests passed** (Jest; 5.415 seconds).
- Total: **25 suites, 248 tests passed**, zero failures in these selected suites.

Frontend coverage: support session isolation, channel formatting, failed-question retry; conversation overflow source contracts, stream reducer, action resolution, approvals, progress ownership, visual pane, result-tab reload, thread-load recovery, run status and result mappings.

Server coverage: support owner advisory and customer-preview contracts, natural reply delivery, earlier live-chat regression cases using test fixtures, customer-flow regressions; campaign workflow/approval/tab contracts, semantic routing, classifier runtime, semantic opt-out and canonical channel sentiment.

These tests use fixtures/mocks or source contracts. In particular, the overflow contract checks CSS/React source invariants, not actual Chrome element height while a model response streams. A test named `supportLiveChatRegression` reproduces previously observed issues with fixtures; it does not send live dashboard messages.

Commands, from the respective directories with the bundled Node runtime on PATH:

```sh
# client/
pnpm test src/__tests__/supportChatIsolation.test.tsx src/__tests__/supportChatChannelFormats.test.tsx src/__tests__/supportChatRetry.test.tsx src/__tests__/conversationOverflowContract.test.ts src/__tests__/conversationStreamReducer.test.ts src/__tests__/conversationActionResolution.test.tsx src/__tests__/conversationApproval.test.ts src/__tests__/conversationProgressOwner.test.tsx src/__tests__/conversationVisualPane.test.tsx src/__tests__/conversationTabReloadContract.test.ts src/__tests__/conversationThreadLoadRecovery.test.ts src/__tests__/conversationRunStatus.test.ts src/__tests__/conversationResultTabs.test.ts

# server/
pnpm test --runInBand tests/supportChatAdvisoryRuntime.test.ts tests/supportInternalChatPlaybook.test.ts tests/supportNaturalReplyDelivery.test.ts tests/supportLiveChatRegression.test.ts tests/supportCustomerFlowRegressions.test.ts tests/conversationWorkflowContract.test.ts tests/conversationApprovalContract.test.ts tests/conversationTabContract.test.ts tests/semanticRouterRegression.test.ts tests/intentClassifierRuntime.test.ts tests/jevOptOut.test.ts tests/jevChannelSentiment.test.ts
```

## Original Chrome continuation plan — see actual coverage above

Use uniquely titled QA conversations and the workspace's actual published knowledge. Do not assume hotel facts apply to a different workspace. Record exact prompts, replies, session IDs, tool receipts, widget state and failures per turn.

| Sequence | Multi-message checks | Expected |
| --- | --- | --- |
| Support advisory | Ask a published factual question → refer to the answer indirectly and request formatting → change topic → ask an unsupported factual question | Grounded sources, retained follow-up context, newest intent honored, no invented answer |
| Support channel previews | Repeat a short factual question and follow-up in Web, WhatsApp, Email, Instagram and Facebook | Correct per-message formatting; changing composer channel does not reformat historical messages |
| Support customer preview | Begin a configured journey → supply a requested field → correct it → switch journey → request a person | Context updates and safe simulated handoff; no real booking, payment or handoff claim |
| Support recovery | Reload/reopen QA session; inspect history; check busy/composer state | Durable messages, no duplicates, usable composer; do not induce provider outages in a shared environment |
| Campaign coordinator / ICP | Request a synthetic review-only plan → revise target audience → ask what needs approval | Latest revision retained, correct specialist, explicit prerequisites and approval state |
| Lead agent | Ask for one platform's catalog → switch to another → prepare one small review-only workflow | Latest platform honored; correct saved input widget, no duplicates or scrape execution |
| Content Studio | Request copy only → revise tone/format → explicitly decline publication | Content rather than outreach intent; durable drafts and matching widgets, no external publication |
| Outreach | Request email and WhatsApp drafts for a synthetic campaign → revise one → ask what is sent versus pending | Correct channels, recipient/approval gates, no fabricated sent receipts; no actual customer delivery |
| Performance Marketing | Request a review-only ad outline → ask for existing analytics → ask how scheduling would work without scheduling | Correct agent and analytics widgets, accurate empty/permission states, no provider execution or spend |
| Compound intent | Ask for two ordered draft tasks → change the second task → cancel execution | Ordered agent handoffs, newest intent preserved, cancellation is not approval |
| Live scrolling | Inspect message viewport/composer during several replies; open and close a result panel; scroll old/new messages; refresh and compare | Full available chat height throughout streaming, no top-only small scroll region, no horizontal leakage |

Execution-boundary tests involving real outreach, publishing, scheduled external actions or ad spend require sandbox destinations and explicit scope. They must not be represented as passed based on draft-only testing.

## Initial live-QA changes and limits (before remediation)

The initial live-QA pass added/updated this report and its `.gitignore` allow-list entry only; the later local application fixes are recorded at the top. No changes were committed or deployed during these QA/remediation passes. Existing uncommitted Jev implementation and unrelated workspace files were preserved. Live QA created the internal test chats and unapproved campaign draft described above. No claim is made that all agents, toolkits or dashboard use cases work end to end.
