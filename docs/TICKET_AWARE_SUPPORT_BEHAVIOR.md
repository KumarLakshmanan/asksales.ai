# Ticket-aware support behavior

AskSales keeps the support ticket as the ownership authority across WhatsApp,
email, Instagram DMs, Facebook Messenger, and web chat.

While a ticket-backed handoff is active:

- The conversation remains human-owned. A low-risk greeting, FAQ, or small-talk
  question may receive one grounded, latest-question-only AI answer.
- That bounded answer cannot execute tools, create effects, advance a playbook,
  update CRM state, schedule follow-ups, or create another ticket or handoff.
- Booking, payment, account-changing, complaint-resolution, approval-requiring,
  and ticket-related messages stay in the existing human queue. Later messages
  update the active handoff instead of being silently ignored.
- The decision audit records `read_only_ai` for a verified bounded answer and
  `human_queue` when the message remains with the operator. Neither disposition
  means that AI ownership resumed.
- Resolving a ticket keeps the conversation human-owned unless the operator
  explicitly selects **Resume AI after resolution**. The resolution writes an
  `ownershipResolution` audit marker to both the source conversation and the
  ticket. A later inbound message honors a recorded `human_retained` outcome,
  remains effect-free, and receives a deterministic human-queue acknowledgement;
  it cannot be mistaken for a stale legacy ownership flag and reactivate AI.

## Channel capability differences

WhatsApp, Instagram DMs, and Facebook Messenger send through the shared durable
delivery outbox. Provider message IDs, retries, and uncertain outcomes remain
attached to the idempotent delivery action; ambiguous provider calls are not
blindly resent.

Email uses its threaded sender and email ledger after the shared pipeline returns
an approved draft. Web chat persists the approved reply to the authenticated
widget session. Both channels acknowledge delivery before deferred business
effects can run, and ticket-aware replies carry the suppression boundary through
that acknowledgement.

Public Instagram, Facebook, and Threads comments are not support-ticket DM
channels. Their public/private reply rules remain separate and are not represented
as equivalent to the five supported customer-conversation channels above.
