---
applyTo: 'server/**'
---

# Server Instructions for GitHub Copilot

Customer delivery gates load `AssistantCatalogService` lazily inside readiness
resolution. Its support-tool/freshness graph must not become a static dependency
of transport gates: async database module initialization otherwise creates a
bundled startup deadlock. Keep configuration/draft routes and infrastructure
health available with assistant runtime off, while every customer dispatch
continues to require fresh exact-assignment and catalog/platform checks.
Run `node --test scripts/tests/customer-delivery-startup.test.mjs` from the
repository root after changing gate imports; it checks separate bundled gate,
API and worker initialization with an async synthetic DB and runtime off.

Normal assistant publication may create a reviewed revision while runtime is
off, after the same configuration, catalog/platform, exact-account, version and
reassignment checks. Publication never enables runtime or releases held work.
Resume and rollback still require runtime. Queue admission and final provider
delivery must continue to enforce runtime and immutable assignment receipts.

Knowledge publication compares conflicts involving the candidate document;
retrieval retains all-pairs conflict checks. Clear previously recorded unrelated
conflict IDs only after complete, nonempty candidate/source comparisons within
the 500-chunk and 200-sentence bounds. Missing or truncated coverage stays blocked
for review. Preserve tenant, scope, privacy, injection and supersession checks.

## Wallet recharge recovery

New recharge orders persist their immutable actor, payer, quote and originating
credential reference before checkout. Return the public key from that captured
credential. Verification authorizes the current billing role and uses one
originating context for HMAC and provider reads; known-origin lookup failures or
identity conflicts never fall back to selected credentials. Only genuinely
unbound legacy orders use the existing compatible current-credential path.
Migration344 must precede the matching API. See `docs/tenant-billing-integrity.md`
for recovery limitations and synthetic PostgreSQL tests. Duplicate claim retries
must recognize wrapped PostgreSQL23505 errors, re-read the same actor/payer claim
and preserve exactly-once crediting.

## Tech Stack Summary
- **Runtime**: Node.js (ESM), TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL + Drizzle ORM (70+ tables)
- **Cache/Queue**: Redis + BullMQ (14 named queues)
- **Events**: Redis Pub/Sub (EventBus)
- **Real-time**: WebSocket (RealtimeGateway)
- **LLM**: OpenAI, Gemini, OpenRouter, Custom AI
- **Agents**: Mastra custom orchestrator with 6 agent types (no external StateGraph)
- **Logging**: Pino structured logger
- **Process Manager**: PM2 (separate worker processes)

## V2 Infrastructure Init Order (in index.ts)
The server initializes this **exact order**:
1. **Redis** → ioredis client (MANDATORY)
2. **EventBus** → Redis Pub/Sub for inter-service events
3. **QueueRegistry** → BullMQ named queues, including AI Visibility audit and monitoring queues
4. **JobDispatcher** → Enqueue jobs to queues
5. **Workers** → BullMQ processors (SEPARATE PM2 PROCESSES ONLY)
6. **RealtimeGateway** → WebSocket at `/api/agents/progress`
7. **CronService** → Scheduled jobs via BullMQ repeatable jobs

**CRITICAL**: Workers run ONLY in separate PM2 processes (`dist/worker-entry.js`), NOT in API server.

## BullMQ Queues
`IMAGE_GENERATION`, `VIDEO_GENERATION`, `WEB_SCRAPING`, `EMAIL_SENDING`, `SMS_SENDING`, `AD_PUBLISHING`, `LEAD_ENRICHMENT`, `CONTENT_GENERATION`, `OUTREACH`, `ANALYTICS`, `FOLLOW_UP`, `EMBEDDING`, `KNOWLEDGE_BASE`, `GENERAL`

AI Visibility additionally uses `AI_VISIBILITY_AUDIT` for durable staged audits
and `AI_VISIBILITY_MONITORING` for the hourly weekly-monitoring sweep. These
remain worker-only. New audits charge the real base cost directly through the
shared wallet and add completed usage once with an audit-scoped idempotency key;
historical reservation-mode audits remain supported for settlement.

## EventBus Pattern (CRITICAL - Single Object Format)
```typescript
// ALWAYS use single object, NOT two args
await eventBus.publish({
  channel: 'events:tool:completed' as any,  // Use EVENT_CHANNELS constants
  userId,
  threadId,
  timestamp: new Date().toISOString(),
  data: { result, status: 'success' }
});

// Event channels: TOOL_STARTED, TOOL_COMPLETED, TOOL_FAILED, AGENT_TRANSITION,
// WORKFLOW_STARTED, WORKFLOW_COMPLETED, OUTREACH_SENT, CONTENT_GENERATED, etc.
```

## LLMProvider Pattern (CRITICAL - No .chat() Method)
```typescript
// NEVER use .chat() - use createChatCompletion or createChatCompletionStream
const response = await provider.createChatCompletion({
  model: provider.defaultModel,
  messages: [...],
  temperature?: number,
  max_tokens?: number,
  loggingContext?: { userId, purpose: 'icp_generation', service: 'ICPGenerationService' }
});
// Response: { success, content?, error?, usage?: { promptTokens, completionTokens, totalTokens } }

// Streaming:
await provider.createChatCompletionStream({
  model: provider.defaultModel,
  messages: [...],
  onChunk: (chunk, sequence) => { /* handler */ },
  onComplete: (fullContent) => { /* final */ }
});
```

## Database Connection Pool (in models/db.ts)
```javascript
max: 10,                              // Connection limit
idleTimeoutMillis: 600000,            // 10 min (DO NOT reduce - causes reconnect storms)
keepAlive: true,
keepAliveInitialDelayMillis: 10000
```

## Controller Pattern
```typescript
export async function getItems(req: Request, res: Response) {
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const items = await db.select().from(itemsTable).where(eq(itemsTable.userId, userId));
    return res.json({ success: true, data: items });
  } catch (error) {
    logger.error({ err: error }, '[getItems] Error message');
    return res.status(500).json({ error: error.message });
  }
}
```

## Job Enqueuing Pattern
```typescript
import { jobDispatcher } from '../queues/JobDispatcher.js';

await jobDispatcher.enqueueImageGeneration({
  userId,
  threadId,
  prompt,
  style,
  correlationId: generateUUID()  // For tool:completed/tool:failed listeners
});
```

## Database Schema Registration
1. Create schema in `server/models/<tableName>/schema.ts`
2. Register in `server/models/allSchemas.ts`:
```typescript
import * as myTable from './myTable/schema.js';
export { myTableTable } from './myTable/schema.js';
// Add to spread at bottom
```

## Logging (Pino)
```typescript
import { logger } from '../utils/logger.js';
logger.info({ userId, action: 'create' }, 'Item created');
logger.error({ err, context: 'jobId' }, 'Job failed');
// First arg: context object; second arg: message string
```

## Auth Middleware
```typescript
import { authenticateToken } from '../middleware/auth.js';
app.post('/api/items', authenticateToken, itemController.create);
// User ID available as: (req as any).user?.id
```

## Routing
- **Modular**: `server/routes/*.ts` for feature-based routes
- **Fallback**: `server/routes.ts` (monolithic ~489 routes)
- **CRM configuration**: `GET` and `PUT /api/crm/configuration` read/write `company_settings.crm_configuration` for the authenticated business owner and selected profile. Validate the complete payload with `crmConfigurationSchema`; lock the profile row before saving and reject removal of stages referenced by contacts, virtual leads, alerts, or automations. Configured stage types and preferences drive pipeline analytics. Support NLU receives this profile's stage catalog and validates semantic stage decisions; `SupportCRMPipeline` reloads configuration at effect commit, preserves closed deals, and requires explicit customer acceptance/rejection or verified tool evidence for Won/Lost. `CRMService.updatePipelineStatus` validates saved keys/names, locks configuration and contact, and commits contact lifecycle, linked lead status, follow-up pausing and labeled activity together. Won maps to contact `won` / lead `converted`; Lost maps to `lost`. Alerts and automations use actual keys and stage types, including custom names. Preserve delivery, preview and effect-ledger gates; engagement scoring must never overwrite CRM lifecycle.
- **CRM platform reporting**: `preferences.platform` now persists as an array; accept original scalar API payloads and normalize scalar saved JSON on read without requiring a migration. Reject empty, duplicate, invalid, and mixed All Platforms selections. Analytics filter both contacts and stage transitions with `EXISTS` and `channel = ANY(...::text[])`, so a contact on multiple selected channels contributes once. Preserve business profile isolation and include matching virtual contacts.
- **CRM workspace APIs**: `CRMWorkspaceService` supplies scoped paginated activities/conversations/tickets, `/contacts/:id/workspace-summary`, `/contacts/:id/timeline`, verified `/contacts/:id/conversations/:conversationId/messages`, `/pipeline/summary`, `/work`, `/reports`, `/assignees`, `/contacts/bulk`, and `/contacts/export`. Validate all collection/history/work/report arguments with `crmWorkspaceValidation`; matching counts and rows share predicates. Explicit contact association wins over legacy lead association, and signed negative virtual references must resolve in the selected business. Histories bound nested message previews; older messages support a `beforeMessageId` cursor belonging to the verified conversation. Summary unreadConversations counts threads with unread messages; unreadMessages is a separate total. Work ticket links use `/dashboard/support/:id`; timeline automation links include `?run=:runId`.
- **CRM atomic edits and bulk/export**: Contact PUT accepts `pipelineStatus`, `assignedTo`, `currency`, `tags` and `expectedUpdatedAt` with the other fields. Lock configuration before contact, validate owner membership, and commit fields plus configured stage/lifecycle/lead/follow-up/activity effects together. Bulk changes are explicit checked IDs (maximum 100), all-or-nothing, and validate/materialize virtual references in the same transaction. CSV exports use the complete filtered set in a repeatable-read snapshot, refuse more than 10,000 rows with a narrowing instruction, and neutralize spreadsheet formulas. Do not export only the displayed page.
- **CRM date/configuration/report contracts**: Custom reporting configuration stores `dateStart`/`dateEnd` as validated YYYY-MM-DD UTC days with inclusive end dates. Configuration revision is a SHA-256 of recursively key-sorted JSON so PostgreSQL JSONB reordering does not create conflicts. Reports filter distinct contacts by creation cohort and selected platforms, retain currencies independently, and expose real stage visits and transitions rather than inferred conversions. Channel message totals are lifetime cached totals for conversations belonging to the selected contact cohort and must be labeled accordingly.
- **CRM reminder ownership**: Reminder assignment remains in existing metadata and must reference a valid member of the selected business. Pending/snoozed/completed edits synchronize contact `nextFollowUpAt`; snooze schedules the new due time. Workspace owner/member notification and explicit opt-in contact email retain the existing processing gates. No new CRM schema migration is required for these APIs. `crmWorkspacePostgres.test.ts` and configuration PostgreSQL checks use isolated scoped SQL fixtures and mocked delivery, never production data or live provider sends.
- **CRM manual automation recovery**: PUT, pipeline PATCH and bulk opt into a versioned checkpoint on the existing protected activity in the same contact transaction. `ContactAutomationHandoff` discovers before claiming legacy evaluation, retries only pending discovery, and holds started/uncertain effects for review. Match migration 314's transaction capture and delegate enabled-engine effects to its existing event; never create a parallel outbox or replay a completed/claimed legacy evaluation. Preserve config-before-contact locks and the import ledger. `GET /contacts/:id/automation-handoffs` pages scoped receipts; `POST /contacts/:id/automation-handoffs/:transitionId/retry` resumes only unclaimed events. `savedContactResponse` provides canonical post-automation reads without turning committed edits into save failures. The automatic Support orchestrator retains its separate context/gates and requires owner coordination before adopting this contract.
- **Import pattern**: `import routes from './routes.js'`
- **Legal APIs**: `server/routes/legal.routes.ts` exposes public policy read endpoints and account deletion request submission (`/api/legal/*`)
- **Storage library**: `GET /api/settings/storage/files` supports `category`, literal file-name `search` (up to 255 characters), `sort` (`newest`, `oldest`, `name`, `size`), and an exact actor-run `folder` when category is `actor_output`. Search, totals, and pagination share the same owner/deleted-file predicates; sorting includes an ID tie-breaker. Folder queries must stay inside the authenticated business owner's storage namespace.
- **Admin legal APIs**: `server/routes/admin.routes.ts` includes policy CRUD + account deletion review endpoints under `/api/admin/*`

## Legal Content & Account Deletion
- **Policy table**: `policy_pages` (slug/title/markdown/published)
- **Deletion table**: `account_deletion_requests` (email/reason/status/admin notes)
- Public policy read endpoint: `GET /api/legal/policies/:slug`
- Public deletion request endpoint: `POST /api/legal/account-deletion-requests`
- Admin management endpoints: `/api/admin/policies` and `/api/admin/account-deletion-requests`

## Mastra Agent System
- **Agents**: supervisor, icp_generation, lead_generation, content_studio, outreach, performance_marketing
- **Orchestrator**: `server/mastra/orchestrator.ts` — plain async while-loop, no external StateGraph
- **State**: Stored in `chat_thread_metadata` via Postgres (no checkpoint tables needed)
- **Agent runners**: Located in `server/mastra/agents/`
- **Tool executors**: Located in `server/mastra/tools/executors/`
- **Tool Results**: { success, toolName, output?, error?, requiresApproval?, executionId?, durationMs? }
- **Shared config**: `server/shared/agents/` — tabConfig, agentPersonas, greetings (used by both agents and routes)

## Connection administration authority

MSG91 settings mutations and Resend domain creation/update/verification/removal declare `requireBusinessManager` on their concrete routes. Central classification remains defense in depth. Preserve ordinary staff readiness reads and operational send permissions; connection authority remains owner/billing_admin, with actor identity checked.

## MSG91 SMS Integration

- `MSG91ProviderService.verifyMSG91Configuration` calls the read-only `sms/getTemplateVersions` API. Require an active accepted template, its exact Sender ID, and exactly one matching text variable; HTTP 200 alone is not verification. Saving `/api/msg91-settings` encrypts the Auth Key/session and records provider verification and sender identity. Use `inspectMSG91Credential` for settings, campaigns, tools, proposals, and sending. Older incomplete credentials must be verified and saved again.
- `sendSMS` uses MSG91 v5 `/flow` with `template_id` and `recipients` containing `mobiles` plus the configured variable. Normalize recipient numbers with `normalizeMSG91Phone`. Shared outreach creation, queued delivery, and inbox replies resolve the exact reviewed sender through `ProviderBindingService`; do not fall back to a different account. Preserve `deliveryAttempted` and `outcomeUncertain`: an ambiguous provider outcome requires manual review and must not trigger automatic retries or refunds.
- Delivery reports post to `/api/webhooks/sms/:userToken/delivery`; incoming SMS remains `/api/webhooks/sms/:userToken`. Both resolve the callback token to the business profile. `MSG91DeliveryService` validates the whole batch, matches tenant/receipt/recipient/sender, commits status and a sanitized audit event together, deduplicates repeated reports, and prevents late reports from undoing delivery. Outbound message metadata freezes `smsRecipient` so later contact or conversation changes cannot misattribute an earlier receipt. Unmatched reports return a retryable response for the send/receipt commit race. Incoming replies require an inbound service in MSG91. SMS events are exposed through the same profile-scoped integration activity API as other providers.
- Apply migration `313_msg91_provider_verification.js` before deploying. Provider tests mock external requests and never send live SMS; `MSG91_LOCAL_QA=1 pnpm test --runInBand tests/msg91DeliveryPostgres.test.ts` verifies callbacks and migration rollback in an isolated local PostgreSQL schema.

## Building Server
```bash
cd server
pnpm exec esbuild index.ts --platform=node --packages=external --bundle --format=esm --outdir=dist
pnpm exec esbuild workers/worker-entry.ts --platform=node --packages=external --bundle --format=esm --outdir=dist
```

## Database Migrations
```bash
cd server
pnpm run migrate:up       # Run pending migrations
pnpm run migrate:status   # Check status
pnpm run migrate:down     # Rollback last batch
pnpm run migrate:create <name>  # Create new migration
# NEVER use drizzle-kit migrate - use custom runner
```

## Testing
```bash
cd server
pnpm test                 # Jest with --experimental-vm-modules
pnpm test:watch          # Watch mode
pnpm test:coverage       # Coverage report
```

## Directory Structure
```
server/
├── controllers/          # 71 API handlers
├── models/               # 70+ Drizzle schemas
├── services/             # 40+ business logic services
│   ├── agents/          # AI agent services
│   ├── ads/             # Ad platforms
│   └── workflow/        # Workflow services
├── mastra/               # Active agent orchestration (replaces langgraph/)
│   ├── agents/          # 6 agent runners
│   ├── tools/           # Tool executors + registry
│   │   └── executors/  # Per-domain tool implementations
│   ├── orchestrator.ts  # Main async agent loop
│   ├── supervisor.ts    # Routing supervisor
│   └── state.ts         # Agent state schema
├── shared/agents/        # Shared config (tabConfig, agentPersonas, greetings)
├── routes/              # Modular route definitions
├── middleware/          # Express middleware
├── infrastructure/      # Redis, DB connections
├── events/              # EventBus (Redis Pub/Sub)
├── gateway/             # RealtimeGateway (WebSocket)
├── queues/              # BullMQ registry & dispatcher
├── workers/             # Background job processors
├── migrations/          # Custom migrations
└── index.ts             # Main entry point
```

## Critical Rules (DO NOT VIOLATE)
- **NEVER add job processing to API server** - workers run in separate PM2 processes
- **NEVER use drizzle-kit migrate** - use custom runner (`pnpm run migrate:up`)
- **NEVER use EventBus.publish(channel, data)** - use single object: `{ channel, userId, ... }`
- **NEVER call provider.chat()** - use `createChatCompletion()` or `createChatCompletionStream()`
- **NEVER reduce DB idleTimeoutMillis** below 60s - causes mass SCRAM-SHA-256 reconnects
- **DO** load env vars via `import './env.js'` FIRST in index.ts
- **DO** use `credentials: 'include'` in all fetch calls
- **DO** use middleware `authenticateToken` for protected routes

## Assistant management diagnostics

- Management endpoints are under `/api/settings/outreach/assistants`. Keep writes owner-only and all reads/SQL unions constrained by both owner and business profile. `AssistantOperationsService` provides diagnostics, cursor activity, revisions, audited scenarios and knowledge-review state; canonical conversation IDs must be positive PostgreSQL integers.
- List serialization batches catalog, platform readiness and bindings. Search uses literal substring matching and safe SQL array construction, including empty account matches. Cursors are validated against the current profile and filters and use millisecond-truncated ordering with stable secondary keys.
- Published revisions remain immutable. Scenario save/delete and gap reviews append to the existing assistant audit ledger; never replace customer history. Store only bounded redacted scenario inputs/review notes. Simulator sessions stay signed, negative and side-effect-free.
- Diagnostics exclude previews, advisory turns and simulated audits. Knowledge gaps need explicit uncertainty/failed verification or retrieval health/conflict/staleness evidence; empty greeting retrieval is not a factual gap. Question samples come from bounded redacted audit trace input, never timestamp-based guessing.
- Usage metadata's reserved `_assistant` attribution comes exclusively from the frozen server assistant context in the matching business scope. Cost aggregation uses exact usage provenance, not time/conversation joins. Existing estimated costs are labelled as model-cost estimates and visible only to the owner; unavailable cost remains null.
- Activity receipts are actual messages/schedules/outbox/playbook/approval/session/owned-proposal records. Do not fabricate document URLs or provider delivery. Recheck approval, permission, opt-out and account readiness at the delivery boundary even when a cached catalog showed availability.

## Instagram automation hub

- `POST /rules/:id/duplicate` checks the source revision/account and creates a paused copy. `POST /rules/:id/test` only simulates a saved trigger with the target treated as active against other active priorities; it never calls Meta or creates an execution. `/runs?ruleId=` applies integer validation plus the existing ownership/RLS filters. `/readiness` needs no automation tables and returns sanitized checks/expiry only.
- Private-reply intent reservation is serialized per business/account and limited to 700 attempts in a rolling hour, including rejected/uncertain intents, leaving headroom below Meta's documented 750. Work is deferred in `context.notBefore` before a send intent exists and resumes through recovery. Recheck eligibility/windows after waiting. Never automatically replay an intent with an unknown delivery outcome. The shared OUTREACH queue limiter remains in effect; this budget covers automation traffic only.
- Apply migration 318 after 316 to index hourly private-reply reservations. Classify Meta rate-limit, expired authorization, closed messaging-window, invalid private-comment and revoked-message-access errors with stable, actionable copy; never return raw provider messages that may include customer input.

- Account-scoped endpoints live under `/api/instagram/automations/:accountId`; configuration, provider adapter, and webhook runtime are in `server/services/instagramAutomations/`. Shared validation is in `shared/instagramAutomations.ts`. Resolve ownership from the current business scope for every account request.
- Comment rules run before AI replies. One rule wins by specific media, reels, then all media and list priority; a filtered match still suppresses AI. Keep immutable execution snapshots and the unique provider-effect ledger; ambiguous sends must never be retried automatically.
- `process_instagram_automation` runs on OUTREACH workers. The GENERAL recovery sweep reconciles interrupted profile publications by readback and resumes only safe execution states. Persist profile drafts before provider IO, and mark published only after accepted write plus matching readback.
- Deploy migration 316 before API and workers. Rollout is disabled unless `INSTAGRAM_AUTOMATIONS_ENABLED=true` or the account appears in `INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS`. See `server/INSTAGRAM_AUTOMATIONS_ROLLOUT.md` for verification and live-provider gates.
- Readiness includes login-specific base permission dependencies as well as feature grants, approval and subscriptions. Direct login needs `instagram_business_basic`; Facebook-backed accounts need `instagram_basic`, `pages_read_engagement`, and `pages_manage_metadata`. Confirm an exact account owner ID before classifying media as a Reel; missing ownership is unresolved. See `server/INSTAGRAM_AUTOMATIONS_META_API.md` for official API contracts and actual app configuration findings.
- Text messages (including follow instructions) use a 1,000 UTF-8-byte limit, and button text uses 640 characters. Both login types send private replies through the Instagram account ID, publish profile settings with `platform=instagram`, and read icebreaker locale groups directly. Menu comparison excludes unsupported composer metadata. Direct media queries omit Facebook-only caption/product fields; unresolved Reel classification must be recorded before any lower-priority or AI dispatch.
- History serial IDs/cursors must stay in PostgreSQL's integer range; use a nullable first-page cursor. Old menu postbacks receive a durable explanation without exposing drafts. `instagramAutomationRoutes.test.ts` verifies actual HTTP/configuration/provider/RLS behavior in an isolated local schema, with only session establishment and Meta network responses replaced.

Instagram connection health: `GET /api/instagram/automations/:accountId/readiness` reads sanitized saved readiness without provider I/O or automation-table access. Explicit `?verify=1` checks current subscribed-app fields; malformed verification arguments are rejected. Provider failures produce sanitized reasons and disable affected capabilities.

Automation readiness returns `authorized` independently from feature availability and rollout. Saved App Review/webhook setup blockers do not imply lost account authorization and do not relax activation/delivery gates. A provider verification response with code 190 marks authorization unavailable and requires reconnecting. Keep account ownership and business scope checks on every readiness request.

## Storage workspace

`storageWorkspace.ts` owns selected-business file predicates, cursor paging, metadata organization, dependency review, Trash/restore and bounded per-file activity. Every query requires the business owner and selected profile in addition to forced RLS. Bulk metadata changes lock and validate the full batch before writing; stale/foreign IDs fail the whole operation. Trash is recorded in `metadata.storageWorkspace.trashedAt` while `is_deleted` stays false, so durable quota and organization capacity remain charged. Restore is available for 30 days. The existing per-business storage cleanup cron purges expired Trash using a guarded delete; restore wins safely if the state changed before deletion. Permanent deletion uses the existing quota transaction and retryable object-cleanup ledger.

`storageWorkspaceController.ts` streams local/S3 content with byte-range support and bounded private thumbnail caching; ownership and active state are rechecked before every cache hit. Download POST validates up to 200 files (500 MB total for a ZIP), stores a random capability in shared Redis for two minutes, and returns the browser URL. The ticket GET precedes authentication, accepts only that capability, consumes it atomically, re-enters its captured business scope and revalidates files before streaming. API instances must share Redis; a Redis failure returns 503. Never put file IDs, credentials or a business selector in a public download URL.

Uploads carrying a UUID `X-Storage-Upload-Id` use a PostgreSQL advisory lock keyed by owner/profile/receipt. Receipt transactions use a bounded process queue so they cannot starve the primary pool. New uploads record the signed-in member; historical uploads without actor metadata show an unknown uploader. A completed retry returns the same file; changing the content/name or retrying a removed file returns 409. Signature checks and atomic quota enforcement remain in the existing upload path. Keep source links conservative: missing references are not proof that published URLs are unused.

## Channel follow-up settings saves

- `PUT /api/settings/integrations/:integrationKey/follow-ups` uses `saveChannelFollowUpSettings` to initialize and lock the business/owner settings row, patch only the requested supported channel and recompute the master flag in the same transaction. Keep the scoped composite conflict target and explicit business/owner filters.
- GET/PUT responses include a stable channel `revision`; `expectedRevision` rejects stale differing edits with `409 FOLLOW_UP_SETTINGS_CONFLICT`. Identical retries are safe. Older callers may omit the revision for compatibility; their saves still use the atomic patch but cannot detect stale same-channel edits.
- Convert combined legacy delay units into the complete exact whole-minute/hour/day representation. Preserve unsupported fractional-minute values for validation instead of truncating or silently changing them. Template creation supports `whatsapp` alongside Email/SMS/social message types; this is business content approval and does not grant WhatsApp provider permission. Brand-context configuration failures retain their code and HTTP status.

- Content-template POST validates the same supported types in `contentTemplateSchema` and the controller, including WhatsApp. When `Idempotency-Key` is present, template creation locks the scoped key and commits the template, initial version and completed `content_request_receipts` receipt in one transaction. Replaying the same key/body returns the same template ID; different bodies and unavailable/expired receipts fail closed. This uses existing migrations 278/299 and adds no schema migration. Legacy requests without a key remain compatible.


## Operational boundaries

- Admin infrastructure summaries measure bounded DB/Redis availability. They do not attest
  to external worker/event-bus state; unavailable measurements must not become hardcoded health.
  `/infrastructure/health` includes process-local log persistence counters without record content.
  Those counters are not aggregate worker monitoring or an independently delivered alert.
- Logs and queue diagnostics share `redactCredentialText`; retain each surface's separate PII
  markers, size/depth limits and permissions. Queue free text must censor URI credentials,
  provider-key forms and JWTs as well as secret-named object fields.

- `/live` is liveness; `/ready` and `/health` require bounded DB/Redis checks and fail while draining.
- Dedicated workers wait for queue readiness and expose an internal readiness endpoint on the
  configured `WORKER_HEALTH_PORT`; readiness includes running consumers, DB and Redis.
- Log records are sanitized after Pino serialization and before all sink fan-out, including child
  bindings. Primitive provider errors are omitted; safe structured error type/code remain usable.
- Langfuse traces are metadata-only. Telemetry setup/end failures must never repeat the provider
  callback or replace its result/error. Customer prompt/output capture requires a separate reviewed policy.
- Tracked configuration supplies no credential values. Put private values in ignored environment
  overrides. Never print environment values, generated connection URIs or raw provider bodies in tests/logs.

## Data integrity contracts

- Profile deletion uses `stageBusinessProfileDeletion`: authorize each persisted destination/provenance payer separately and lock organizations ascending before common business/domain locks. Use the Brand transaction staging plan, finish setup/default/preference/history work and prelock the actual FK cascade closure before one canonical reference-release batch. Prelock the complete object set and storage IDs in order; remove eligible setup files before the final already-locked profile delete to respect migration299. Quota writes remain in existing triggers and cleanup receipts run only after commit. Preserve frozen/shared holders and return a conflict for records that still restrict deletion. Older account writers and analysis commits can hold the inverse advisory order, so deletion must use nonblocking account/profile-lock attempts and a safe retry response. See `businessProfileDeletionPostgres.test.ts` for mounted JWT/SQL and real lock witnesses.
- Hotel rate imports validate every row before one database transaction; impossible calendar dates and duplicate workbook room/date identities are errors. Serialize property/room provisioning, require explicit property selection when ambiguous, and run legacy RAG cleanup only after commit. Migration 331 adds exact hotel/name uniqueness without merging history.
- CRM import identity and per-row effects/receipts/progress are durable together. Identical file/mapping/mode resubmission resumes one business-scoped import; blocked capacity rows remain retryable. Use configured stages and keep pipeline keys separate from lifecycle states. Migration 330 is required. Preserve upload async context and never reconstruct business ownership from a form field.
- Storage deletion/replacement must commit cleanup keys with metadata before provider deletion. Acknowledgements remove only the completed key; never overwrite a stale metadata snapshot. Maintenance must process independent businesses despite an earlier failure; repeated sweeps remain idempotent.
- Privacy export version 2 uses explicit reviewed projections, a consistent bounded snapshot and completed private artifact before headers. Its manifest declares partial inventory, counts, checksum and exclusions. Never include authentication/token fields or reveal restricted originals through this route. Full inventory policy and subscription route exemptions are separately owned. See `docs/DATA_INTEGRITY_IMPLEMENTATION_2026-10-23.md` for integration and pending decisions.

## Tenant and billing integrity

Follow `docs/tenant-billing-integrity.md` for approval checks, account privacy scope, credential guards and atomic transport claims. Full provider affordability enforcement remains tracked separately as A03. Never use a preview throttle check as dispatch authorization.

Queue recovery must retain the immutable owner/profile/business-actor/payer/billing-actor snapshot and use `captureJobBusiness(data, { requireOriginatingIdentity: true })` (or reject incomplete origin before enqueueing). `runBusinessJob` rejects missing legacy authority; never replace it with the ambient inventory owner or reclassify it as a global system job. The registered-worker PostgreSQL/Redis regression is `jobOriginWorkerPostgres.test.ts` and requires explicit disposable local fixtures.

## Reviewed bulk outreach receipts

Bulk outreach binds each scoped request key to a canonical hash of the reviewed
payload. Identical retries return the stored receipt; changed payloads return
`REQUEST_KEY_CONFLICT` without another mutation. Queue acknowledgement failure
requires reconciliation against the retained BullMQ job and durable message.
Never downgrade an advanced provider receipt to failed. Unconfirmed submissions
retain message/conversation IDs, return `status: 'uncertain'`, and conditionally
hold only untouched pending intents for review. This state is distinct from a
definitively rejected preparation and from actual provider delivery.
## Configured follow-up origin persistence

- `configuredFollowUpDispatch` is asynchronous: await it before reserving Email, SMS or social work. It calls the existing Tenant `captureJobBusiness` at intent creation and persists all five owner/profile/business-actor/payer/billing-actor fields alongside the single versioned `followUpProvenance` and signed rendering context.
- Recovery requires that originating snapshot through `captureJobBusiness(payload, { requireOriginatingIdentity: true })`. Missing legacy identity or revoked/unavailable originating authority remains unsent in durable `review_required` state with a stable `reviewReason`; never backfill from the recovery inventory owner, automatically replay history or invent a staff automation principal. Transient SQL failures retain pending work.
- Keep deterministic job IDs and retained completed/failed jobs for lost-outbox-ack deduplication. Migration 360's rollback guard also retains held review intents; no new migration is needed for this JSONB envelope extension.
- `configuredFollowUpOriginPostgres.test.ts` verifies the actual outbox, QueueRegistry, Tenant SQL and registered SMS consumer with disposable loopback PostgreSQL/Redis; only external/provider/credit effects and unrelated worker infrastructure are mocked. Consumer final-readiness/effect claims remain Campaign's ownership. Review-state operator UI or legacy reauthorization is a separate reviewed contract, not an automatic retry path.
## Administrator recovery and reporting

Administrator reset claims lock and compare the observed grant hash, then enforce existing expiry at consumption; a resend, concurrent winner or lock wait must not permit an expired claim. Administrator bearer-to-cookie migration happens only after principal, revocation and database checks. User/admin token issuance preserves millisecond password-cutoff precision. Missing-expiry and legacy issue-time compatibility remain pending explicit policy decisions; do not interpret these narrower fixes as complete recovery assurance.

Administrator user-usage reads require canonical management IDs and positive integer day arguments with valid date ranges. Keep provider units distinct through `shared/adminUserUsage.ts`. Organization discovery reads at most one row beyond its 100-result limit to expose `hasMore` and `resultLimit`; preserve live-subscription selection and existing super-admin authorization. Removed-staff history visibility and retention remain separate decisions; do not add revoked rows to the general directory without authority.


## Durable queued SMS dispatch

The generic `SMS_SENDING` consumer requires migration
`351_sms_queue_delivery_claims.js` and the asynchronous configured-follow-up
producer contract. Await `configuredFollowUpDispatch` and persist its original
business/actor/payer payload before reservation; recovery must retain that identity.
The matching producer revision is an integration dependency, not part of the SMS
consumer patch.

`sendSMS` accepts an optional sixth argument `{ beforeProvider }`. It runs after
recipient/account/credential preparation, immediately before adapter fetch. The
queued consumer uses it to recheck full versioned follow-up provenance, original
binding, cancellation/takeover/reply and suppression, then records provider start
with its current claim token. Callback failure propagates without a provider call.
Do not add awaited preparation after this check or replace it with an early check.

`sms_queue_deliveries` retains the immutable job/content/actor/payer identity,
preparation token, atomic credit reservation reference and provider outcome. Safe
unstarted recovery releases the original unused reservation; started/unknown
outcomes require receipt review and never automatically resend or refund. A
confirmed receipt repairs history on recovery without contacting the provider;
`activity_confirmed_at` preserves later webhook status and prevents counting a
confirmed message twice. Provider acceptance is not handset delivery. There is
no new operator replay permission or recovery UI in this change.

Use the opt-in `SMS_CONSUMER_LOCAL_QA=1` registered-worker suite
`tests/configuredSmsConsumerPostgres.test.ts` with its explicit disposable
`SMS_AUDIT_DATABASE_URL`, loopback Redis fixture and mocked provider. It exercises
actual configured cron/outbox, queue capture, registered worker, durable SQL and
child-process loss; it is not a production delivery or real-wallet assertion.
## Administrator pending Lead removal

The queue remove handler uses Lead's `removedJobReservation` contract: prepare a durable ticket from the fetched job before removal; never release after a thrown/uncertain removal; release only after fulfilled removal with the helper's original ledger/attempt proof. A cleanup failure after deletion returns202 with `removed`, `cleanupPending` and `intentId`; do not convert it into a deletion-failed response or infer refund eligibility from Redis absence. Preserve the super-admin audit actor separately from the pinned financial actor/payer. Migration532 follows530/531. `adminQueueRemovalPostgres.test.ts` exercises real Admin guards, SQL/Redis, the registered Lead worker and ledger against disposable fixtures; provider effects remain mocked.


## Campaign-owned manual follow-ups

`CampaignManualFollowUpService` owns explicit `{kind: chat_thread | outreach_campaign, id}` identities, scoped by business, owner and channel. The two ID namespaces are not interchangeable. `/api/outreach/manual-follow-ups` reads/saves immutable template snapshots with `expectedVersion`; `/preview` persists an immutable one-hour recipient review. The batch composer submits `campaignManualReviewId` to `/api/outreach-conversations/bulk`, and each origin stores its exact campaign, lead, recipient, review and sequence/template revisions. `admitManualOrigin` fences a sequence edit racing enrollment. Never use live global manual settings or infer a campaign from job title, UI workspace or recency. Global defaults are only an explicit preset copy.

Campaign manual steps use existing `send_outreach_message`, `CreationFollowUpService`, exact original conversation/account and mandatory customer delivery admission/dispatch guards. Claims match the immutable review ID, so superseded jobs cannot claim revised work. Template approval/version/brand and recipient/stop/suppression checks remain authoritative; a library edit holds old content instead of substituting it. AI configured generation retains its original path. Legacy inline/custom and global-template manual work without campaign provenance is held for review, never re-admitted automatically.

Sequence saves affect new enrollments only. `/pending-preview` records the exact original delivery/review before `/apply-reviewed` can change safe unsent enrollments. Sent, processing, stopped, held and uncertain work cannot be released by this action. New reviewed queue IDs and durable requeue metadata preserve recovery after a lost acknowledgement. Configuration/previews never enable assistants/providers or send messages.
