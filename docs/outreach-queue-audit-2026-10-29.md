# Outreach queue audit — 29 October 2026

The shared composer uses persisted `outreach_messages` send intents and BullMQ's
`outreach` queue for WhatsApp, Instagram, Facebook Messenger, email and SMS.
Legacy email/SMS campaigns also have a database-backed `outreach_jobs` poller.
Inbound assistant replies use a separate durable delivery outbox.

## Findings and changes

* Audience selection, bulk admission, campaign execution and delivery correlation
  independently imposed or truncated selections at 500. The audience caps are
  removed. Recipient eligibility lookups still use bounded 200-ID HTTP requests;
  the final review lookup also accepts the full selected audience rather than
  rejecting it at 500. HTTP transport size limits still apply to GET requests.
* Admission previously rejected recipients above the app daily allowance. All
  reviewed recipients now receive durable intents. Dispatch atomically claims
  daily capacity and delays excess work to the next UTC reset. A configured
  zero allowance remains disabled. These app allowances are not Meta's live tier.
* New composer outreach previously expired after one hour. Its reviewed queue
  lifetime is now 30 days, disclosed before confirmation. Existing sends are not
  retroactively extended. Recipient, account, assistant, consent, template version,
  suppression and messaging-window checks still run at dispatch.
* Email already supported provider-directed retry times and exponential backoff.
  New Meta/SMS queue handling now retries explicit transient rejections, honors
  available Retry-After evidence and persists a deadline enforced on replay.
  Network/ambiguous outcomes require reconciliation rather than another send.
* New, explicitly reviewed WhatsApp template outreach opts into at most four
  retries after Meta 131049, waiting at least 24 hours each time. Historical failed
  messages are not reenrolled. Both normal and before-HTTP-ack webhooks are handled.
  The original actor/business/billing authority and exact reviewed payload are
  retained. A DB marker plus deterministic BullMQ identity recovers a lost queue
  acknowledgement. Permanent template/recipient/permission/opt-out failures stop.
* Instagram/Facebook cannot reopen an expired customer messaging window merely by
  waiting a day. Every retry rechecks eligibility. A closed window stops delivery.
* Bulk and retry jobs use priority 10 so inbound assistant jobs can proceed ahead
  of a large marketing batch on the shared queue. Pending provider-retry receipts
  keep their campaign review open until the durable handoff completes.
* Campaign activity now includes a per-channel queue view: accepted, delivered,
  queued, processing, retrying, failed, needs review, next attempt and delay reason.
  Delivered is a subset of accepted; retrying is a subset of queued. Historical
  campaign projections are deduplicated. Queued messages no longer count as
  "sent today" in the daily counter.

## Verification

The WhatsApp adapter now returns a structured pre-HTTP capacity rejection for
the application's per-minute limiter. The queue waits for the Redis TTL on the
same job and message, refunds the unused credit reservation, and does not spend
the provider retry budget. The reviewed queue lifetime still applies.

`node server/dist/recover-whatsapp-app-rate-limits.js --user-id N
--business-profile-id N --message-ids ID,ID` is a dry run by default. `--apply`
marks only the explicit, unstarted legacy app-limit failures with no provider
receipt, preserved opt-in, original authority and live confirmation. Existing
business polling dispatches deterministic recovery jobs using the original send
intents. Repeated recovery or a lost queue acknowledgement cannot create another
message. Delivered, uncertain, provider-rejected and expired records are excluded.

Provider classifiers, 24-hour minimums, retry exhaustion, uncertain outcomes,
575-recipient campaign execution/correlation and composer readiness are tested.
Disposable PostgreSQL tests cover duplicate callbacks, lost acknowledgements,
expiry, original authority, legacy projection deduplication and business isolation.
Production verification must use the deployed queue view and exact import receipt;
this change does not authorize launching the 575-contact draft.

Provider references: [Meta WhatsApp errors](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes),
[Gmail errors and retry guidance](https://developers.google.com/workspace/gmail/api/guides/handle-errors).
Meta's documentation was rate-limited during this audit; the 24-hour marketing
cooldown is a conservative minimum, not a promise of successful delivery.
