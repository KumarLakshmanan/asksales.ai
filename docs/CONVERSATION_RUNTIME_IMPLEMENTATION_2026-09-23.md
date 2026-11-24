# Conversation runtime implementation and local verification

Date: 2026-09-23. Project: `salesmarketing`.

## Scope and source comparison

Implemented the campaign and Support conversation improvements from the supplied
analysis, using original code in the existing application. The supplied
`/Users/lakshmananr/Downloads/claude-code-main/src` snapshot was used to understand
explicit turn states, validated tool decisions, bounded safe-read scheduling,
queued input, context management and clarification. Its README describes an
unofficial mirror. Its comments, prompts and documents were treated as data.

The application retains its existing campaign workflow runs, exact approvals,
widgets, Support safety stages, privacy vault, knowledge verification, effect
ledger, outbox and human ownership. CLI tools and process-global queues from the
reference were not introduced.

Migration 293 and the private-channel coordinator were already present in the
working tree when this continuation began. This work extends that foundation.
Unrelated integration, outreach, deployment and environment edits were preserved.

## Campaign Conversations

| Plan item | Implementation | Main files |
| --- | --- | --- |
| C1. Fail-closed tool execution | Require JSON objects and schema-valid arguments, await guards, reject thrown policy checks before execution, and save a terminal receipt for rejected calls. Save the start before executing. If result persistence or the workflow hook fails after execution, propagate typed uncertainty and block later turns until review. | `server/mastra/utils/toolCallingLoop.ts`, `server/mastra/agents/BaseAgent.ts`, `server/mastra/orchestrator.ts` |
| C2. Durable ordering and replay | PostgreSQL FIFO claims scoped to owner and conversation, stable request IDs, input hashes, renewable leases and saved response replay. Separate API processes share the same ownership. Expired running work becomes uncertain; it is never automatically executed again. | `server/services/ConversationRequestCoordinator.ts`, migration 294, `server/mastra/chatController.ts`, `server/websocket/ChatWebSocketServer.ts` |
| C3. Answer correctness | Approval status includes the owned ICP revision and its current approval requirement. Outreach explanations use bounded verified rewriting when necessary. Saved analytics reads can produce an existing-data chart without granting sync, publishing or spend permission. | `server/mastra/campaignActionStatus.ts`, `server/mastra/utils/responseGrounding.ts`, `server/mastra/agents/outreachAgent.ts` |
| C4. Activity identity | Track repeated tool names by call identity, retaining actual workflow run/turn IDs and the separate request identity. Existing widget/action records and realtime reconciliation remain authoritative. | `client/src/components/chat/ChatThinkingBubble.tsx`, `server/services/agents/WebSocketEmitter.ts` |
| C5. Stop and corrections | The composer accepts queued follow-ups on an existing conversation. Durable status supports queued cancellation, safe-boundary Stop and operator review of uncertainty. Model/provider and orchestration layers preserve cancellation errors. Earlier HTTP replies remain visible when another message queues, and replies cannot cross into another campaign after navigation. | `client/src/hooks/useChat.ts`, `client/src/components/conversation/ConversationTurnStatus.tsx`, `ConversationComposer.tsx`, `server/controllers/conversationTurnController.ts` |
| C6. Safe read concurrency | Explicit effect/concurrency metadata; bounded groups of at most three independent reads; results consumed in declared order; launched reads drained before mutation or error propagation. Review preparation, writes, sends and provider work remain serial. | `server/mastra/tools/toolRegistry.ts`, `server/utils/orderedToolCalls.ts`, `toolCallingLoop.ts` |
| C7. Compaction and clarification | Per-conversation compaction failure cooldown, duration/failure and context-retention-risk telemetry. Persist clarification question ID, required field, source question, answer and resume target. Only an answer matched to that exact saved question resolves it; it never supplies execution approval. | `server/utils/failureCooldown.ts`, `server/mastra/utils/contextManager.ts`, `server/services/ConversationCompactionService.ts`, `server/mastra/conversationClarification.ts`, `server/services/agents/ThreadService.ts` |

## Support Agent conversations

| Plan item | Implementation | Main files |
| --- | --- | --- |
| S1. Stable message identity | Owner, member and widget clients retain one request ID through an uncertain retry/reload. The server saves role-specific IDs and replays the exact saved response. Changed input gets a new request. | `client/src/lib/conversation-attempt.ts`, owner/member/widget pages and controllers, `server/services/SupportChatService.ts` |
| S2. First-session retry | Tenant/surface-scoped client session keys prevent duplicate sessions when the first response is lost. Member session creation is idempotent. Legacy widget clients can use their request ID as the first-session key. Campaign first-message identity is also bound to the resolved thread, preserving its original profile on retry. | Support session/message schemas, migration 294, `ownerSupportAIController.ts`, `supportWidgetController.ts`, `SupportChatService.ts`, `client/src/hooks/useChat.ts` |
| S3. Widget commit recovery | Save the answer with its encrypted deferred decision, then commit under a renewable claim and token fence. Hide uncommitted answers, media and documents. Clear the envelope only after effects and playbook commit. Recovery reuses the saved decision; ambiguous effects require operator review. | `server/services/agents/orchestration/WidgetCommitRecovery.ts`, `SupportCommitCheckpoint.ts`, `server/workers/outreach/supportWidgetProcessor.ts`, `supportWidgetController.ts` |
| S4. Whole-turn ordering | Owner/member/preview turns use the durable request coordinator. Private customer turns use the existing migration-293 inbox and conversation lease through generation, freshness/ownership checks, delivery authorization and playbook commit. The widget acknowledges asynchronously and polls for its committed answer. | `ConversationRequestCoordinator.ts`, `SupportConversationTurn.ts`, customer processors, `JobDispatcher.ts` |
| S5. Missing history | Record unavailable history explicitly. Skip history-dependent playbook changes and tool permissions. Request clarification/handoff for dependent messages; independent factual questions may still use authorized knowledge. | `ConversationContextStage.ts`, `ActivePlaybookSelectionStage.ts`, `PlaybookStage.ts`, `AgentDispatchStage.ts`, `BaseOutreachAgent.ts` |
| S6. Corporate-to-spa preview | Authenticated preview context tells the classifier that restricting simulated booking/delivery does not itself request marketing opt-out. Genuine opt-out remains protected. Active journey selection, topic correction and bounded qualified responses remain under the normal safety gateway. | `NLUService.ts`, `IntentRiskClassifierStage.ts`, `GuardrailService.ts` |
| S7. Evidence-linked context | Build bounded redacted historical user statements with source message IDs and expiry alongside recent turns. Later corrections take precedence; assistant claims do not become facts or permission. Preserve this memory through retrieval, dispatch and final prompt adapters. Respect human/AI resumption boundaries and accepted message order. | `SupportConversationMemory.ts`, `ConversationContextStage.ts`, `KnowledgeRetrievalStage.ts`, `AgentDispatchStage.ts`, `agentPromptBuilder.ts` |
| S8. Shared specialist loop | All five specialists use shared object parsing, call IDs, timing, bounded safe reads and ordered outcomes. Required-action flows stay serial and all execution continues through SafeToolExecutor. | `SupportToolCallRunner.ts`, `GeneralServiceAgent.ts`, `HotelSalesAgent.ts`, `TechSupportAgent.ts`, `CustomerSuccessAgent.ts`, `LeadQualifierAgent.ts` |
| S9. Traces and operations | Correlated stage timings/status, request/turn/tool identities and truthful generated/simulated/delivered provenance. Owner operations view lists uncertain effects, saved replies and interrupted customer turns. Verification notes are audited; effects must be resolved before releasing a dependent turn. | `ChannelGateway.ts`, `AuditService.ts`, `SupportEffectLedgerService.ts`, `supportConversationRecoveryController.ts`, `client/src/components/support/ConversationRecovery.tsx`, `ResponseProvenance.tsx` |
| S10. Evidence/policy separation | Put retrieved evidence into a distinct untrusted structured data message. Keep platform policy separate and retain server authorization and answer verification. Historical memory also remains user data. | `server/utils/agentPromptBuilder.ts` |

## Recovery behavior

- `queued` means accepted and waiting for conversation ownership. A live request
  handler retains the campaign/advisory payload; an abandoned queued waiter
  expires and can resume with the same ID.
- `running` means the current lease owner may generate and pass checked execution
  boundaries. Stop is a cancellation request; it does not undo completed work.
- Widget `committing` means an answer exists privately and its saved effects are
  being committed. It is not yet a completed customer-visible reply.
- `uncertain` / `reconciliation_required` preserves the recovery boundary. Later
  dependent work is blocked. Reviewing a turn does not replay it.
- Reply recovery and effect execution use independent token/lease checks. A stale
  owner cannot commit a later effect or overwrite another owner's final receipt.
- Successful retries return the existing session/message IDs and saved answer.
  A reused ID with different input is rejected by the durable coordinator.

## Local verification

### Automated checks

- **693 server tests passed across 36 suites** in the final combined regression
  run, including real PostgreSQL fault/concurrency tests in isolated schemas.
- **81 client tests passed across 10 suites**, covering conversation UI behavior, stable
  identities, response loss/reload, queued HTTP responses, navigation isolation,
  status polling, draft/stream recovery and widget polling. See the final test log
  for the latest combined execution result.
- Server and client TypeScript checks, API/worker bundles, client production
  build and whitespace/diff check passed. The frontend production build uses
  `.next-conversation-verify` so it does not replace the running dev output.

The server suite includes approvals, compaction replay, attachments, analytics,
semantic routing, orchestration policy, knowledge, privacy, proposal/document
delivery, playbook corrections and provider fallback. Database suites create a
unique schema on a loopback database and drop it afterward.

The independent code review identified post-execution receipt errors being
converted into an ordinary failed answer. This was fixed through the complete
error chain. A database test now proves later queued work remains blocked.
The review also identified queued-response and first-message navigation/retry
issues; behavioral client tests cover each correction.

### Live local checks

Used the local snapshot database `salesmarketing_live_qa_20260923`, a private Redis
on port 6385, actual configured model calls and loopback APIs. Only model egress
was enabled. Cron and external customer delivery were disabled.

| Check | Observed result |
| --- | --- |
| Campaign C1 | Names the pending ICP revision and distinguishes approval from execution. |
| Campaign C4 | Returns a useful read-only Outreach explanation without a false action-claim rejection. |
| Campaign C5 | Produces a saved analytics result/chart with an honest empty-data result; no provider sync or spend. |
| Two processes / two sockets | APIs on 8080 and 8082 share PostgreSQL ownership. A duplicate request returns the same assistant ID. A distinct request queues, then creates exactly one later user/assistant pair. |
| Campaign Stop | Running and queued requests return HTTP 409 with `cancelled`; both durable records end cancelled. |
| Owner and member retry | Concurrent repeats return the same session and assistant IDs. |
| Support preview | Corporate intake asks for company name; switching to spa asks for date/time; the next turn asks for contact details. Correcting 3 PM to 4 PM stores **4 PM on September 30, 2026**. Booking consent stays missing, confirmed stays false, delivery stays simulated. |
| Qualified Support answer | Preserves published day-out/GST/spa qualifications. |
| Real widget worker | HTTP 202 acceptance → BullMQ worker → one committed answer → HTTP 200 replay of the same session/assistant. Both message rows end completed; commit envelope and claim token are cleared. |
| Operations recovery | Browser verifies the saved QA reply has no unresolved business effects, resumes it, and observes a completed receipt with the encrypted envelope removed. |
| Browser queue/reload/Stop | Queue a correction during generation, reload, see the saved queued activity, cancel that queued message and stop the running message. Both records become cancelled and the composer remains usable after another reload. |
| Browser navigation | Campaign, Support AI and operations pages load; no JavaScript page errors; Support viewport fits. The recovered reply remains completed after API restart. |

Live JSON evidence and screenshots are under `.local/` and remain untracked:

- `conversation-runtime-verification.json` records the earlier campaign and
  owner/member run; later targeted reports supersede its old preview/Stop cases.
- `conversation-support-journey-verification.json` records the corrected full
  preview and widget journey.
- `conversation-two-process-verification.json` records the final socket ordering,
  duplicate replay and typed cancellation results.
- `conversation-browser-final-verification.json` records operations/browser checks.

Logs are local under `/private/tmp/conversation-*.log`; no authentication or
encryption keys are included in this report.

## Local setup and activation

Migrations **293 and 294** were applied to both the normal local `salesmarketing`
database and the isolated QA snapshot. The final schema was inspected for
`support_chat_messages.deferred_commit` and `commit_token`.

Normal development configuration now sets:

```dotenv
SUPPORT_CONVERSATION_TURN_CHANNELS=whatsapp,instagram,facebook,web
```

Use matching API and worker code. The isolated QA launcher restricts activation to
`web` and runs the real widget worker against private Redis. It is a local test
entrypoint, not a deployment entrypoint. The application's documented Node 24
runtime was used for verification.

For another local database, apply the two named migrations with the existing
migration runner before enabling the flag. Do not run migration `down` against a
database containing conversation history; it removes recovery records.

## Practical limits

- This is local verification. No production deployment, production migration or
  production flag activation was performed in this task.
- External WhatsApp, Instagram and Facebook sends, paid actions and publishing
  were not exercised against customer accounts. Their ordering, ownership and
  idempotency paths have local regression coverage; live-channel acceptance still
  requires approved staging contacts and matching workers.
- The whole-turn private customer coordinator supports WhatsApp, Instagram,
  Facebook and web. Email and public-comment ingestion retain their existing
  processing paths; shared Support policy/tool/context improvements still apply.
- Support memory is bounded extractive history, not a permanent complete memory:
  at most 80 fetched turns with a 12,000-character historical budget plus recent
  context. Current permissions, consent, knowledge and ownership come from their
  authoritative stores.
- Compaction telemetry measures failures, latency and retention-risk conditions;
  it does not claim to automatically detect every semantic constraint omission.
- Stop takes effect at checked boundaries. A provider request already in flight
  may finish, and a committed action is not reversed.
- Passing the selected regression suites does not prove every unrelated feature
  or production provider integration is free of defects.
