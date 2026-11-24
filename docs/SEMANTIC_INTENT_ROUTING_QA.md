# Model-driven campaign intent routing

Date: 2026-09-22. Scope: AskSales campaign conversation orchestration.

## What changed

The application already had an LLM router, but English phrase/regex corrections could override it afterward. This change uses the user's configured model/provider fallback to return a validated `semanticRequest` alongside agent routing. It does **not** train a new foundation model.

The flow is now:

1. Load the owned conversation and current review state, then send the complete current message plus bounded conversation context to the model.
2. Validate the routing action and semantic request with Zod. Invalid structured responses get provider fallback and one bounded repair. Failure/ambiguity asks for clarification; it does not invent a keyword-based route or authorize work.
3. For read-only campaign-action status, query the fresh durable review/approval/delivery ledgers. Do not ask the specialist to reconstruct execution state from old prose.
4. Otherwise pass that same classification into the current orchestrator invocation and specialist tool context, avoiding a second classification of the same HTTP turn. Persisted intent from an earlier turn is not reused as current intent.
5. Resolve review defaults only by the model-selected exact ID and application-validated ownership/tool/status. Enforce the existing approval, revision, recipient, integration and execution gates separately.

### Replaced natural-language decisions

- Recipient outreach and lead-catalog regex overrides after model routing.
- Phrase-based campaign status shortcut, including its compound-message cropping.
- Content review-versus-asset decisions and new-publication-versus-existing-schedule decisions.
- Brand-toolkit keyword/substring fallback and proposal keyword pre-processing.
- Generation task inheritance, media bans/corrections, variation counts, CTA and length constraints.
- Paid campaign/platform selection inherited through English matching.
- Paid analytics scope inferred from question wording; scope is now structured, persisted in the review and visible/editable in the widget.
- In the semantic chat path, lead requirements, total cap, location, follow-up selection and requested search variants now come from model-resolved fields instead of English request-cropping helpers.

The semantic result includes status intent, task relationship, content operation, exact generation review ID, toolkit/proposal intent, lookup scope, lead requirements/limits/location/variants, generation settings and paid campaign selection. Specialists receive this structured interpretation as context as well as the original messages.

### Deliberately retained deterministic behavior

Literal `@agent` addressing is a UI command, not a natural-language classifier. JSON envelope parsing, IDs/URLs/types, supported tool enums, tenant ownership, current resource revisions, exact review identity and execution approval remain code checks. A model saying “continue” is not execution consent. A succeeded generation card is not proof of publication or delivery.

Legacy lead-parameter extraction remains available to non-semantic/internal callers for compatibility, and provider-specific input normalization/validation remains in place. This is not a claim that every regular expression across the repository was removed. Support/inbound-channel agents are separate systems and were not rewritten in this campaign-chat task.

## Real Chrome checks

Campaign: `226`, fictional Codex QA Demo Co. Existing approved ICP; no selected recipients. Browser: actual Google Chrome. Local QA API disables cron startup and embedded media workers. Chat/model calls consume AI credits. No scrape, generation execution, outbound send, schedule dispatch or publication was approved.

| Case | Prompt / observed result | Outcome |
|---|---|---|
| Paraphrased status with specialist mention | `@marcus What is still waiting on me here? Just inspect the saved state; leave everything untouched.` Coordinator queried the ledger: 70/71/73 active; 72/74 succeeded. Unlike the earlier failure, review 74 was not described as pending. | Pass |
| Multilingual channel negation | `@marcus Yelp வேண்டாம். Google Maps வழிகளை மட்டும் காட்டுங்கள். தேடலைத் தொடங்காதீர்கள்; கிடைக்கும் workflow பட்டியல் மட்டும் வேண்டும்.` Only Google Maps Business Search appeared, with no Yelp and no search execution. Catalog descriptions remain stored English text. | Pass for intent/routing |
| Outreach paraphrase | `For the people already chosen in this campaign, could Emily get an email sequence ready for me to look over? Nothing should go out, and do not pick people from elsewhere.` Routed to Emily, then stopped at missing campaign recipients. No account-wide recipients were selected. | Pass |
| Pending-review revision | `@alex Review #71 is still only a draft card. Could you tighten that LinkedIn wording and keep the CTA exactly "Book a demo"? Words only, with neither pictures nor clips. Show the revised review; do not generate, publish or schedule it.` Prepared review 75 through social-post generation review, not saved-asset editing. Exact CTA and both media-off settings were preserved. | Routing/media/CTA pass; length issue below |

### Discovered length regression

The first revised review (75) displayed Medium despite the original review (71) being Short. Added length to the semantic generation contract and current saved-review context, with saved-length/CTA inheritance. This was insufficient: the Chrome retest created review 76 with Medium again.

Exact retest: `@alex Please revise review #71 again: preserve its existing length, text-only format, and exact CTA "Book a demo". Tighten the wording only. Prepare the revised card without executing, publishing, or scheduling it.` No card was executed.

A tenant-scoped database read confirmed review 71 stores `length=short`. A read-only live-model diagnostic then identified the actual remaining cause: the model returned `generation.length=medium` even for preservation, overriding the correct saved default. The semantic contract now distinguishes `lengthIntent=preserve|set|unspecified`; replacing a saved length requires `set`. Preserve, unspecified and legacy missing intent cannot override a saved length with a model default. Added three regression cases alongside explicit-change coverage. This remains model-derived intent, not another prose/regex fallback.

Chrome transport disconnected before the final post-correction UI retest. Review 76 remains a failed historical case, not a claimed pass. The live-model diagnostic below does not substitute for end-to-end browser verification.

Post-correction diagnostic at 14:06 IST used the configured live model and owned campaign 226 state, without creating or executing a review. It selected review 71, `lengthIntent=preserve`, `length=null`, text-only format and exact CTA `Book a demo`. Applying the production constraint function to the saved review preserved `length=short` and both media flags false. **Pass for live classification plus saved-default enforcement; final browser-card retest outstanding.**

## Final automated verification

- Server: **19 suites / 304 tests passed**, covering semantic routing/fallback, controller status/clarification, multi-message state, content/ad constraints, review management, approval gates, analytics scope and lead constraints/persistence.
- Client: **3 files / 28 tests passed** (`analyticsQueryScope`, `structuredAnalyticsTab`, `widgetRegistrySmoke`).
- Server and client TypeScript checks passed; the server check was repeated after the final length-intent change.
- `git diff --check` passed.

The testing skill's multi-message/browser workflow guided the checks. Its separate test helper was unavailable, so Chrome was driven directly. That live verification exposed the length-preservation defect that mocked routing tests alone had not caught.

## Verification boundaries

Unit tests with mocked model output verify schema, state transitions, tool constraints and safety gates; they do not establish the live model's language accuracy by themselves. Chrome cases above use the configured live model. No guarantee of perfect interpretation for arbitrary language, every tool, or unavailable providers is implied. Actual provider-success coverage remains separate from intent routing.

New changes remain local/uncommitted. Existing unrelated workspace edits were preserved.
