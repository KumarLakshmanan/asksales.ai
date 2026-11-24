# Convo AI vs SalesMarketing Support Assistant

## Executive summary

Convo AI is stronger as a generic customer-support product: it has a cohesive tenant model, knowledge ingestion, visual playbooks, a support-agent workspace, widget/SDK surfaces, and generic integrations.

SalesMarketing is stronger as a domain-operating support assistant: it already knows how to execute hotel, booking, pricing, payment, ticket, CRM, qualification, reminder, and lead-workflow actions across WhatsApp, Instagram, Facebook, email, and web.

The best product is therefore not a replacement of one by the other. The current shared `ChannelGateway` approach is the right foundation: keep SalesMarketing's specialist agents and channel adapters, while treating Convo AI's privacy, playbook, moderation, handoff, and operator patterns as shared control-plane capabilities.

### Directional maturity scores

These are capability scores based on the reviewed implementations and documentation, not production benchmarks.

| Dimension | Convo AI | SalesMarketing | Readout |
|---|---:|---:|---|
| Generic support self-service | 9/10 | 8/10 | Convo is more purpose-built for support; SalesMarketing is more domain-specific. |
| Domain action execution | 6/10 | 10/10 | SalesMarketing has hotel, booking, payment, CRM, qualification, ticket, and reminder tools. |
| Omnichannel delivery | 7/10 | 9/10 | SalesMarketing has deeper production adapters for Meta, WhatsApp, email, and web. |
| Privacy and safety controls | 9/10 | 8.5/10 | Both have redaction, policy, moderation/guardrails, and handoff; Convo is more productized, SalesMarketing more integrated with delivery. |
| Playbook capability | 9/10 | 8.5/10 | Convo has the more mature generic authoring model; SalesMarketing now has versioned graph playbooks and compliance gates. |
| Human support workflow | 9/10 | 8.5/10 | Convo has a dedicated queue/dashboard model; SalesMarketing has handoffs, teams, tickets, SLA checks, and member tooling. |
| Knowledge ingestion and RAG | 9/10 | 6.5/10 | SalesMarketing can retrieve from its knowledge base, but Convo has broader documented PDF/DOCX/scanned-document ingestion and reindexing. |
| Operator and admin UX | 9/10 | 8/10 | Convo is a complete support product surface; SalesMarketing has support operations, playbooks, handoffs, analytics, and simulator surfaces. |
| Observability and audit | 8/10 | 8/10 | Both provide analytics/audit; SalesMarketing adds delivery uncertainty and channel-level operational evidence. |
| Extensibility | 8/10 | 8/10 | Convo favors generic integrations; SalesMarketing favors application-native specialist tools. |

## Scope and evidence

- The Convo AI inventory is based on the prior source/schema/API/admin review recorded in [CONVO_AI_SUPPORT_ARCHITECTURE.md](./CONVO_AI_SUPPORT_ARCHITECTURE.md). The original Convo AI folder is not part of this checkout, so “not evidenced” means the reviewed material did not establish the capability; it does not prove that a private deployment cannot have it.
- The SalesMarketing assessment is based on the current TypeScript services, routes, support UI, migrations, tests, and the canonical pipeline in [`ChannelGateway.ts`](../server/services/agents/pipeline/ChannelGateway.ts).
- “Implemented” means an implementation path is present. Provider credentials, production secrets, live-provider behavior, and operational configuration still require staging verification.

Status key: **Full** = directly evidenced; **Partial** = present but narrower or split across surfaces; **Gap** = not evidenced or materially missing.

## 1. Feature inventory comparison

| Capability | Convo AI | SalesMarketing support assistant | Gap and implication |
|---|---|---|---|
| Tenant isolation and configuration | **Full**: tenant-scoped conversations, knowledge, playbooks, integrations, analytics, retention, API keys, branding, and roles. | **Partial/Full**: user-scoped AI configuration, support teams/members, module access, channel-scoped agent settings, and database ownership checks. | Convo is a more complete standalone multi-tenant product boundary; SalesMarketing is integrated into the wider application account model. |
| Authentication and operator roles | **Full**: Clerk, team membership, roles, superadmin controls. | **Full**: authenticated support members, teams, owner/admin controls, member assignment and ticket ownership. | Comparable for support operations; Convo's standalone tenant administration is more explicit. |
| Customer channels | **Full/Partial**: web widget, HTTP/SSE, WebSocket, SDK patterns, and documented integration abstractions. | **Full**: WhatsApp, Instagram, Facebook, threaded email, and web-widget paths normalize into the gateway. | SalesMarketing has the stronger provider-specific production path; Convo has the stronger reusable widget/SDK product pattern. |
| Provider webhook normalization | **Partial**: channel abstractions are documented, with the strongest complete path around the widget. | **Full**: inbound provider events are normalized before the canonical pipeline; provider IDs are used for idempotency. | SalesMarketing is more operationally channel-aware. |
| Conversation history and ownership | **Full**: sessions, messages, queue state, takeover, assignment, resolution. | **Full**: conversation mode, handoff queue, assigned member/team, ticket history, and human-owned suppression of AI. | Both handle ownership correctly when the canonical path is used. |
| Intent and risk classification | **Full**: deterministic intent classification plus confidence and escalation categories. | **Full**: NLU intent/risk classification, recent-message context, confidence seeding, and fail-closed handoff on classifier failure. | SalesMarketing's classification is tightly coupled to specialist routing and domain actions. |
| Knowledge base and RAG | **Full**: chunking, embeddings, pgvector retrieval, full-text/ILIKE fallbacks, top-K and confidence controls. | **Partial/Full**: semantic and condensed-summary retrieval are available to the gateway and internal copilot. | Convo has broader ingestion/reindexing productization; SalesMarketing needs ingestion parity for scanned/PDF/DOCX-heavy customers. |
| Document ingestion and OCR | **Full**: PDF, scanned PDF, DOCX, URL, text, OCR/file fallback, chunking, reindexing, ingestion status. | **Gap/Partial**: existing knowledge services are used for retrieval, but Convo's documented OCR and ingestion workflow is not fully replicated. | Port this only if support customers depend on scanned manuals or uploaded documents. |
| Model and prompt configuration | **Full**: model, temperature, token limit, system prompt, fallback, confidence threshold, blocked topics, tools. | **Full**: per-agent/channel configuration, provider factory, prompts, confidence thresholds, escalation rules, tool enablement, and dry-run behavior. | Comparable; SalesMarketing adds specialist-specific behavior. |
| Playbook graph | **Full**: trigger/message/question/condition/escalation/action nodes and directed progression. | **Full**: versioned graph nodes/edges, assignments, priorities, traffic variants, traversal, conditions, and required actions. | Convo's generic authoring experience is more mature; SalesMarketing's playbooks are now enforced in the same delivery pipeline. |
| Playbook authoring and lifecycle | **Full**: visual editor, draft/active/archive, test/simulator, deterministic A/B allocation. | **Full**: React Flow editor, graph JSON mode, draft/publish/archive, immutable published snapshots, assignments, traffic split, validation. | Feature parity is close; Convo remains the reference for generic UX polish. |
| Playbook compliance | **Partial/Full**: required content/action directives and escalation paths. | **Full**: required-content overlap scoring and required successful tool-action checks can block delivery into approval. | SalesMarketing has an explicit outbound compliance gate. |
| Tool orchestration | **Full**: registered tools, up to three tool rounds, integration-specific actions. | **Full**: registered safe executor, exact names, filtered arguments, idempotency, read/write/risk policy, owner/playbook authorization, redacted results, approvals. | SalesMarketing is more conservative for domain side effects; Convo is broader as a generic integration concept. |
| Generic integrations | **Full/Partial**: HubSpot, Zendesk, Shopify, custom webhooks, encrypted credentials, connection tests. | **Partial**: native CRM, ticket, booking, payment, lead, reminder, and sequence services; no equivalent generic integration marketplace is evidenced. | SalesMarketing should add a connector registry only when customers need third-party systems beyond native services. |
| PII redaction | **Full**: pre-model email, phone, card, SSN/national IDs, contextual names, stable tokens. | **Full**: stable tokens before classifier/RAG/model/audit; restricted AES-256-GCM privacy vault, tenant-derived keys, retention and access logging. | SalesMarketing provides stronger linkage to restricted storage and member-only reveal. |
| PII reveal | **Partial/Full**: privacy-aware support workflow is documented. | **Full**: assigned active member only, 60-second UI reveal, append-only access log, no raw PII in ordinary metadata. | SalesMarketing has a more explicit operational access boundary. |
| Content moderation | **Full**: moderation API, moderation log, configurable outage behavior, safety escalation. | **Full/Partial**: deterministic inbound safety checks, optional moderation API, outbound guardrails, and configurable fail-closed behavior. | Comparable; production moderation credentials still need deployment verification in both systems. |
| Prompt-injection and policy controls | **Full**: blocked topics, confidence, response checks, fallback/handoff. | **Full**: inbound/outbound guardrails, channel/intent rules, operating hours, prohibited topics, response length, disclaimers, block/escalate actions. | SalesMarketing has more explicit channel and business-policy coupling. |
| Opt-out and unsubscribe | **Partial/Full**: automation rules and handoff controls are present. | **Full**: exact opt-out recognized before classification/generation, conversation is marked unsubscribed, confirmation is deterministic, simulator does not mutate state. | SalesMarketing has the clearer channel-agnostic opt-out path. |
| Human handoff | **Full**: explicit request, low confidence, blocked topic, moderation, tool exhaustion, playbook, assignment, takeover, resolution. | **Full**: atomic open queue, team/member/ticket link, claim, human-owned mode, SLA scheduler, history, notification, manual reply/resume. | Both are strong; Convo has a more dedicated support-agent product, SalesMarketing has deeper ticket/CRM integration. |
| Handoff reply assistance | **Full**: AI summary and three suggested replies. | **Full**: assigned-member-only redacted summary, exactly three suggested replies, review-before-send draft flow, canned responses. | Close parity. |
| Delivery safety | **Partial**: channel send and handoff flows are documented. | **Full**: delivery outbox, deterministic claims, provider IDs, sent/failed/uncertain states, no blind retry after ambiguous provider calls. | SalesMarketing is stronger for provider failure correctness. |
| Email threading | **Partial**: email is an integration concept. | **Full**: canonical decision is followed by a threaded email adapter/outbox path, with delivery deferred from the generic gateway. | SalesMarketing is stronger for current email operations. |
| CRM and business side effects | **Partial**: integrations and automation rules can create tickets/contacts/actions. | **Full**: booking, availability, pricing/negotiation, payment links/status, qualification, lead scoring, CRM pipeline, reminders, follow-up sequences, tickets. | This is the largest SalesMarketing advantage. |
| Simulator and dry-run | **Full**: non-streaming simulator with intent, retrieval, confidence, and decision debug. | **Full**: route/privacy/guardrail/policy/playbook/tool/reply/outcome simulation; provider, CRM, handoff, opt-out, vault, and playbook mutations are suppressed. | SalesMarketing's simulator is more explicit about side-effect suppression. |
| Analytics and CSAT | **Full**: daily aggregates, AI resolution, escalation, response time, intent, CSAT, trends. | **Full**: response/latency/outcome, handoffs, delivery, playbook compliance, privacy, tools, knowledge gaps, guardrails, policy events, ticket reviews and CSAT. | Comparable; the metric definitions should be unified before cross-product reporting. |
| Auditability | **Full**: immutable admin audit and before/after configuration history. | **Full**: decision audits, operational reports, before/after admin evidence, append-only database protection for support configuration. | Comparable; retention and export requirements remain deployment concerns. |
| Retention and deletion | **Full**: tenant retention window and scheduled detailed-data deletion. | **Full/Partial**: privacy-vault, webhook telemetry, rate-limit, and approval cleanup jobs; aggregate support records remain governed by application retention. | SalesMarketing should document one customer-visible retention policy across all support tables. |
| Rate limiting | **Full**: tenant/API rate-limit settings. | **Full**: distributed database buckets by tenant/channel/sender, agent overrides, endpoint throttling, dry-run suppression, cleanup. | SalesMarketing is more granular at message ingress. |
| Support-agent workspace | **Full**: queue, agent dashboard, canned responses, notifications, takeover, suggested replies. | **Full**: tickets, teams/members, AI handoffs, support-member copilot, attachments, knowledge base, analytics, profile/settings. | Both have operational surfaces; Convo is more support-centric, SalesMarketing more application-integrated. |
| Internal support copilot | **Partial**: agent dashboard and suggested replies. | **Full**: [`SupportChatService.ts`](../server/services/SupportChatService.ts) stores protected member prompts, retrieves KB context, applies inbound/outbound guardrails, and returns draft assistance without directly sending to customers. | SalesMarketing clearly separates copilot advice from customer delivery. |
| Multimodal/voice support | **Gap/not evidenced** in the reviewed Convo inventory. | **Gap/not evidenced** in the reviewed support gateway. | Treat as a shared roadmap item, not a migration blocker. |
| Evaluation and regression testing | **Partial**: simulator and analytics. | **Partial**: simulator plus focused pipeline tests. | Neither has a full golden-conversation evaluation suite, provider replay corpus, or automated quality regression dashboard. |

## 2. How each system handles user messages

### Convo AI message path

```text
Widget/API/WebSocket message
  → authenticate tenant and session
  → normalize conversation and history
  → redact PII and run moderation
  → classify intent and confidence
  → retrieve tenant knowledge
  → resolve active playbook/node
  → run model and permitted tool rounds
  → validate response, blocked topics, confidence, and required playbook content
  → deliver response or create/notify a human handoff
  → record conversation, CSAT, analytics, moderation, and audit evidence
```

Convo AI is designed around a generic support turn. It can answer a grounded question, advance a playbook, call an integration, or stop for a human. Its strongest behavior is controlled self-service: the turn is not treated as “just call the model”; it is a sequence of tenant, privacy, knowledge, policy, playbook, tool, and handoff decisions.

### SalesMarketing customer-message path

The canonical implementation is the `ChannelGateway` pipeline:

```text
Provider webhook/widget
  → normalize channel, tenant, sender, conversation, and provider message ID
  → verify conversation mode and active human ownership
  → redact PII and protect raw content in the restricted vault
  → exact opt-out check
  → load channel-scoped AI configuration
  → distributed rate limit
  → inbound safety/guardrail check
  → sentiment and intent/risk classification with recent-message context
  → AI-handle gate
  → playbook resolution and escalation
  → pre-generation policy and operating-hours checks
  → knowledge retrieval
  → specialist dispatch and safe tool execution
  → outbound guardrails, playbook compliance, and confidence gate
  → delivery outbox/provider adapter or approval/handoff
  → CRM/ticket/reminder side effects
  → audit and analytics
```

The five primary specialists are Hotel Sales, Technical Support, Lead Qualifier, Customer Success, and General Service. They compose knowledge, booking, negotiation, payment, complaint, ticket, escalation, and qualification sub-agents. A normal hotel or support question can therefore produce an application action, not only a text answer.

### SalesMarketing internal support-member message path

The support portal's AI chat is a separate copilot surface, not another customer delivery path:

```text
Authenticated support member
  → verify session ownership
  → redact and persist member prompt
  → load recent protected chat history
  → retrieve knowledge-base context and optional protected ticket context
  → call configured LLM
  → run inbound and outbound guardrails
  → return answer, confidence, and source documents
```

It helps a member diagnose a ticket or draft a response. It does not directly send the answer to WhatsApp, Instagram, Facebook, or email; the member must review and use the normal support delivery workflow.

## 3. Message-handling correctness by scenario

| Scenario | Convo AI behavior | SalesMarketing behavior | Assessment |
|---|---|---|---|
| Grounded FAQ | Retrieve tenant knowledge, generate, validate, answer or hand off on low confidence. | Retrieve support knowledge, route to specialist, score confidence, deliver through the channel outbox. | Both are correct; SalesMarketing adds channel/provider correctness. |
| Booking or availability | Requires a configured integration/tool. | Hotel Sales can check availability, save details, create booking, quote/negotiate, and initiate payment workflows. | SalesMarketing is materially stronger. |
| Customer includes phone/email/card data | Redact before model and retain restricted data under retention controls. | Redact before classifier/RAG/model/audit; protect raw text in vault; restrict reveal to assigned member. | Both protect the model; SalesMarketing has a more explicit vault/reveal workflow. |
| Explicit human request | Stop automation and enqueue/notify an agent. | NLU `needsHuman` or critical risk halts the pipeline, creates one handoff, changes ownership, and suppresses future AI. | Both are correct; SalesMarketing's ownership suppression is explicit in the gateway. |
| Human already owns conversation | Do not generate another AI answer. | `ConversationModeStage` checks open handoff/mode and returns `no_op`, updating last-customer-message metadata. | Both prevent AI/human collisions. |
| Low confidence | Use fallback or handoff according to tenant threshold. | Composite confidence gate sends medium confidence to approval and low confidence to handoff. | SalesMarketing gives operators an intermediate approval state. |
| Harmful or unsafe content | Moderation/guardrail decision, usually handoff or block. | Deterministic inbound guardrail and optional moderation halt before generation; outcome is audited. | Both fail safely when configured fail-closed. |
| Exact opt-out | Apply automation unsubscribe behavior and confirmation. | Recognize `stop`, `unsubscribe`, `opt out`, and equivalent exact phrases before NLU; persist unsubscribe and send deterministic confirmation. | SalesMarketing has the clearer deterministic implementation. |
| Tool/action request | Use registered integration tool; escalate if tool is unavailable or exhausted. | Safe executor checks registered name, filtered args, enablement, risk, owner/playbook authority, idempotency, and approval; unsafe requests never reach delivery. | SalesMarketing is stricter for high-risk side effects. |
| Duplicate webhook | Session/message idempotency prevents duplicate processing where provider IDs are available. | Delivery outbox claims by tenant/conversation/inbound provider ID/response version/part; duplicate claims return existing action. | SalesMarketing has stronger explicit delivery evidence. |
| Provider timeout after send may have happened | Handoff/retry behavior depends on integration implementation. | Mark delivery `uncertain` and suppress blind retry; operator must reconcile sent/not-sent with a note. | SalesMarketing is safer for ambiguous provider outcomes. |
| Email reply | Use email integration/threading. | Generic gateway defers email delivery to the threaded email adapter/outbox, avoiding a phantom sent record or duplicate thread. | SalesMarketing is more explicit today. |
| Simulator request | Return intent, retrieval, confidence, and decision details without customer delivery. | Simulate all gates and proposed tools while suppressing provider, CRM, handoff, opt-out, vault, and playbook mutations. | Both are safe; SalesMarketing documents more side-effect suppression. |
| Internal support member asks for advice | Agent dashboard can assist and suggest replies. | Member prompt/history/ticket context is protected, grounded, guardrailed, sourced, and returned as a draft only. | SalesMarketing has the cleaner separation between advice and customer send. |

## 4. Default SalesMarketing support playbook catalog

The application provisions the following immutable version-1 starters on the first playbook or agent-configuration load. Provisioning is idempotent: existing custom/default records are not renamed, republished, re-enabled, or overwritten.

| Published starter | Assigned agent | Exact classifier intents | Main behavior |
|---|---|---|---|
| Hotel Availability & Booking | Hotel Sales | `availability_inquiry`, `pricing_question`, `booking_request` | Collect missing stay details, verify inventory/rates, distinguish availability from confirmation, and move booking/payment to an authorized workflow. |
| Hotel Reservation & Payment Safety | Hotel Sales | `negotiation`, `modify_booking`, `payment_inquiry` | Use a safe booking reference, never collect card/OTP/CVV credentials, and avoid unconfirmed price/payment/change promises. |
| Technical Troubleshooting | Technical Support | `support_request` | Gather non-sensitive diagnostics, provide grounded steps, confirm resolution, then create a ticket or hand off when unresolved. |
| Support Ticket Status | Technical Support | `ticket_status` | Verify a ticket reference and return only authorized status/history for that customer. |
| Lead Qualification | Lead Qualifier | `lead_qualification`, `sales_inquiry`, `purchase_intent` | Collect minimal business-fit facts, avoid sensitive/protected attributes, qualify transparently, and request follow-up consent. |
| Demo & Sales Handoff | Lead Qualifier | `demo_request` | Gather use case and scheduling preferences, then create a redacted human sales handoff without promising a slot. |
| Complaint & Service Recovery | Customer Success | `complaint` | Acknowledge the concern, collect minimal facts, apply verified policy, and avoid unapproved compensation or liability statements. |
| Refund & Cancellation Review | Customer Success | `refund_request`, `cancel_booking` | Collect a safe reference and reason, prohibit financial secrets, and send the decision to an authorized human. |
| Grounded FAQ | General Service | `greeting`, `faq`, `smalltalk` | Answer from verified knowledge and hand off when the answer is missing or uncertain. |
| Safe Request Triage | General Service | `clarify`, `other` | Ask one minimal clarification and route to the correct specialist without collecting unnecessary PII. |

Every starter reports **Privacy enforced**, **PII redaction enforced**, **Safety enforced**, **Human handoff enabled**, and **Tool approval required**. The same mandatory safety rules are merged into existing agent configurations without changing custom prompts, tools, channel scopes, activation status, or non-system rules.

Assignments receive traffic only when their exact agent is active and enabled for the inbound channel. General Service remains the only automatically enabled starter agent; specialist activation is deliberately owner-controlled and its active/inactive state is visible beside each assignment.

### Admin-managed inheritance

The starter playbook catalog and the five agent profiles are stored as platform-wide admin templates. Agent templates cover prompts, tools, channels, escalation rules, control metadata, and routing priority. Each tenant receives materialized copies with one of three inheritance states:

- `managed`: admin edits increment the template version and propagate the graph, policy steps, routing assignments, and control metadata to the tenant.
- `customized`: the tenant edited a managed playbook or its assignments; future admin edits do not overwrite that tenant.
- `custom`: the tenant created the playbook and it has no admin source.

A client can reset a customized playbook to the current admin version. Resetting replaces only that tenant's graph and assignments and returns it to `managed`. Existing in-flight runs continue using their immutable playbook version, while new conversations use the newly published version.

Admin editors are available at `/admin/dashboard/support-playbooks` and `/admin/dashboard/support-agents`. Tenant owners edit account copies at `/dashboard/settings/outreach/playbooks` and the relevant outreach agent page; each outreach agent page also shows the policies and playbooks assigned to that specialist.

## 5. What SalesMarketing is missing or less mature than Convo AI

These are the meaningful gaps to close if SalesMarketing wants Convo AI-level generic support capability:

1. **Document ingestion parity.** Add first-class PDF/DOCX/URL upload status, scanned-PDF OCR fallback, chunk replacement, reindexing, and ingestion diagnostics to the support-facing knowledge workflow.
2. **Embeddable widget and SDK productization.** The gateway supports web, but a polished tenant-configurable widget/React/mobile SDK experience comparable to Convo's standalone surface is not evidenced.
3. **Generic connector registry.** Native CRM, ticket, booking, payment, and lead services are strong, but a tenant-managed registry for HubSpot/Zendesk/Shopify/custom webhooks with encrypted credentials and connection tests would improve portability.
4. **Single retention and data-rights contract.** Vault and telemetry cleanup exist, but support conversations, attachments, tickets, audits, and analytics should share a documented customer-facing retention/erasure policy and, where required, DSAR/export workflows.
5. **Golden-conversation evaluation.** Add replayable fixtures for every channel and specialist, expected intent/tool/handoff/delivery outcomes, prompt/model version tracking, and a regression dashboard.
6. **Cross-channel identity resolution.** The current pipeline is channel-aware; a verified identity graph that safely joins a WhatsApp sender, Instagram/Facebook identity, email, lead, and ticket is not evidenced.
7. **More generic support configuration UX.** The current UI covers playbooks, handoffs, orchestration, and support operations; Convo's tenant-wide widget branding, notification, API-key, integration, and retention settings should be consolidated if standalone support customers are a target market.

## 6. What Convo AI is missing or less mature than SalesMarketing

These are the capabilities a standalone Convo deployment would need to reproduce before replacing the SalesMarketing support assistant:

1. **Hotel domain execution:** availability, room facts, pricing floors, negotiation, booking capture, booking creation, payment methods, payment links, and payment status.
2. **Lead and CRM lifecycle:** qualification scoring, lead status/pipeline transitions, CRM contact creation/update, alerts, reminders, follow-up sequences, and sales-stage automation.
3. **Application-native ticket and support records:** the SalesMarketing support teams, members, ticket model, attachments, reviews, and existing lead/conversation relationships would need migration and reconciliation.
4. **Provider-specific omnichannel delivery:** WhatsApp phone-number context and templates, Instagram DM/comment behavior, Facebook Messenger, Gmail/Resend threading, and provider-specific webhook idempotency.
5. **Delivery uncertainty controls:** provider-call state, outbox claims, sent/failed/uncertain outcomes, reconciliation UI, and no-blind-retry behavior need to be implemented for every channel.
6. **Specialist routing architecture:** the five SalesMarketing specialists and eight domain sub-agent/tool families would need to be reimplemented or exposed through a safe remote-tool boundary.
7. **Application event side effects:** lead score changes, CRM pipeline changes, alerts, reminders, sequence enrollment, booking events, and ticket updates need transactional ownership and observability.
8. **Internal copilot separation:** Convo's agent dashboard is not automatically equivalent to a protected support-member copilot that is grounded in SalesMarketing ticket/lead context and cannot directly send a customer reply.

## 7. Shared gaps that neither system should claim as complete

The reviewed material does not establish full production parity for the following:

- **Voice and audio support**, including transcription, voice consent, and channel-specific media delivery.
- **Rich multimodal customer turns**, such as image/document understanding with malware scanning, OCR, and safe retention.
- **Cross-channel identity merge** with explicit consent and collision handling.
- **Automated quality evaluation** against a golden corpus with model/prompt/playbook version comparisons.
- **Formal policy simulation and approvals** for every tenant configuration change before publication.
- **Data residency, legal hold, DSAR export/deletion, and region-specific retention guarantees.**
- **Universal provider replay testing** that can reproduce webhook order, duplicate events, retries, rate limits, and partial outages.
- **Cost and latency budgets per tenant/conversation**, including model fallback policy and token attribution.
- **Multilingual quality measurement**, language-specific playbooks, and translated handoff summaries.

These should be tracked as roadmap or launch-gate items rather than silently treated as inherited from either product.

## 8. Recommended target architecture

Keep one mandatory support decision path and make every channel adapter call it:

```text
WhatsApp / Instagram / Facebook / Email / Web
  → provider authentication and event idempotency
  → normalized message envelope
  → conversation ownership and opt-out
  → PII vault/redaction
  → rate limit and inbound safety
  → intent/risk and channel-scoped configuration
  → versioned playbook
  → grounded retrieval
  → specialist agent + safe tool executor
  → outbound guardrail and playbook compliance
  → confidence/approval/handoff decision
  → durable delivery outbox
  → CRM/ticket side effects
  → audit, analytics, CSAT, and retention jobs
```

Implementation priorities:

1. Make the canonical gateway the only customer-reply path and monitor for legacy bypasses.
2. Keep high-risk tool auto-approval disabled until approval, idempotency, and reconciliation metrics are stable.
3. Finish ingestion parity and cross-channel identity only if support customers require them; do not replace the proven domain agents to obtain them.
4. Add golden-conversation replay tests before enabling each provider/channel in production.
5. Define one retention/data-rights policy covering raw vault content, redacted messages, attachments, tickets, audits, and analytics.

## Conclusion

Convo AI provides the stronger generic support product blueprint. SalesMarketing provides the stronger business-operating assistant for this application. Their message-handling models are compatible: Convo's productized privacy/playbook/handoff ideas belong around SalesMarketing's existing specialist and delivery logic, not inside each individual agent.

The current shared-gateway architecture is the recommended integration boundary. It preserves the domain actions that make SalesMarketing valuable while giving every WhatsApp, Instagram, Facebook, email, and web turn one consistent privacy, policy, playbook, handoff, delivery, and audit path.
