# Support customer-flow corrections — 19 September 2026

## Confirmed production causes

- Conversation 444 / audit 1482: `knowledgeRetrievalStatus=sufficient`, but four generated claims failed deterministic grounding. Handoff 272 was created with `unsupported_customer_factual_claim`. A successful `answer_from_knowledge_base` call unnecessarily excluded both verified-fact and extractive FAQ recovery.
- Conversation 447 / audit 1480: NLU correctly identified `pricing_question`, but the pending `collect-stay` step returned only a reworded check-in question.
- Conversation 433: repeated explicit “27th sept check in” / “Check out will b 28th sept” messages failed date collection. The date-expression guard supported Sep/September but omitted Sept; normalization also relied on model entities.

## Changes

- Canonical KB-tool output now uses individual authorized knowledge excerpts for claim verification, not serialized tool JSON. Successful read-only KB calls allow low-risk FAQ recovery. Arbitrary tools, effects and transactional claims remain excluded. Extractive recovery revalidates published evidence before delivery.
- Pricing interruptions during stay collection acknowledge the pricing request, explain that a quote has not yet been checked, and offer the configured, validated public booking search page when external booking mode is enabled. No date, occupancy, identity or promo values are invented.
- Explicit ISO, named-month/ordinal (including Sept), today/tomorrow/day-after-tomorrow dates are parsed directly. Labelled checkout supplied first is not assigned to check-in. Impossible dates and vague text are not guessed. Existing keyed NLU range/other-date extraction remains available.
- Collection replies acknowledge validated trip dates and guest counts. Governed wording receives privacy-processed current intent/message/sentiment for tone; deterministic field semantics and option IDs remain authoritative.
- At the hospitality booking-contact step, a hydrated contact name is offered for confirmation instead of silently reused. WhatsApp wording identifies the saved WhatsApp/contact name. Yes confirms only that booking name; No requests a replacement. `Name: ...` accepts a vault-bound replacement for this booking without silently overwriting the CRM identity. Rejected names are not rehydrated on the next turn. Checkout consent remains separate.
- Preview diagnostic script supports bounded multi-turn replay with a synthetic known-profile fixture, negative conversation IDs and `dryRun=true` throughout.

## Verification and scope

- Core code commit: `b60da4e3a`; live-replay follow-up: `36f0cbaed`.
- Focused suite: 143 tests passed, including the exact reported date phrases, price dispatch, read-only KB-tool recovery, contradictory/transactional evidence boundaries, and name confirmation/replacement/decline.
- Final broad support regression: 78 suites / 1,031 tests passed; 64 tests and three opt-in suites skipped. This run includes the final stale-pricing-label guard.
- Scoped lint: no errors (four pre-existing `any` warnings in the existing journey test file). Local API bundle succeeded. Full server typecheck still reports unrelated pre-existing errors; no changed runtime-file errors were reported.
- No messages were sent to the three actual customer conversations during diagnosis or verification. Existing handoff 272 was not closed or reassigned. No booking, payment or customer-profile mutation was made by QA.

## Live rollout

- Core deployment completed with API/client/Hermes HTTP 200 and both workers running. No migrations were added by this change.
- A candidate-image replay against the live OpenRouter provider and published tenant evidence returned a grounded resort overview. The verifier removed two unsupported additions using `verified_facts_only`; there was no simulated handoff.
- A multi-turn candidate-image replay accepted “I have already mentioned 27th sept check in” and “Check out will b 28th sept”, advanced to adults/children/rooms, and retained 2026-09-27 / 2026-09-28. It caught an additional issue: the NLU pricing label persisted into numeric/date answers. `36f0cbaed` additionally requires price/rate/cost wording in the current message before repeating pricing guidance or its booking link.
- A known-profile replay progressed through live read-only availability, room selection and booking intent. It showed the WhatsApp/contact-name confirmation, accepted No, accepted a synthetic replacement name, and presented a freshly verified booking summary requiring separate consent. No reservation or customer profile was changed.
- Final `36f0cbaed` deployment completed: API/client/Hermes HTTP 200, both workers running, Nginx validation passed, 268 applied migrations and zero pending. Backup: `/var/backups/asksales/predeploy-20260919T035802Z.dump`.
- Final candidate-image replay acknowledged pricing once, then replied “Thanks — I have your check-in as 2026-09-27,” “I have your stay as 2026-09-27 to 2026-09-28,” and “Got it — 2 adults,” advancing to the next missing field without repeating the pricing introduction or link.
- Chrome customer-preview returned resort details with High grounding and three sources, without a handoff. On the final deployment it acknowledged the price request and displayed the approved booking search URL.
- Final Chrome multi-turn check then accepted “I have already mentioned 27th sept check in. Check out will b 28th sept” and replied “I have your stay as 2026-09-27 to 2026-09-28. How many adults will be staying?” No repeated date question or repeated pricing introduction appeared.
- Scoped repair of conversation 433 / run 116 restored only check-in 2026-09-27 and checkout 2026-09-28 from customer message 3696. A transaction checked that the run was still active at `collect-stay`, both fields were missing, and latest message ID remained 3697. Previous field values and the source message ID are retained in `state.dateFieldRecovery`. A follow-up read confirmed both dates; the node did not advance. No outbound message, booking or consent was created. Handoff 272 remains waiting and was not modified.
