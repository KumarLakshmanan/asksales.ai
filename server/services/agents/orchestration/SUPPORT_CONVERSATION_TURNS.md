# Coordinated private support turns

## Release status

Implemented locally, opt-in. Migrations 293/294 and matching API/worker code must be
released together before enabling this. Production has not been enabled by this
change. Email and public comments keep their existing processing paths.

Set `SUPPORT_CONVERSATION_TURN_CHANNELS=whatsapp,instagram,facebook,web` on both
the API and every worker only after the staging checks below. Empty/unset keeps
the previous behavior. Do not mix old workers with enabled API instances.

## Behavior

- Store each original inbound message in its existing CRM/widget history.
- Reserve a redacted durable inbox entry immediately after message persistence,
  then mark it ready after privacy/attachment preparation, before worker enqueue.
  Later messages cannot overtake an earlier reserved message still preparing.
- Acquire one renewable PostgreSQL lease per tenant/channel/account/conversation.
  Webchat uses its authenticated session, represented by a negative conversation ID.
- Immediately process all currently pending messages in their persisted order.
  There is no debounce timer or intentional wait for the customer to stop typing.
- If another message arrives during generation, discard the unsent draft,
  restore the uncommitted playbook proposal, and regenerate from the combined input.
- Recheck freshness, ownership and not-yet-prepared newer messages before the
  first delivery/effect authorization. After authorization, finish recording the
  real outcome; subsequent input becomes the next turn. Already authorized/sent
  messages cannot be recalled.
- Commit a playbook transition only for the current authorized turn. A completed
  journey retains its facts for follow-up questions; an explicit new actionable
  request can start another journey. This is not a new inactivity/session policy.
- Conflicting fragment-level answers are not guessed. Bare numeric responses
  cannot fill an automatically traversed downstream question. Contact fields
  retain the original message's restricted-vault reference.
- Webchat acknowledges with HTTP 202 and a nullable assistant message. The widget
  stays usable while polling for the actual reply. The iframe embed uses the same UI.
- Outbox retries share conversation ownership, and stale retries are suppressed
  after newer customer input or changed human/AI ownership.

## Failure and recovery

Unsealed failed/crashed attempts retain their inbox inputs and restore their
durable playbook baseline on retry. The support maintenance job re-enqueues
pending, unleased conversations older than one minute. This recovery interval is
not an inbound debounce delay.

Once an external effect may have started, a crash/failure is marked `uncertain`.
Automatic replay is deliberately blocked, including after lease expiry. Inspect
the matching delivery outbox, tool/effect ledger and provider receipts before
reconciling it; do not blindly reset or resend it. The owner's Outreach
Orchestration settings now include conversation and saved-reply recovery. Verify
effects first, resume/discard saved widget replies, then record a reviewed turn.
Required verification notes are audited. A turn cannot be released while its
reply or effects remain unresolved.

Widget replies are saved with an encrypted deferred decision and a private
`committing` status. A renewable token-fenced claim finishes the saved effects;
only `completed` replies are exposed as successful replay. Recovery never asks
the model to regenerate that reply. Migration 294 includes both `deferred_commit`
and `commit_token`; verify the final schema before enabling workers.

Reservations that never finish privacy/attachment preparation remain unready and
are not converted to ready by maintenance. Investigate the inbound preparation
failure before retrying; a queue wake-up must not bypass that safety boundary.

More than 100 pending inputs or 100,000 characters require operator review; input
is not silently truncated. Inbox text is redacted, but tenant data-retention and
conversation-erasure procedures must include these new derived tables.

Before disabling the flag, stop ingress and drain/reconcile coordinated work and
outbox retries. Disabling it with work in flight would allow legacy jobs to bypass
the conversation lease. Keep the additive tables during rollback; migration
`down` deletes coordination history and is for isolated QA only.

## Local verification

Verified on 2026-09-23: the combined conversation runtime regression run passed
693 server tests across 36 suites. Client coverage includes stable request IDs,
reload/retry, queued responses, status, navigation and widget polling. A real local
BullMQ widget turn returned HTTP 202, committed one answer, then replayed the same
saved answer; browser recovery also completed an interrupted QA reply. Two local
API processes verified campaign FIFO/replay/Stop. See
`docs/CONVERSATION_RUNTIME_IMPLEMENTATION_2026-09-23.md` for detailed evidence and
limits. No live provider sends or production migration/flag activation were
performed for this patch.

The PostgreSQL suite requires a **loopback** database via
`SUPPORT_TURN_QA_DATABASE_URL`. It creates and drops a unique isolated schema,
uses independent pooled connections, and does not modify application tables.

```sh
cd server
SUPPORT_TURN_QA_DATABASE_URL=postgresql://localhost/postgres \
  NODE_OPTIONS=--experimental-vm-modules \
  node node_modules/jest/bin/jest.js --runInBand \
  tests/supportConversationTurnsPostgres.test.ts \
  tests/supportTurnFieldCollection.test.ts
```

Coverage includes all four channels, duplicate events, out-of-order preparation,
concurrent owners, stale drafts, unregistered newer inputs, human takeover,
tenant/account isolation, uncertain effects, retry leases, durable crash recovery,
active-playbook uniqueness, transition fencing and completed-journey continuation.
`client/src/__tests__/widgetSessionRecovery.test.tsx` covers queued responses and
sending another message while the prior turn is processing.

## Staging acceptance before production activation

1. Apply migrations 293 and 294 with the existing migration runner. Deploy matching API,
   worker and widget assets with the flag initially empty.
2. Enable the four channels in the isolated staging environment; use only approved
   test contacts. Run at least two worker processes.
3. Send `2 adults and 2 kids`, then `Kids 1 year and 7 years` while generation is
   running. Verify one coherent reply and both originals in history.
4. Answer the room-count prompt with `1`, then `No preference`. Verify retained
   dates/occupancy and no unsolicited fresh check-in question after completion.
5. Test a message during generation, a message after dispatch authorization, human
   takeover, duplicate webhook delivery and a worker interruption.
6. Verify webchat HTTP 202, polling, refresh/recovery, document downloads and no
   duplicate assistant bubbles. Recheck brochure/proposal receipts and follow-up
   scheduling on approved test accounts.
7. Inspect pending/uncertain turns and provider receipts. Only enable production
   channels after these end-to-end checks pass. Local suites do not prove live
   Meta delivery, Redis recovery or deployment configuration.
