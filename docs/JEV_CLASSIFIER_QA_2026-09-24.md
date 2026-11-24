# Jev intent-classifier QA — 2026-09-24

## Scope and environment

- Isolated localhost copy of the live PostgreSQL snapshot; **nothing was deployed**.
- Google Chrome was used for the admin integration page, campaign conversation, and Support AI dashboard. Service-only call sites were exercised with synthetic, read-only inputs against the configured local classifier credential.
- Local snapshot migration `295_intent_classifier_integrations.js` copied the active OpenRouter LLM credential's encrypted key into a separate active classifier credential configured for `typesafe/jev-1.13`. Ciphertext equality was checked without printing or decrypting the key. The admin connection test passed.
- The local QA harness blocked delivery and publishing endpoints. Browser messages expressly prohibited sends, approvals, booking, scheduling, publishing, and spending. The snapshot still records test chat turns and local model-credit usage.

## Regression found and fixed

The first read-only campaign turn returned a sound answer, but the classifier credential usage counter did not increase. The campaign router passed its full 18.6 KB routing contract plus 8.8 KB of classifier questions and the conversation/database context to a classifier capped at 30 KB. This routinely exceeded the cap and silently selected full-model routing instead of Jev.

`buildCampaignClassifierMessages` now gives Jev a compact contract, current campaign state, complete latest user turn, and as many complete recent turns as fit. It never truncates the latest request. The general router still receives its complete original prompt and context, independently validates Jev labels, and retains its normal approval safeguards. An oversized latest turn still falls back to full-model reasoning.

Regression test: `intentClassifierRuntime.test.ts` supplies a long business description and earlier turn, checks the Jev payload is within 30 KB, the latest request is intact, and the full router still sees the business context.

## Results

| Jev call site | Test path | Result |
| --- | --- | --- |
| Campaign `UnifiedRouter` | Chrome conversation #208, two read-only turns | First pre-fix turn bypassed Jev; post-fix turn used Jev and the classifier was accepted. The answer correctly distinguished campaign approval from a provider delivery receipt. |
| Support `NLUService` | Chrome Support AI dashboard, two read-only questions | Jev was invoked; published check-in/out times were returned for a supported question. An undocumented corporate cancellation-policy question produced a safe insufficient-evidence answer, with no invented policy. |
| `ICPGenerationService.detectUserIntent` | Synthetic local live-provider probe | Jev classified a no-contact hotel-discovery goal as `lead_generation`. |
| `JevLeadSemanticService` | Two synthetic lead profiles, no search/import | Jev classified the clearly unrelated software profile as poor fit. It deferred a low-confidence band for the hotel profile, so that candidate remained on the neutral fallback path. |
| `SentimentAnalysisService` | Synthetic local live-provider probe | Jev returned positive sentiment for a thank-you message. |
| `KnowledgeReranker` | Synthetic two-candidate local live-provider probe | Jev placed the direct check-in policy ahead of unrelated breakfast evidence. The browser support-policy question had zero eligible knowledge sources, so it did not exercise reranking through the UI. |

The active classifier credential stayed `valid`; its usage count rose from 0 to 7 across the browser and service probes. Campaign, outreach-message, and sent-message counts remained 0, 5,513, and 384 respectively during the campaign verification. No campaign, outreach delivery, or publication was created.

Automated checks: 10 targeted server suites passed (115 tests); server and client TypeScript checks passed; the admin classifier frontend suite passed (3 tests).

## Coverage boundary

Chrome cannot reach standalone sentiment analysis, lead scoring, or synthetic knowledge reranking without performing unrelated application workflows. Those three paths and the ICP detector were therefore tested directly against Jev, while their contract/fallback behavior was covered by automated tests. This is not a claim that a full lead import, provider outreach, or ad publication was browser-tested.
