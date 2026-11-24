# Restricted automatic handoffs — Oro Circle — 19 September 2026

## Requested policy

The owner requested automatic handoff/ticket creation only for refund requests, explicit requests for a person, and very severe customer-relationship situations. Technical failures, booking/checkout failures, completed callback/enquiry forms, safety/privacy failures, and low confidence alone must not create handoffs.

## Implementation

- Opt-in active-agent metadata: `handoffPolicy.mode = customer_requests_only`. Other owners retain their existing policies.
- Load the owner policy before privacy/safety stages. Failure to load it stops processing without creating tickets. Customer-supplied message metadata cannot enable or disable it.
- Enforce eligibility at the gateway halt boundary, at direct handoff enqueue, and at post-delivery enquiry/ticket effects. Deferred web/email effect commits reload the owner policy.
- Explicit human/refund requests have bounded text matching during classifier outages. Classified human/refund intents require classifier confidence >= 0.75; a menu selection alone is not a request for a person.
- Severe relationship cases require complaint intent, negative sentiment <= -0.8, classification confidence >= 0.75 and either high/critical risk with a recognized severe-relationship factor, or both repeated-unresolved-complaint and relationship-breakdown factors. The latter can qualify even when financial/safety risk is labelled medium. Ordinary frustration, low confidence, sensitive content and a generic model `needsHuman` boolean are not sufficient.
- Safety, privacy, evidence verification, approval gates, tool authorization and actual booking/payment controls remain enforced. Failed checks never release the rejected draft or execute its effects. A fixed safe limitation/refusal/clarification replaces an excluded handoff. If failure occurs before channel delivery eligibility is checked, processing stops without sending or creating a ticket. Booking failures can offer the approved public search URL, prefilling collected dates/counts without personal information.
- Completed enquiries/callback preferences remain recorded after successful delivery in conversation metadata and, where a linked CRM contact exists, a CRM activity. They do not create a ticket, notify a support queue, transfer ownership, promise a callback or claim a confirmed booking. Existing tickets remain untouched.
- Explicit approval-required channels and ordinary draft-approval controls remain separate from automatic handoffs.

## Verification

- 59 server suites / 762 tests passed; 8 suites / 97 tests skipped.
- Added tests for excluded triggers, permitted human/refund/severe-complaint triggers, menu consent, tenant isolation, rejected-draft removal, safe booking URL fields, emergency guidance, direct enqueue enforcement, post-delivery enquiry recording and deferred-channel policy reload.
- Scoped runtime lint passed. Full server TypeScript still reports unrelated baseline errors; no errors in changed files.
- Deployment skill used for backup/health verification through the established project deployment script because the Replit-specific helpers are unavailable. Testing skill was inspected; this backend-only change uses Jest and safe pipeline previews, not browser UI tests.

## Owner activation

- Enabled only active hotel-sales config 6 for owner 9 at `2026-09-19T11:33:31.550Z` (17:03 IST).
- Approved booking fallback: `https://bookings.orocircle.com/?propertyId=10955`.
- Previous policy metadata retained in the change receipt. Existing tickets and customer messages were not changed by activation.

## Live verification finding

An initial no-send preview correctly permitted human/refund requests and suppressed technical, safety and availability failures. It exposed an overly strict severe-complaint condition: the classifier recognized repeated unresolved complaints and relationship breakdown with very negative sentiment, but labelled financial/safety risk medium. The policy now treats that combination as severe relationship evidence independently of the general risk label. A regression test covers it; non-severe complaint review also no longer produces an unrelated password/card warning.

## Final release receipt

- Runtime commit: `77168c867` (includes `cac570a6f` and `483dab6ab`); deployed to API and both workers.
- Verified predeploy PostgreSQL backup: `/var/backups/asksales/predeploy-20260919T113824Z.dump`.
- No pending migrations. API, client and Hermes health checks returned HTTP 200; both workers started successfully. Nginx configuration validation passed.
- Six final isolated production previews passed: explicit person request, refund and severe complaint selected `human_handoff`; injected classifier outage, safety rejection and injected availability failure selected safe non-handoff responses.
- Booking failure returned the approved Oro booking search URL without claiming a confirmed booking/payment.
- Preview database check confirmed zero handoff rows for the six synthetic conversation IDs. Customer messages sent: zero. Existing customer tickets were not modified.
- Technical and booking failures were injected only into the isolated preview process; production workers were not fault-injected. Human/refund/complaint scenarios used the configured live classifier.
- Full server TypeScript continues to report pre-existing errors outside changed files (including content calendar, lead executor, AI visibility and unrelated tests). Scoped lint and the 762-test regression run passed.
- Callback/enquiry recording, confidence suppression, early privacy/delivery eligibility, tenant isolation and deferred-channel effect handling were covered by automated tests rather than real customer sends.
