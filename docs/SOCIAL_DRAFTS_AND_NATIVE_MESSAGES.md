# Social drafts and native sent messages

WhatsApp, Instagram and Facebook keep ingesting inbound messages/comments when automatic replies are disabled. The configured AI pipeline generates approved replies, while the delivery outbox persists terminal `drafted` decisions and linked `outreach_messages.status = 'draft'` rows. Permitted business effects use their existing execution/effect ledgers. Drafting does not commit delivery-dependent playbook transitions. Email and web chat retain their reply controls.

Each grouped conversation turn and response part has a stable delivery decision. Subsequent turns append drafts. Re-enabling replies does not release earlier drafts; sending, editing and discarding remain individual manual actions. Public replies retain their comment target. Private follow-ups and assets are separate message drafts.

Native outbound events never enqueue a send or AI response and do not change unread counts or takeover state. They use the connected account, recipient and provider ID for reconciliation; echoes racing API confirmation adopt the existing send. Provider timestamps order actual messages; creation timestamps order drafts. Unsent drafts and deleted messages are excluded from subsequent social AI context.

## Deployment order

1. Apply migration `307_social_reply_drafts.js` through the existing migration runner before releasing API and workers. It adds the mixed-timeline pagination index and replaces the legacy global WhatsApp provider-ID constraint with an account-scoped unique index, creating the new index before retiring the old constraint. It is safe to run twice and preserves message data. No historical import is performed.
2. Release API and workers together. Keep the existing `SUPPORT_CONVERSATION_TURN_CHANNELS` configuration and permissions/takeover controls.
3. Run the subscription checker against the intended environment, first without changes:

   ```sh
   cd server
   pnpm exec tsx scripts/check-social-echo-subscriptions.ts
   # Limit the check to an owner if needed:
   pnpm exec tsx scripts/check-social-echo-subscriptions.ts --user-id=123
   # Repair missing account subscriptions idempotently:
   pnpm exec tsx scripts/check-social-echo-subscriptions.ts --user-id=123 --apply
   ```

   In the deployed API image, use `node server/dist/check-social-echo-subscriptions.js` from `/app` (with the same optional flags).

   Instagram/Facebook require `messages` and `message_echoes`. Repairs preserve other subscribed fields. Permission/token failures are reported as `unverified`; missing subscriptions are `action_required`. The command exits nonzero if any connection remains unverified. WhatsApp requires the app-level `whatsapp_business_account.smb_message_echoes` subscription plus an active Business App/API coexistence connection. The checker reports that subscription; missing app-level subscriptions must be enabled in Meta App Dashboard. `--apply` does not change app-level callback configuration.
4. Verify a new native text and attachment event from each connected account, with automatic replies disabled. Confirm one outbound message in the correct conversation/account, its original send time, unchanged ownership/unread counts, and no send charge. A subscription check alone does not establish end-to-end synchronization.
5. Send an inbound burst, then a later turn. Confirm both draft sets survive refresh and older-page loading. Confirm there are zero customer-message API calls while disabled. Manually send a public-comment draft and verify its saved comment target using a test account.

## Operational checks

Use the existing webhook error logs, worker failures, `support_delivery_outbox`, and `agent_audit_logs.delivery_status`. Investigate draft-persistence errors before retrying a worker. `drafted` outbox rows must have no retry schedule or provider receipt. A manually sent draft may legitimately retain its original terminal drafted action; its message now has a separate, explicit send intent.

Look for duplicate provider identities within a business profile, channel, and account, never across all accounts globally. Track webhook ingestion errors, unexpected `uncertain` delivery states, missing media records, and changes in draft volume. Unavailable media is represented explicitly rather than silently omitted. Deleted native attachments become unavailable through the normal attachment authorization service.

The check/repair command never sends messages. Automated tests use disposable local PostgreSQL schemas and mocked provider sends. Live account subscription checks and live delivery verification are environment-specific rollout steps.

## Local validation (2026-09-28)

- 17 backend suites passed, covering 242 tests. The PostgreSQL draft, conversation-turn, and settings suites ran against disposable local schemas; the migration was applied twice to verify repeatability.
- Five client suites passed (41 tests), including draft pagination, individual draft actions, timestamp ordering, and source labels.
- The social inbox browser scenario passed on desktop Chromium and mobile Chromium for WhatsApp, Instagram, and Facebook, including older-page loading and reloads.
- Backend type checking and both API/worker builds passed. Client source type checking passed against the isolated browser build. The ordinary client type check encountered invalid generated files in the shared `.next/dev/types` cache; that unrelated cache was left untouched. An earlier broader client test run also encountered existing `outreachPagination` URL expectations for trailing `&` characters in the untouched `useOutreachPage` hook.
- The read-only subscription checker was attempted but startup was blocked by the configured database's missing `299_business_profile_isolation` prerequisite. No live subscription repair, deployment, historical import, or customer-message send was performed. Complete the rollout and live checks above before claiming account synchronization is operational.

Meta reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes/
