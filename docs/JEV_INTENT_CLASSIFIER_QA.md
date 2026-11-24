# Configurable intent classifier: implementation and QA

Date: 2026-09-23. Environment: local `salesmarketing` checkout and database.

## Outcome and scope

Implemented a separately configurable intent classifier for campaign conversation routing and shared inbound support classification. The default is OpenRouter `typesafe/jev-1.13`, using the existing OpenRouter provider credential. Administrators can instead select OpenAI, Gemini Developer API, Vertex AI, or another catalogued OpenRouter text model.

This is a classification layer, not a replacement for the orchestrator, entity extraction, agent tools, or execution authorization. It does not use regular expressions to interpret user replies. Existing schema validation, explicit agent mentions, ownership checks, approval/revision checks, and support risk/handoff policies remain in place.

No production code, migrations, or settings were changed. No real outreach, publication, advertising spend, bookings, or inbound platform webhook deliveries were performed by these tests. This report covers the classifier integration, not every outstanding item in the older campaign QA reports or the chat scrolling issue.

## Configuration and architecture

Admin → Global AI settings now includes an **Intent classifier** card with provider/model selectors and an independent save button. API credentials remain in Provider Integrations; no second classifier key is needed.

- `GET /api/admin/ai-settings` includes the classifier catalog and current selection.
- `PUT /api/admin/ai-settings/intent-classifier` saves only the classifier selection.
- Existing `PUT /api/admin/ai-settings` also supports the new fields; older callers preserve the current selection when omitting them.
- Both update routes retain administrator authentication and super-admin authorization.
- Migration `291_intent_classifier_settings.js` adds the persisted provider/model defaults. Applied locally only.
- Settings updates invalidate the local settings cache. The campaign routing cache also incorporates classifier selection, so a changed model does not reuse the old routing decision. Other application processes refresh their settings cache within its existing five-second TTL.

```text
Latest message + conversation context + current application state
  → configured intent classifier
  → validated confident labels (uncertain fields deferred)
  → full-model structured routing / entity and risk extraction
  → schema validation and disagreement fallback
  → existing ownership, approval, handoff and execution guards
  → existing agents and tools
```

Campaign integration is in `server/mastra/unifiedRouter.ts`. It classifies action, intent, status/content/outreach operation, and membership of the five campaign agents. The full model retains responsibility for ordered tasks, IDs, scope, and free-text details. Agent membership supports compound requests rather than forcing a single agent.

Support integration is in `server/services/agents/NLUService.ts`, reached by the shared `IntentRiskClassifierStage`. The same semantic classification path is used for WhatsApp, Instagram, Facebook, email, and webchat. Existing entity, sentiment, urgency, risk, and human-handoff output remains available.

Jev uses OpenRouter's dedicated `POST /api/alpha/decisions` endpoint, not chat completions. Other configured text models use their existing provider adapters with structured JSON output. Provider selection reuses the active credential without changing the default conversational model.

### Reliability and safety

- Validate criterion membership, answer type, confidence range and any supplied probability values before inserting labels into model context.
- Accept individual fields only at confidence ≥ 0.90; defer uncertain, missing, or malformed fields to the full model. Alternative text models' self-reported confidence is a routing heuristic, not a calibrated guarantee.
- Preserve the latest user message and supplied conversation context. Oversized Jev requests fall back without silently cropping text; the conservative bound is 30,000 UTF-8 bytes.
- Bound Jev transport to eight seconds. Missing credentials, HTTP errors, timeouts, invalid output, and uncertainty fall back to existing full-model routing.
- If structured extraction disagrees with accepted labels, reclassify the original context independently. Never merge conflicting decisions into an executable plan.
- Classification never grants execution approval. Quoted text and historical content are data, not fresh authorization.
- Log outcome, confidence, deferred question IDs and usage, without raw provider error bodies or credentials. Jev billing uses provider-reported cost, with the version's published input rate only as a fallback when cost is absent.

## Failures observed and fixes

| Case | Observed result | Fix and reasoning | Verification |
| --- | --- | --- | --- |
| Missing local OpenRouter credential | Live Jev calls could not start | With explicit user authorization, retrieved the existing credential over SSH and encrypted it with the local credential writer; kept the remote environment unchanged | Successful real Decisions request; local credential stored encrypted |
| Independent classifier save | An unrelated inactive text-model provider disabled the global save action | Added a classifier-only authenticated endpoint and save button, preserving unrelated defaults | Controller/UI tests and real local database save/restore |
| Multi-question uncertainty | One uncertain field discarded all otherwise reliable classifications | Validate questions independently; defer only uncertain fields | Contract regression tests and final live canary |
| Paid campaign analytics | Request could be interpreted as opening a view rather than requesting analytics work | Clarified semantic task/navigation distinction in the classifier and router contracts | Live `campaign_paid_analytics` passes task and agent assertions |
| Tamil polite booking request | “மசாஜ் செய்ய நேரம் ஒதுக்க முடியுமா?” could be classified as an information question | Clarified indirect booking requests versus factual availability questions in the support model contract; no keyword/regex override | Live `support_tamil` returns booking/spa |
| Classifier/model change | Cached routing must not retain the previous classifier's output | Included classifier selection in routing cache identity | Same-context settings-change regression passes |
| Missing local-storage helper in checkout | Existing imports prevented application/typecheck/support-test loading | Added the missing `localStoragePath.ts` utility, preserving configured path handling and source/bundle layout expectations | Five existing path tests, server typecheck and builds pass |
| Admin test typing | Testing Library rejected an unsupported `exact` option during typecheck | Removed the unsupported option; exact string role name is sufficient | Client tests and typecheck rerun |

The temporary SSH import helper was removed after use. No secret was written to the repository or printed in test output.

## Live multi-message canary

The final real-provider run passed **10/10** synthetic scenarios. It invoked the actual campaign router and support NLU using the saved Jev selection plus the configured full-model fallback/extractor. Individual fields may correctly be deferred; these results do not mean Jev alone supplied every field.

| ID | Conversation / latest request | Expected and observed |
| --- | --- | --- |
| `campaign_copy` | Leads discussed → reusable email template only, no outreach | Content Studio; task; no execution approval |
| `campaign_outreach` | Selected leads ready → prepare email sequence, do not send | Outreach; task; no execution approval |
| `campaign_compound` | Choose work → find leads then social post, no outreach/ads | Lead Generation then Content Studio, in that order |
| `campaign_paid_analytics` | Paid Meta campaigns → show existing campaign performance | Performance Marketing; task |
| `campaign_status` | Reviews pending → what is waiting on me, run nothing | Campaign action-status question; no hired agents |
| `support_topic_switch` | Corporate event → book spa instead | Booking / spa |
| `support_slot_continue` | Spa booking → requested date/time reply | Continue / spa; date-time entity retained |
| `support_brochure` | Proposed corporate booking → no booking, brochure/pricing | Document / corporate |
| `support_tamil` | Help prompt → Tamil polite massage appointment request | Booking / spa |
| `support_human` | Spa date question → connect to a person | Human request; handoff flag retained |

The live Decisions response resolved the default alias to `typesafe/jev-1.13-20260917`. Live calls consumed normal provider/application credits. No external action tools were dispatched.

## Automated and persistence verification

- **299 server tests passed across 15 selected suites:** admin settings, classifier contracts/runtime/transport, semantic routing, support NLU/pipeline, approval preservation, action status, content constraints, provider fallback and local storage paths.
- **3 client tests passed:** selection/save/reload state, unconfigured-provider/error handling, and independent classifier saving while the text provider is offline. These are rendered component tests with mocked API and select controls, not full browser E2E.
- Explicit provider adapter tests cover OpenAI, Gemini, Vertex AI and OpenRouter credential reuse. OpenAI/Vertex were not live-tested with active credentials.
- Real local database round-trip: switched classifier to Gemini, read back the selection after cache invalidation, verified all six text/image/video settings unchanged, then restored and verified OpenRouter/Jev defaults. Both changes use the existing audit mechanism.
- Server and client TypeScript checks, targeted runtime/page ESLint checks, server API/worker builds, and `git diff --check` were run.
- Local admin page returned HTTP 200; the unauthenticated settings API returned 401. Chrome automation timed out, so interactive Chrome save/reload and layout verification remain **unverified**.

## Reproduction and rollout

Run the live canary from `server/` against an explicitly chosen test environment with active provider credentials:

```sh
pnpm exec tsx scripts/verify-intent-classifier.ts --user-id <test-user-id> --execute
```

`--execute` is required because this script makes billable model calls. It does not run agent tools or create campaign/booking records.

Before deployment, apply migration 291 through the normal migration process, then deploy the API/worker and frontend together. The production OpenRouter credential already exists, but this work did not modify or test production application routing. Verify the admin selectors and a controlled campaign/support conversation in Chrome after deployment. Choosing another configured classifier in Admin provides a runtime alternative; unavailable Jev automatically falls back to the existing full model.

Passing this bounded corpus is not evidence of universal intent accuracy. Expand the canary with anonymized, consented real-world examples, additional languages, ambiguous follow-ups and long histories before relying on broader accuracy claims. External sending, scheduling, publication, analytics widgets and chat scrolling still require their own end-to-end acceptance checks.

## Provider references

- [OpenRouter API schema](https://openrouter.ai/openapi.json) — Decisions request/response contract.
- [Jev 1.13 model](https://openrouter.ai/typesafe/jev-1.13) — model identification and published pricing.
- [Typesafe confidence documentation](https://docs.typesafe.ai/confidence) — confidence interpretation.

## Application-wide extension pass — 2026-09-23

The user authorized the additional integrations and a Luna Max audit. Three `gpt-6-luna` subagents at `max` reasoning handled the wider read-only audit, lead implementation, and knowledge implementation. The main agent integrated ICP/sentiment/opt-out changes, reviewed worker patches, and ran combined verification. The original results above describe the first implementation pass; this section describes the subsequent extensions.

### Implemented paths

| Area | Integration and boundary |
| --- | --- |
| ICP generation | `detectUserIntent` uses the configured classifier with the full supplied conversation, then the existing full-model fallback. The Mastra ICP executor passes its server-owned current router result for unambiguous reuse. Compound goals are not arbitrarily reduced to the first agent. Paid analytics maps to Performance Marketing. Low-confidence fallback labels become general. ICP content generation stays with the full model. |
| Standalone sentiment | `SentimentAnalysisService` classifies tone and ordinal intensity; uncertainty uses the existing full model. Compatibility scores are intensity bands, not classifier confidence or conversion probabilities. Classifier-only results do not invent keyword explanations. |
| Shared support sentiment | Sentiment is included in the existing Jev/NLU request. `SentimentStage` now follows NLU and reuses its result, preserving downstream sentiment metadata without a second classification. |
| Inbound email | Removed its separate pre-routing sentiment call. The channel receives `classifiedSentiment` from the canonical gateway, persists it against exact tenant-owned message IDs, and carries the same result into deferred effects. Early halted decisions do not fabricate sentiment or delivery authority. A server-owned opt-out receipt permits only its static acknowledgement through the existing delivery gate. |
| CRM analytics | Both sentiment-to-status mappings preserve the current stage. “Thanks” cannot mark a deal won, and negative emotion cannot mark it lost. Explicit workflow/business-event transitions remain separate. |
| Provider lead relevance | Bounded semantic review can rescue soft industry-text mismatches using affirmative supplied evidence. Hard geography, requested property type, luxury/independence evidence, role contradictions, source identity, reviewed follower targeting and duplicate checks remain deterministic. Sparse/uncertain evidence cannot be upgraded solely from a qualification-band label. |
| Lead scoring | The live single-lead scoring path used by the lead controller and enrichment service gains bounded semantic fit bands when `LEAD_SCORING` is enabled. Disabled scoring makes no classifier calls. Deterministic component scores and full-model explanations are retained; band adjustments are not purchase probabilities. |
| Knowledge retrieval | Reranking can use complete confident direct/partial/irrelevant decisions for at most 20 candidates in batches of four. Ordinal relevance, existing scores, and authority determine ordering—not classifier confidence. Candidate IDs and all evidence are retained; uncertainty/malformed output/provider failure use existing fallbacks. This does not verify factual truth or replace source permissions/grounding. |
| Conversational opt-out | Added a post-NLU semantic stage that reuses the existing ownership-checked opt-out transaction. Exact STOP/unsubscribe remains before models. A semantic mutation requires agreement on the specific contact-preference field plus the conservative threshold, not confidence in unrelated fields. Model-authored verification flags are ignored. There is no classifier-driven re-opt-in. |

Lead import semantic review is deliberately budgeted to two four-candidate batches per workflow execution; other candidates retain existing checks. This is bounded integration, not a claim that every imported record receives a model call. Long lead evidence/criteria fall back rather than silently removing negation or constraints. Knowledge relevance operates on bounded excerpts as the existing reranker does, with independent downstream grounding still required.

### Findings addressed during review

1. **Opt-out field provenance:** Luna identified that overall NLU confidence could conceal an uncertain contact-preference field. The service now creates `contactPreferenceVerified` only from accepted classifier/extractor agreement; the semantic stage requires it. Tests cover omitted fields, forged model booleans, classifier outage, and high confidence in unrelated fields.
2. **Opt-out scope:** A category-only or channel-specific preference is uncertain when the current conversation-wide opt-out state cannot represent it. The code must not convert “no promotional offers” into “no contact of any kind.” These narrower preferences still require a dedicated preference-management flow.
3. **Lead evidence truncation:** Initial bounded text packing could omit late negation or criteria. Worker review changed this to bounds-aware fallback rather than accepting an incomplete brief.
4. **Disabled scoring:** Initial lead work could call the classifier with scoring disabled. The final enabled/disabled guard and no-call tests preserve the feature's existing contract.
5. **Inconsistent fit labels:** A strong qualification band without affirmative relevance evidence cannot rescue a lead rejected by factual constraints.
6. **Knowledge fallback validation:** Low-confidence/incomplete labels, extra choices, and unsuccessful full-model responses are not accepted as valid ordering decisions.
7. **Regression maintenance:** Updated one stale unsupported-answer text assertion without weakening handoff/no-CRM-effect assertions. Removed two no-op rethrow wrappers flagged by lint in inbound email. Updated the support stage-order audit to include semantic opt-out, sentiment reuse, and the already-present history/document stages.
8. **LinkedIn optional filters:** Wider workflow tests found that a generic nonempty-location check rejected optional empty filters on profile-by-name and company-employee searches. Narrowed that check for those two actor contracts, retaining array type checks, company targets and other actors' required-filter rules. This is deterministic schema validation, not a new model decision.

### Deliberately not replaced

- The live lead review approval gate remains explicit and deterministic. Jev cannot approve execution, spend, publication, or outreach.
- `WorkflowRulesEngine` is only reached from an uncalled recommendation method in the searched repository. It remains inactive rather than becoming a second router.
- `CRMService.mapIntentToPipelineStage` and `LeadScoringService.scoreLeadRecords` have no runtime callers in the searched server code. They were not connected to classifier output.
- Dedicated moderation, ownership checks, exact IDs, receipts, budgets, booking/payment facts, content generation, and history-tool pagination remain with their existing specialized systems.
- Category-specific opt-out persistence and automatic re-opt-in are not implemented. A paraphrased withdrawal without verified classification does not mutate the subscription; the current turn fails closed. Exact STOP remains available during provider outages. This does not establish a new background campaign-suppression mechanism.

### Extension verification

Final combined regression: **609 tests passed across 37 server suites**. This includes actual workflow persistence-path budget tests (mocked database/provider), proving that repeated incremental saves share the two-batch budget and that hard geography failures do not call the classifier. Server TypeScript, API/worker builds, stage-order/legacy-boundary audit, and `git diff --check` passed. Targeted ESLint completed with zero errors; existing and local typing/style warnings remain. These are selected regression suites, not a claim that the entire repository's test suite was run.

The classification-only extension canary passed **10/10** after the opt-out provenance fix: copy-without-sending, paid analytics, frustration/sarcasm sentiment, gratitude-not-a-sale, English withdrawal, Tamil withdrawal, booking cancellation without unsubscribe, quoted unsubscribe text, knowledge relevance, and contradictory lead evidence. The original campaign/support canary also passed **10/10** after these extensions.

Neither script dispatches application tools or performs actual opt-out/CRM mutations. Mocked transaction tests separately verify tenant ownership, dry-run isolation, no-op uncertainty, and no false success when ownership fails. Real sending, publishing, scraping, and production traffic were not exercised.

Run the additional billable, synthetic canary from `server/`:

```sh
pnpm exec tsx scripts/verify-intent-extensions.ts --user-id <test-user-id> --execute
```

No production deployment or additional migration was performed in this extension pass. No aggregate speed, cost reduction, or universal accuracy claim is made: low-confidence paths may still use the full model, and some evidence-ranking/scoring paths add a bounded classification step.
