# Convo AI and Omnichannel Support Architecture Review

## Executive decision

The recommended architecture is a **shared canonical support gateway around the existing specialist agents**. It keeps the domain depth already present in Hotel Sales, Technical Support, Lead Qualification, Customer Success, and General Service while moving privacy, policy, playbooks, tool authorization, delivery idempotency, handoff, and audit into one mandatory path.

This option scores **9.2/10**. Replacing the support system with the standalone Convo AI service would discard useful hotel, booking, payment, CRM, and channel behavior. Copying Convo controls into every specialist would create inconsistent safety behavior and multiple bypasses.

The integration in this worktree follows the shared-gateway option. The code, UI, migrations, report queries, and focused automated checks are complete for the controls described below. Production secrets and live-provider staging verification remain deployment responsibilities.

## 1. Complete Convo AI feature inventory

The inventory below comes from the `convoai` source, database schema, API contract, admin pages, schedulers, and feature documentation—not only the visible UI.

### Platform, tenants, and access

- Multi-tenant SaaS data model with tenant-scoped conversations, messages, configuration, knowledge, playbooks, integrations, analytics, and storage paths.
- Clerk authentication, tenant membership, roles, onboarding, team administration, and superadmin controls.
- Tenant API-key creation/revocation for widgets and server integrations.
- Tenant branding, plan, handoff configuration, retention, and API rate-limit settings.
- Immutable audit log for administrative actions and before/after configuration changes.

### AI configuration and orchestration

- Per-tenant system prompt, model, temperature, maximum tokens, confidence threshold, fallback message, blocked topics, tools, and WhatsApp fallback number.
- Zero-temperature intent classification for question, booking, complaint, escalation, pricing, general, handoff, and off-topic categories.
- Context assembly from system instructions, retrieved knowledge, and active playbook directive.
- Multi-round model/tool orchestration, capped at three tool rounds.
- Low-confidence, blocked-topic, explicit-human, moderation, tool-exhaustion, playbook, and automation-rule escalation paths.
- Non-streaming simulator with intent, retrieval, confidence, and decision-debug output.

### Knowledge base and RAG

- PDF, scanned PDF, DOCX, URL, and plain-text ingestion.
- Native PDF extraction with GPT-4o file/OCR fallback for sparse or scanned documents.
- Approximately 800-word chunks with overlap and batched `text-embedding-3-small` embeddings.
- `pgvector` cosine retrieval with PostgreSQL full-text and `ILIKE` fallbacks.
- Configurable top-K and confidence threshold.
- Object-storage ownership/ACL enforcement and tenant-scoped signed uploads.
- Reindexing, ingestion status/error reporting, retrieval test query, and atomic replacement of old chunks.

### Privacy, safety, and moderation

- Pre-model structured PII redaction for email, phone, Luhn-valid card numbers, SSN, national IDs, and contextual name disclosures.
- Conservative contextual name detection to avoid redacting places and brands.
- Moderation log containing redacted content and flag types.
- OpenAI Moderation API checks for harmful categories before generation.
- Configurable moderation outage behavior.
- Blocked topics, confidence guardrails, response checks, and fallback/handoff behavior.
- Tenant retention window and scheduled deletion of detailed conversation data while preserving aggregates.

### Playbook engine

- Directed graph with trigger, message, question, condition, escalation, and action nodes.
- Channel and intent assignments with priority.
- Conditional operators: contains, not-contains, starts-with, ends-with, intent match, and intent non-match.
- Deterministic session-based A/B allocation.
- Conversation node progression and action/tool directives.
- Required-content compliance scoring based on meaningful word overlap.
- Draft/active/archive lifecycle and a visual node editor in the Convo admin.

### Tools, integrations, and automation

- Tool registry injected into the orchestrator according to tenant configuration.
- HubSpot contact, Zendesk ticket, Shopify order lookup, and custom webhook integration concepts.
- AES-256 encrypted integration credentials and connection testing.
- Automation rules with intent, keyword, and SLA-style triggers and webhook, ticket, or agent-assignment actions.

### Human support

- Real-time WebSocket queue and guest/agent broadcasts.
- Explicit request, low confidence, blocked topic, moderation, tool exhaustion, playbook, and automation handoff triggers.
- Takeover/assignment, full history, human messaging, resolution, AI summary, and three suggested replies.
- Queue priority, configurable response SLA, maximum agent load, optional skill matching, and SLA breach scheduler.
- WebSocket and email breach notifications.
- Widget WhatsApp continuation button when configured.
- Canned responses and a dedicated agent dashboard.

### Channels and client surfaces

- Embeddable web widget and React/mobile SDK hook/component.
- HTTP/SSE chat and WebSocket real-time transport.
- Admin simulator, channels configuration, notifications, agent dashboard, moderation log, knowledge, playbooks, integrations, analytics, audit, API keys, team, and settings screens.
- Convo contains channel-routing abstractions and documented channel integration work; its strongest complete reference implementation is the web widget/agent dashboard. The current SalesMarketing application has the deeper production adapters for WhatsApp, Instagram, Facebook, Gmail/Resend email, and public social replies.

### Analytics

- Daily tenant aggregates for volume, AI resolution, escalation, response time, CSAT, and top intents.
- Trend, intent distribution, response-time, and CSAT views.
- Per-conversation CSAT ratings/comments.
- Knowledge-gap and moderation/guardrail operational views in the application surface.

## 2. Existing SalesMarketing support-agent architecture

### Entry and routing

Inbound WhatsApp, Instagram, Facebook, Gmail/Resend email, and web-widget events normalize into `AgentRouter`, then pass through `ChannelGateway`. The gateway owns the cross-cutting decision. Each tenant has exactly one active support specialist; `AgentDispatchStage` invokes that selected mode and uses intent only for its policies and playbooks.

### Main specialists

| Specialist | Primary responsibility | Composed capabilities |
|---|---|---|
| Hotel Sales | Availability, pricing, negotiation, booking, payment, hotel facts, complaints, qualification | All eight sub-agents |
| Technical Support | Troubleshooting, grounded answers, resolution detection, ticketing | Knowledge, ticket, escalation |
| Lead Qualifier | Discovery, qualification score, sales handoff and CRM signals | Knowledge, qualification, escalation |
| Customer Success | Retention, dissatisfaction, complaint/support handling | Knowledge, ticket, escalation |
| General Service | General customer questions and safe fallback routing | Knowledge, escalation |

### Sub-agents and exact tools

| Sub-agent | Tools |
|---|---|
| Knowledge Base | `answer_from_knowledge_base`, `get_hotel_info` |
| Booking | `check_room_availability`, `save_booking_details`, `create_booking` |
| Negotiation | `quote_or_negotiate_price`, `handle_objection` |
| Payment | `get_payment_methods`, `send_payment_link`, `check_payment_status` |
| Complaint | `resolve_complaint`, `escalate_to_human` |
| Ticket | `create_support_ticket`, `get_ticket_status` |
| Escalation | `escalate_to_human`, `schedule_follow_up` |
| Qualification | `qualify_lead`, `update_lead_score` |

The specialist result can also signal CRM stage changes, score changes, alerts, reminders, and sequence enrollment. These effects now occur after the shared safety and confidence decision, and simulator mode suppresses them.

### Important strengths

- Mature omnichannel delivery adapters and provider-specific threading/context.
- Hotel booking, availability, pricing floors, negotiation, payment, qualification, ticket, CRM, reminder, and sequence logic absent from standalone Convo AI.
- Existing support teams, tickets, member portal, conversation records, lead/contact model, and channel integrations.

### Risks found in the previous design

- Multiple channel-specific generation/send paths could bypass shared behavior or duplicate replies.
- Specialist tool calls were exposed without one consistent approval/idempotency boundary.
- Raw widget contact fields could be placed in ordinary metadata.
- Human ownership and classifier failures could fail open.
- Provider timeouts could be automatically retried even when the first send might have succeeded.
- Playbooks, privacy access, delivery decisions, and tool approvals lacked one traceable operational view.

## 3. Architecture options and scores

Scores weight safety/consistency 25%, reuse 20%, channel fit 15%, maintainability 15%, migration risk 10%, observability 10%, and scaling flexibility 5%.

| Option | Score | Pros | Cons |
|---|---:|---|---|
| A. Replace support with standalone Convo AI service | 6.5/10 | Clean tenant boundary; mature widget, RAG, visual playbooks, and admin concepts; strong isolation | Rebuilds channel adapters and hotel/CRM/tool behavior; risky migration; two data models; feature regression likely |
| B. Copy Convo features into every specialist/channel | 4.0/10 | Small initial changes; teams can customize independently | Safety drift; duplicated logic; bypasses; inconsistent audits and handoffs; high long-term maintenance |
| **C. Shared canonical gateway around current specialists** | **9.2/10** | One privacy/policy/playbook/tool/delivery boundary; retains domain logic and channels; incremental rollout; shared evidence and simulator | Requires disciplined removal of legacy entry points; gateway is critical infrastructure; migration/configuration needed |
| D. Event-driven orchestration microservices | 8.0/10 | Highest isolation and future throughput; durable replay; independently scalable channel and AI workers | More operational complexity, queues, tracing, eventual consistency, and migration effort than current scale requires |

Recommended evolution: use **C now**, with the durable delivery outbox and audit events serving as seams for a later move toward **D** if volume or organizational boundaries justify it.

## 4. Canonical target flow

```text
Channel webhook/widget
  → authenticate + tenant ownership + provider-event idempotency
  → normalize message
  → verify AI/human conversation mode (fail closed)
  → redact PII and place raw content in restricted encrypted vault
  → redact structured model metadata while retaining server-only delivery identity
  → exact opt-out handling
  → load channel-scoped agent configuration
  → prompt-injection + deterministic/optional API moderation
  → sentiment + intent/risk classification (fail closed)
  → post-classification intent policy enforcement
  → playbook assignment/version/node resolution
  → policy gate + grounded knowledge retrieval
  → specialist dispatch through safe tool executor
  → outbound guardrail + playbook compliance + confidence gate
  → durable pre-effect decision audit
  → idempotent delivery outbox/provider adapter
  → permitted CRM/follow-up effects
  → finalize immutable decision audit + analytics
  → human queue when any gate cannot safely continue
```

This is a conceptual summary. The authoritative ordered list is the 37-entry `stages` array in `server/services/agents/pipeline/ChannelGateway.ts`, which also includes assistant availability, handoff consent/offer, customer courtesy, customer history, document and media retrieval/selection, and the ticket-aware stages, and reply-language localization.

## 5. Implementation matrix in this worktree

| Capability | Status | Implementation notes |
|---|---|---|
| Mandatory shared gateway | Implemented | All active and legacy-token support entry points route through `AgentRouter`/`ChannelGateway`; dormant direct Instagram keyword/suggestion senders are non-operational |
| Single active specialist selection | Superseded by assistant routing | The specialist mode now comes from the one live published assistant bound to the receiving account and surface (`AssistantResolver`); the tenant-wide active specialist is never consulted, and an account with no unique live assistant gets no automatic reply. See `server/ASSISTANTS_ROLLOUT.md` |
| Pre-model PII protection | Implemented | Stable typed tokens; AES-256-GCM restricted vault; tenant-derived HKDF keys; 30-day default/90-day maximum vault retention |
| Raw PII reveal control | Implemented | Only assigned active support member; 60-second UI reveal; append-only access log; vault purge retains access history |
| Widget contact privacy | Implemented | Ordinary metadata stores only redacted tokens; raw profile is vault-protected |
| Exact opt-out | Implemented | Deterministic pre-model confirmation and conversation unsubscribe state; simulator does not mutate state |
| Conversation human ownership | Implemented | Human-owned/unsubscribed conversations suppress future AI; DB verification failures fail closed |
| Intent/risk outage behavior | Implemented | Classification failures and missing classification fail closed to human review |
| Content moderation | Implemented/configurable | Deterministic critical self-harm/violence/sexual-minor checks always run; optional OpenAI moderation runs when enabled; on a provider outage only a narrow low-risk set continues and everything else goes to human handoff |
| Policy engine | Implemented | Strictly validated channel, intent escalation, overnight IANA-timezone operating hours, whole-word/phrase prohibited topics, confidence, exact response length, disclaimer, and block/escalate actions; invalid policies fail closed |
| Versioned playbooks | Implemented | Immutable published snapshots, draft/publish/archive, advisory-locked publication, assignments, priority, traffic split, deterministic variants, graph validation, traversal, compliance |
| Playbook management UI | Implemented | React Flow visual authoring, node/edge editing, entry selection, variants, graph JSON mode, immutable publish/archive lifecycle, and channel/intent/agent/traffic assignments |
| Safe tool boundary | Implemented | Exact registered names, argument filtering, PII-safe idempotency, read/write/risk rules, explicit enablement, playbook/owner authorization, and redacted tool results returned to later model rounds |
| One-time high-risk approval | Implemented | Pending approval queue, assigned-member approve/reject, atomic one-time consumption linked to execution, scheduler expiry |
| High-risk write activation | Implemented | Specialists never commit high-risk writes inline. Argument-bound approvals are encrypted and consumed exactly once by the durable resume worker; failed or unconfirmed effects enter reconciliation |
| Effect ledger | Implemented | Each post-delivery CRM, score, notification, reminder, sequence, and specialist proposal effect has an inbound-event-derived idempotency key; failures enter reconciliation state |
| Versioned agent configuration | Implemented | Owner-editable metadata is validated against schema version 1; unknown runtime switches and high-risk auto-approval are rejected |
| True dry-run simulator | Implemented | Routing, privacy, guardrail, policy, playbook, proposed tools, reply, and outcome; provider/tool/CRM/handoff/opt-out/vault/playbook mutations suppressed |

### Support AI rate-limit contract

Support AI uses one customer-message ingress limit: a database-backed fixed
window keyed by tenant, native channel, and sender. A `rate_limit` rule must use
`{ "limit": number, "windowSeconds": number, "action": "block" | "escalate" }`.
The bucket is consumed once before model generation. Dry runs report the limit
without consuming it, and a database error fails closed. The former
conversation/audit-log counter and `maxMessages`/`windowMinutes` aliases are
migrated to this contract and are not enforced separately.

### Internal advisory assistants

Support-member chat and claimed-handoff assist are intentionally lightweight
advisory modes: they use redacted context, verified knowledge, and the canonical
inbound/outbound guardrails, but do not execute playbooks, tools, customer
delivery, or conversation lifecycle mutations. Their responses explicitly
return `mode: "advisory"` and `deliveryAllowed: false`. Any customer-bound draft
must still be sent through the canonical `ChannelGateway` path.
| Human handoff | Implemented | Atomic one-open queue record, team/member/ticket link, claim, human-owned mode, SLA scheduler, history and manual reply/resume |
| Human reply assistance | Implemented | Assigned-member-only redacted conversation summary, exactly three suggested replies, review-before-send draft flow, and team/channel canned-response CRUD |
| Delivery idempotency | Implemented | Deterministic outbox decisions, provider IDs, sent/failed/uncertain states, no blind retry after ambiguous provider calls |
| Uncertain-send operations | Implemented | Owner view and verified sent/not-sent reconciliation with mandatory note |
| Omnichannel support | Implemented | WhatsApp, Instagram DM/public comment, Facebook, Gmail/Resend email, and web widget use the canonical decision path |
| Email threading | Implemented | Canonical decision followed by the existing single threaded email delivery adapter/outbox path |
| Audit and operations analytics | Implemented | Outcomes, confidence/latency, delivery, handoffs, playbook compliance, privacy retention/access, tools, knowledge gaps, and guardrail/policy counts |
| Immutable administrative audit parity | Implemented | Append-only database trigger plus before/after evidence for agent configuration, playbooks, assignments, canned responses, and delivery reconciliation |
| Distributed AI rate limits | Implemented | Tenant/channel/sender database buckets, agent policy overrides, dry-run suppression, fail-closed database behavior, endpoint throttling, and scheduled cleanup |
| Webhook telemetry privacy | Implemented | Meta/WhatsApp/social payloads are recursively sanitized before logs/storage; secrets and direct identifiers are removed; telemetry retention is bounded to 1–365 days |
| Deployment readiness view | Implemented | Reports LLM, WhatsApp, Instagram, Facebook, verified email sender, privacy vault, moderation credential, and moderation outage mode |
| Convo OCR/ingestion replacement | Not required for gateway integration | Existing SalesMarketing knowledge services remain the grounding source; Convo ingestion can be ported separately if scanned-document OCR is a product requirement |
| CSAT collection and report | Implemented | Existing ticket-review ratings feed 30-day response count, average, and 1–5 distribution in support AI operations |
| Architecture drift automation | Implemented | CI/nightly workflow runs type checking, the 37-stage/one-agent/quarantine audit, and the support safety and governed-media acceptance suites |
| Legacy deletion | Quarantined | Import allowlists block new dependencies; runtime deletion and later table removal wait for one release plus 30 production days of zero telemetry |

## 6. Deployment requirements and acceptance criteria

### Required configuration

- Set `SUPPORT_PII_ENCRYPTION_KEY` to a dedicated secret of at least 32 characters, or provide a suitably strong shared `SECRETS_ENCRYPTION_KEY`.
- To use OpenAI content moderation, set `SUPPORT_MODERATION_ENABLED=true` and `OPENAI_API_KEY`. `SUPPORT_MODERATION_FAIL_CLOSED` is only reported in the deployment readiness view; it does not change runtime outage behaviour, which always hands off anything outside the low-risk set.
- Run all pending migrations through `215_create_support_media_gallery.js` through the normal migration process.
- Use the Node version declared by the workspace engine (`>=24.18.1 <25`).
- Verify WhatsApp, Meta, Gmail/Resend, and any payment/booking provider credentials in staging. These cannot be proven by unit tests without live provider accounts.

### Launch gates

- Replay the same provider event and confirm exactly one delivery action and one outbound message.
- Force a provider timeout and confirm the action becomes `uncertain`, with no automatic resend.
- Confirm PII tokens—not raw values—appear in model/audit traces; confirm only the assigned member can temporarily reveal raw content.
- Exercise explicit human request, critical safety language, low confidence, blocked topic, classifier outage, operating-hours misconfiguration, and playbook escalation.
- Verify human takeover stops AI, human reply uses the outbox, resolution resumes the intended mode, and SLA breach notifications fire.
- Verify high-risk tools cannot execute without an exact, argument-bound one-time human approval; playbooks and owner metadata cannot bypass it.
- Compare simulator output with a staging live turn while confirming simulator produced no customer send or persistent business mutation.

## 7. Worked example: “How many guests can stay in each room?”

1. WhatsApp normalizes the inbound provider ID, tenant, conversation, sender, and text. Privacy replaces model-visible sender/name/company data with stable tokens; the raw phone remains only in the server-only delivery identity.
2. Pre-classification policy checks channel, prohibited topics, operating hours, and rate limit. NLU classifies the turn as `faq`; post-classification policy then evaluates intent rules with a real intent instead of an empty value.
3. `KnowledgeGateway` runs tenant/profile/audience-scoped lexical, exact-identifier, and vector retrieval. It fuses and reranks results, adds only necessary neighbors, and returns typed evidence IDs—not one concatenated trust string.
4. Hotel Sales drafts the room list. The verifier splits every bullet into a separate claim, such as “Premium Club Rooms allow 2 adults,” and attaches only evidence whose excerpt supports that exact claim. One unsupported room item blocks the whole customer-facing factual reply.
5. The active playbook checks structured assertions such as `has_supported_claims`; it does not accept a reply merely because it contains a required phrase. Outbound guardrails then sanitize/refuse/handoff as required.
6. A `decision_ready` audit row is created before WhatsApp delivery. The channel formatter moves an inline first item onto a new line and converts portable bullets/bold into WhatsApp-safe formatting. The outbox prevents duplicate parts under provider retries.
7. Provider acknowledgement marks delivery `sent`; only then may idempotent post-processing commit. The same audit row is finalized with evidence, policy, playbook, tool, delivery, and reconciliation outcomes.

If evidence is missing, stale, conflicting, unavailable, or fails claim verification, the system does not send the old “contacted my senior” text. It explains the actual reason, creates/reuses the operator-visible ticket and handoff, and states the configured response target without inventing a guarantee. Follow-up messages on that human-owned conversation receive a queue-aware acknowledgement and do not re-enter model generation.

## 8. Final recommendation

Operate the shared gateway as the single production path for every tenant and supported channel. Managed safety-template changes propagate globally; customized tenant playbooks remain owner-controlled. Review knowledge repair items, guardrail events, SLA breaches, handoffs, playbook compliance, approval reconciliation, and uncertain deliveries daily. Move to a separate event-driven orchestration service only when throughput, fault isolation, or team ownership creates a demonstrated need.
