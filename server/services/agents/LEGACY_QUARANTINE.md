# Support-agent legacy quarantine

The support runtime is `AgentRouter -> ChannelGateway -> one active specialist`.
Mastra sales/marketing assistants, tool approvals, workflow execution records,
and Hotel compatibility methods covered by tests are active and are not part of
this quarantine.

These tracked candidates have no support-runtime callers beyond the explicitly
allowed schema aggregators recorded by `pnpm support:architecture:audit`:

- `server/agents/AgentDecision.ts`
- `server/agents/index.ts`
- `server/models/agents/schema.ts` and `functions.ts`
- `server/models/subAgentConfigs/schema.ts`
- `server/services/RAGFAQResponder.ts`
- `server/services/agents/LeadDeduplicationService.ts`
- `server/services/agents/StreamingService.ts`

They must not receive new imports. Deletion requires one complete release plus
30 days of zero route, job, feature, and database-access telemetry. Historical
migrations and audit records remain permanently. Database tables are retired in
a later migration only after export, backup verification, and a rollback window.
